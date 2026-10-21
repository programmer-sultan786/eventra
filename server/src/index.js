import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import QRCode from 'qrcode';
import mysql from 'mysql2/promise';
import crypto from 'node:crypto';

const app = express();
app.use(cors({ origin: process.env.CLIENT_URL || 'http://localhost:5173' }));
app.use(express.json());
const pool = mysql.createPool({ host: process.env.DB_HOST, port: Number(process.env.DB_PORT || 3306), user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME, waitForConnections: true, connectionLimit: 10 });
const jwtSecret = process.env.JWT_SECRET || 'local-eventra-secret';
const tokenFor = (user) => jwt.sign({ id: user.id, role: user.role, name: user.name }, jwtSecret, { expiresIn: '2d' });
const auth = (req, res, next) => { const token = (req.headers.authorization || '').replace('Bearer ', ''); try { req.user = jwt.verify(token, jwtSecret); next(); } catch { res.status(401).json({ message: 'Please log in to continue.' }); } };
const admin = (req, res, next) => req.user?.role === 'admin' ? next() : res.status(403).json({ message: 'Administrator access required.' });
const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const loginAttempts = new Map();
const loginGuard = (req, res, next) => {
  const key = `${req.ip}:${String(req.body.email || '').toLowerCase()}`;
  const attempt = loginAttempts.get(key);
  if (attempt?.count >= 5 && attempt.until > Date.now()) return res.status(429).json({ message: 'Too many login attempts. Try again in a minute.' });
  if (attempt?.until <= Date.now()) loginAttempts.delete(key);
  next();
};
const releaseExpiredBookings = async () => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [expired] = await conn.query(`SELECT id,ticket_type_id,quantity FROM bookings
      WHERE status='pending' AND created_at < DATE_SUB(NOW(), INTERVAL 15 MINUTE) FOR UPDATE`);
    for (const booking of expired) {
      const [[seatBooking]] = await conn.query('SELECT COUNT(*) count FROM booking_seats WHERE booking_id=?', [booking.id]);
      if (seatBooking.count > 0) await conn.query('UPDATE event_seats es JOIN booking_seats bs ON bs.seat_id=es.id SET es.status="available" WHERE bs.booking_id=?', [booking.id]);
      else await conn.query('UPDATE ticket_types SET available_quantity=available_quantity+? WHERE id=?', [booking.quantity, booking.ticket_type_id]);
      await conn.query('UPDATE bookings SET status="cancelled" WHERE id=?', [booking.id]);
    }
    await conn.commit();
  } catch (error) { await conn.rollback(); console.error('Expired booking cleanup failed:', error.message); } finally { conn.release(); }
};
setInterval(() => releaseExpiredBookings().catch(error => console.error('Expired booking cleanup failed:', error.message)), 5 * 60 * 1000);

app.get('/api/health', asyncRoute(async (_req, res) => { await pool.query('SELECT 1'); res.json({ ok: true }); }));
app.get('/api/categories', asyncRoute(async (_req, res) => { const [rows] = await pool.query('SELECT id, name, slug FROM categories ORDER BY name'); res.json(rows); }));
app.get('/api/events', asyncRoute(async (req, res) => {
  const { search = '', category = '' } = req.query;
  const [rows] = await pool.query(`SELECT e.*, c.name category_name, COALESCE(MIN(t.price), 0) starting_price,
    COALESCE(SUM(t.available_quantity), 0) available_quantity FROM events e JOIN categories c ON c.id=e.category_id
    LEFT JOIN ticket_types t ON t.event_id=e.id WHERE e.status='published' AND e.starts_at >= NOW()
    AND e.name LIKE ? AND (?='' OR c.slug=?) GROUP BY e.id ORDER BY e.starts_at`, [`%${search}%`, category, category]);
  res.json(rows);
}));
app.get('/api/events/:id', asyncRoute(async (req, res) => {
  const [[event]] = await pool.query(`SELECT e.*, c.name category_name, u.name organizer FROM events e JOIN categories c ON c.id=e.category_id JOIN users u ON u.id=e.organizer_id WHERE e.id=? AND e.status='published' AND e.starts_at >= NOW()`, [req.params.id]);
  if (!event) return res.status(404).json({ message: 'Event not found.' });
  const [tickets] = await pool.query('SELECT id, name, price, available_quantity FROM ticket_types WHERE event_id=? ORDER BY price', [req.params.id]);
  const [seats] = await pool.query(`SELECT id,seat_label,seat_row,seat_number,status FROM event_seats
    WHERE event_id=? ORDER BY seat_row,seat_number`, [req.params.id]);
  res.json({ ...event, tickets, seats });
}));
app.post('/api/auth/register', asyncRoute(async (req, res) => {
  const { name, email, password } = req.body;
  if (!name?.trim() || !/^\S+@\S+\.\S+$/.test(email || '') || !password || password.length < 6) return res.status(400).json({ message: 'Enter a name, valid email, and password of at least 6 characters.' });
  const hash = await bcrypt.hash(password, 10);
  try { const [result] = await pool.query('INSERT INTO users (name,email,password_hash,role) VALUES (?,?,?,"customer")', [name.trim(), email.toLowerCase(), hash]); const user = { id: result.insertId, name: name.trim(), role: 'customer' }; res.status(201).json({ user, token: tokenFor(user) }); } catch (e) { if (e.code === 'ER_DUP_ENTRY') return res.status(409).json({ message: 'An account with that email already exists.' }); throw e; }
}));
app.post('/api/auth/login', loginGuard, asyncRoute(async (req, res) => {
  const [[user]] = await pool.query('SELECT id,name,email,password_hash,role FROM users WHERE email=?', [String(req.body.email || '').toLowerCase()]);
  const key = `${req.ip}:${String(req.body.email || '').toLowerCase()}`;
  if (!user || !(await bcrypt.compare(req.body.password || '', user.password_hash))) {
    const previous = loginAttempts.get(key); const count = (previous?.count || 0) + 1;
    loginAttempts.set(key, count >= 5 ? { count, until: Date.now() + 60_000 } : { count, until: Date.now() + 60_000 });
    return res.status(401).json({ message: 'Invalid email or password.' });
  }
  loginAttempts.delete(key);
  const safe = { id: user.id, name: user.name, email: user.email, role: user.role }; res.json({ user: safe, token: tokenFor(safe) });
}));
app.get('/api/me', auth, asyncRoute(async (req, res) => { const [[user]] = await pool.query('SELECT id,name,email,role FROM users WHERE id=?', [req.user.id]); res.json(user); }));
app.get('/api/bookings', auth, asyncRoute(async (req, res) => { const [rows] = await pool.query(`SELECT b.*, e.name event_name,e.starts_at,e.venue,tt.name ticket_name,ticket.ticket_code,GROUP_CONCAT(es.seat_label ORDER BY es.seat_row,es.seat_number) seat_labels FROM bookings b JOIN events e ON e.id=b.event_id JOIN ticket_types tt ON tt.id=b.ticket_type_id LEFT JOIN tickets ticket ON ticket.booking_id=b.id LEFT JOIN booking_seats bs ON bs.booking_id=b.id LEFT JOIN event_seats es ON es.id=bs.seat_id WHERE b.user_id=? GROUP BY b.id ORDER BY b.created_at DESC`, [req.user.id]); res.json(rows); }));
app.post('/api/bookings', auth, asyncRoute(async (req, res) => {
  await releaseExpiredBookings();
  const eventId = Number(req.body.eventId); const ticketTypeId = Number(req.body.ticketTypeId); const requestedSeats = Array.isArray(req.body.seatIds) ? req.body.seatIds.map(Number) : []; const qty = requestedSeats.length || Number(req.body.quantity);
  if (!Number.isInteger(eventId) || !Number.isInteger(ticketTypeId)) return res.status(400).json({ message: 'A valid event and ticket type are required.' });
  if (!Number.isInteger(qty) || qty < 1 || qty > 10) return res.status(400).json({ message: 'Quantity must be between 1 and 10.' });
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[ticket]] = await conn.query(`SELECT t.id,t.event_id,t.price,t.available_quantity
      FROM ticket_types t JOIN events e ON e.id=t.event_id
      WHERE t.id=? AND t.event_id=? AND e.status='published' AND e.starts_at >= NOW() FOR UPDATE`, [ticketTypeId, eventId]);
    if (!ticket) { await conn.rollback(); return res.status(400).json({ message: 'This event is no longer available for booking.' }); }
    const [[seatCount]] = await conn.query('SELECT COUNT(*) count FROM event_seats WHERE event_id=?', [eventId]);
    if (seatCount.count > 0 && (requestedSeats.length < 1 || requestedSeats.length > 10 || requestedSeats.length !== qty)) { await conn.rollback(); return res.status(400).json({ message: 'Select between 1 and 10 seats.' }); }
    if (seatCount.count > 0) {
      const [seats] = await conn.query('SELECT id FROM event_seats WHERE event_id=? AND id IN (?) AND status="available" FOR UPDATE', [eventId, requestedSeats]);
      if (seats.length !== requestedSeats.length || new Set(requestedSeats).size !== requestedSeats.length) { await conn.rollback(); return res.status(409).json({ message: 'One or more selected seats are no longer available.' }); }
    } else if (ticket.available_quantity < qty) { await conn.rollback(); return res.status(400).json({ message: 'Not enough tickets available.' }); }
    const total = Number(ticket.price) * qty; const reference = `EVT-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
    const [result] = await conn.query('INSERT INTO bookings (reference,user_id,event_id,ticket_type_id,quantity,total_amount,status) VALUES (?,?,?,?,?,?,"pending")', [reference, req.user.id, eventId, ticket.id, qty, total]);
    if (seatCount.count > 0) { await conn.query('UPDATE event_seats SET status="held" WHERE id IN (?)', [requestedSeats]); await conn.query('INSERT INTO booking_seats (booking_id,seat_id) SELECT ?, id FROM event_seats WHERE id IN (?)', [result.insertId, requestedSeats]); }
    else await conn.query('UPDATE ticket_types SET available_quantity=available_quantity-? WHERE id=?', [qty, ticket.id]);
    await conn.commit(); res.status(201).json({ id: result.insertId, reference, total });
  } catch (e) { await conn.rollback(); throw e; } finally { conn.release(); }
}));
app.post('/api/bookings/:id/payment', auth, asyncRoute(async (req, res) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction(); const [[booking]] = await conn.query('SELECT * FROM bookings WHERE id=? AND user_id=? FOR UPDATE', [req.params.id, req.user.id]);
    if (!booking) return res.status(404).json({ message: 'Booking not found.' });
    if (booking.status !== 'pending') return res.status(409).json({ message: `This booking is already ${booking.status}.` });
    const outcome = ['success', 'failed', 'cancelled'].includes(req.body.outcome) ? req.body.outcome : 'failed';
    await conn.query('INSERT INTO payments (booking_id,outcome,amount) VALUES (?,?,?)', [booking.id, outcome, booking.total_amount]);
    if (outcome === 'success') {
      const code = `TKT-${crypto.randomBytes(6).toString('hex').toUpperCase()}`; await conn.query('UPDATE bookings SET status="confirmed" WHERE id=?', [booking.id]); await conn.query('UPDATE event_seats es JOIN booking_seats bs ON bs.seat_id=es.id SET es.status="sold" WHERE bs.booking_id=?', [booking.id]); await conn.query('INSERT INTO tickets (booking_id,ticket_code) VALUES (?,?)', [booking.id, code]);
    } else { await conn.query('UPDATE bookings SET status=? WHERE id=?', [outcome, booking.id]); const [[seatBooking]] = await conn.query('SELECT COUNT(*) count FROM booking_seats WHERE booking_id=?', [booking.id]); if (seatBooking.count > 0) await conn.query('UPDATE event_seats es JOIN booking_seats bs ON bs.seat_id=es.id SET es.status="available" WHERE bs.booking_id=?', [booking.id]); else await conn.query('UPDATE ticket_types SET available_quantity=available_quantity+? WHERE id=?', [booking.quantity, booking.ticket_type_id]); }
    await conn.commit(); res.json({ status: outcome === 'success' ? 'confirmed' : outcome });
  } catch (e) { await conn.rollback(); throw e; } finally { conn.release(); }
}));
app.post('/api/bookings/:id/cancel', auth, asyncRoute(async (req, res) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[booking]] = await conn.query(`SELECT b.*,e.starts_at FROM bookings b JOIN events e ON e.id=b.event_id
      WHERE b.id=? AND b.user_id=? FOR UPDATE`, [req.params.id, req.user.id]);
    if (!booking) { await conn.rollback(); return res.status(404).json({ message: 'Booking not found.' }); }
    if (booking.status !== 'pending' && booking.status !== 'confirmed') { await conn.rollback(); return res.status(409).json({ message: `This booking is already ${booking.status}.` }); }
    if (new Date(booking.starts_at) <= new Date()) { await conn.rollback(); return res.status(400).json({ message: 'Past events cannot be cancelled.' }); }
    const [[seatBooking]] = await conn.query('SELECT COUNT(*) count FROM booking_seats WHERE booking_id=?', [booking.id]);
    if (seatBooking.count > 0) await conn.query('UPDATE event_seats es JOIN booking_seats bs ON bs.seat_id=es.id SET es.status="available" WHERE bs.booking_id=?', [booking.id]);
    else await conn.query('UPDATE ticket_types SET available_quantity=available_quantity+? WHERE id=?', [booking.quantity, booking.ticket_type_id]);
    await conn.query('UPDATE bookings SET status="cancelled" WHERE id=?', [booking.id]);
    await conn.query('DELETE FROM tickets WHERE booking_id=?', [booking.id]);
    await conn.commit(); res.json({ status: 'cancelled' });
  } catch (error) { await conn.rollback(); throw error; } finally { conn.release(); }
}));
app.get('/api/tickets/:code/verify', asyncRoute(async (req, res) => { const [[ticket]] = await pool.query(`SELECT ticket.ticket_code,e.name event_name,e.starts_at,e.venue,b.reference,b.status FROM tickets ticket JOIN bookings b ON b.id=ticket.booking_id JOIN events e ON e.id=b.event_id WHERE ticket.ticket_code=? AND b.status='confirmed'`, [req.params.code]); res.json({ valid: Boolean(ticket), ticket: ticket || null }); }));
app.post('/api/admin/categories', auth, admin, asyncRoute(async (req, res) => { const name = String(req.body.name || '').trim(); const slug = String(req.body.slug || name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')); if (!name || !slug) return res.status(400).json({ message: 'Category name is required.' }); try { const [result] = await pool.query('INSERT INTO categories (name,slug) VALUES (?,?)', [name, slug]); res.status(201).json({ id: result.insertId, name, slug }); } catch (e) { if (e.code === 'ER_DUP_ENTRY') return res.status(409).json({ message: 'That category already exists.' }); throw e; } }));
app.get('/api/admin/stats', auth, admin, asyncRoute(async (_req, res) => { const [[stats]] = await pool.query(`SELECT (SELECT COUNT(*) FROM events) events,(SELECT COUNT(*) FROM users) users,(SELECT COUNT(*) FROM bookings) bookings,(SELECT COALESCE(SUM(amount),0) FROM payments WHERE outcome='success') revenue`); res.json(stats); }));
app.get('/api/admin/bookings', auth, admin, asyncRoute(async (_req, res) => { const [rows] = await pool.query(`SELECT b.reference,b.status,b.total_amount,u.name user_name,e.name event_name,b.created_at FROM bookings b JOIN users u ON u.id=b.user_id JOIN events e ON e.id=b.event_id ORDER BY b.created_at DESC`); res.json(rows); }));
app.get('/api/admin/events', auth, admin, asyncRoute(async (_req, res) => { const [rows] = await pool.query(`SELECT e.id,e.name,e.starts_at,e.venue,e.status,c.name category_name,COALESCE(SUM(t.available_quantity),0) available_quantity FROM events e JOIN categories c ON c.id=e.category_id LEFT JOIN ticket_types t ON t.event_id=e.id GROUP BY e.id ORDER BY e.starts_at DESC`); res.json(rows); }));
app.get('/api/admin/events/:id', auth, admin, asyncRoute(async (req, res) => {
  const eventId = Number(req.params.id);
  const [[event]] = await pool.query(`SELECT e.id,e.name,e.description,e.category_id,e.starts_at,e.venue,e.image_url,e.status,c.name category_name
    FROM events e JOIN categories c ON c.id=e.category_id WHERE e.id=?`, [eventId]);
  if (!event) return res.status(404).json({ message: 'Event not found.' });
  const [tickets] = await pool.query('SELECT id,name,price,available_quantity FROM ticket_types WHERE event_id=? ORDER BY price,id', [eventId]);
  const [[seatMap]] = await pool.query('SELECT COUNT(*) seat_count,MAX(seat_row) seat_rows,MAX(seat_number) seat_columns FROM event_seats WHERE event_id=?', [eventId]);
  res.json({ ...event, tickets, seatMap: { rows: seatMap.seat_count ? seatMap.seat_rows : 0, columns: seatMap.seat_count ? seatMap.seat_columns : 0, count: seatMap.seat_count } });
}));
app.get('/api/admin/events/:id/bookings', auth, admin, asyncRoute(async (req, res) => {
  const eventId = Number(req.params.id);
  const [rows] = await pool.query(`SELECT b.reference,b.status,b.quantity,b.total_amount,b.created_at,u.name user_name,u.email,
    tt.name ticket_name,GROUP_CONCAT(es.seat_label ORDER BY es.seat_row,es.seat_number) seat_labels
    FROM bookings b JOIN users u ON u.id=b.user_id JOIN ticket_types tt ON tt.id=b.ticket_type_id
    LEFT JOIN booking_seats bs ON bs.booking_id=b.id LEFT JOIN event_seats es ON es.id=bs.seat_id
    WHERE b.event_id=? GROUP BY b.id ORDER BY b.created_at DESC`, [eventId]);
  res.json(rows);
}));
app.get('/api/admin/tickets', auth, admin, asyncRoute(async (_req, res) => { const [rows] = await pool.query(`SELECT t.id,t.event_id,t.name,t.price,t.available_quantity,e.name event_name,COUNT(b.id) bookings FROM ticket_types t JOIN events e ON e.id=t.event_id LEFT JOIN bookings b ON b.ticket_type_id=t.id GROUP BY t.id ORDER BY e.starts_at DESC,t.price`); res.json(rows); }));
app.post('/api/admin/events/:id/seats/generate', auth, admin, asyncRoute(async (req, res) => {
  const rows = Math.min(26, Math.max(1, Number(req.body.rows) || 1)); const columns = Math.min(30, Math.max(1, Number(req.body.columns) || 1)); const eventId = Number(req.params.id);
  const [[event]] = await pool.query('SELECT id FROM events WHERE id=?', [eventId]); if (!event) return res.status(404).json({ message: 'Event not found.' });
  const values = []; for (let r = 0; r < rows; r += 1) for (let c = 1; c <= columns; c += 1) values.push([eventId, String.fromCharCode(65 + r) + c, String.fromCharCode(65 + r), c]);
  await pool.query('INSERT IGNORE INTO event_seats (event_id,seat_label,seat_row,seat_number) VALUES ?', [values]); res.json({ generated: values.length });
}));
app.post('/api/admin/events', auth, admin, asyncRoute(async (req, res) => {
  const { name, description, categoryId, startsAt, venue, imageUrl, tickets, seatRows, seatColumns } = req.body;
  const ticketOptions = Array.isArray(tickets) ? tickets : [];
  const rows = Number(seatRows) || 0; const columns = Number(seatColumns) || 0;
  if (!name?.trim() || !Number.isInteger(Number(categoryId)) || !startsAt || !venue?.trim() || !ticketOptions.length || ticketOptions.some(t => !String(t.name || '').trim() || !Number.isFinite(Number(t.price)) || Number(t.price) < 0 || !Number.isInteger(Number(t.quantity)) || Number(t.quantity) < 1) || rows < 0 || rows > 26 || columns < 0 || columns > 30 || (rows === 0) !== (columns === 0)) return res.status(400).json({ message: 'Provide valid event, ticket, and seat-map details.' });
  const date = new Date(startsAt); if (Number.isNaN(date.getTime()) || date <= new Date()) return res.status(400).json({ message: 'Event date must be in the future.' });
  const conn = await pool.getConnection();
  try { await conn.beginTransaction(); const [r] = await conn.query('INSERT INTO events (name,description,category_id,organizer_id,starts_at,venue,image_url,status) VALUES (?,?,?,?,?,?,?,"published")', [name.trim(), description || '', Number(categoryId), req.user.id, startsAt, venue.trim(), imageUrl || '']); for (const ticket of ticketOptions) await conn.query('INSERT INTO ticket_types (event_id,name,price,available_quantity) VALUES (?,?,?,?)', [r.insertId, String(ticket.name).trim(), Number(ticket.price), Number(ticket.quantity)]); if (rows) { const values = []; for (let row = 0; row < rows; row += 1) for (let column = 1; column <= columns; column += 1) values.push([r.insertId, String.fromCharCode(65 + row) + column, String.fromCharCode(65 + row), column]); await conn.query('INSERT INTO event_seats (event_id,seat_label,seat_row,seat_number) VALUES ?', [values]); } await conn.commit(); res.status(201).json({ id: r.insertId }); } catch (e) { await conn.rollback(); throw e; } finally { conn.release(); }
}));
app.put('/api/admin/events/:id', auth, admin, asyncRoute(async (req, res) => {
  const { name, description, categoryId, startsAt, venue, imageUrl, tickets, seatRows, seatColumns } = req.body;
  const date = new Date(startsAt);
  const ticketOptions = Array.isArray(tickets) ? tickets : [];
  const rows = Number(seatRows) || 0; const columns = Number(seatColumns) || 0; const eventId = Number(req.params.id);
  if (!name?.trim() || !Number.isInteger(Number(categoryId)) || Number.isNaN(date.getTime()) || !venue?.trim() || !ticketOptions.length || ticketOptions.some(t => (t.id !== undefined && !Number.isInteger(Number(t.id))) || !String(t.name || '').trim() || !Number.isFinite(Number(t.price)) || Number(t.price) < 0 || !Number.isInteger(Number(t.quantity)) || Number(t.quantity) < 0) || rows < 0 || rows > 26 || columns < 0 || columns > 30 || (rows === 0) !== (columns === 0)) return res.status(400).json({ message: 'Provide valid event, ticket, and seat-map details.' });
  const conn = await pool.getConnection();
  try { await conn.beginTransaction(); const [[event]] = await conn.query('SELECT id FROM events WHERE id=? FOR UPDATE', [eventId]); if (!event) { await conn.rollback(); return res.status(404).json({ message: 'Event not found.' }); } await conn.query('UPDATE events SET name=?,description=?,category_id=?,starts_at=?,venue=?,image_url=? WHERE id=?', [name.trim(), description || '', Number(categoryId), startsAt, venue.trim(), imageUrl || '', eventId]); for (const ticket of ticketOptions) { if (ticket.id === undefined) { await conn.query('INSERT INTO ticket_types (event_id,name,price,available_quantity) VALUES (?,?,?,?)', [eventId, String(ticket.name).trim(), Number(ticket.price), Number(ticket.quantity)]); } else { const [result] = await conn.query('UPDATE ticket_types SET name=?,price=?,available_quantity=? WHERE id=? AND event_id=?', [String(ticket.name).trim(), Number(ticket.price), Number(ticket.quantity), Number(ticket.id), eventId]); if (!result.affectedRows) { await conn.rollback(); return res.status(400).json({ message: 'One of the ticket types does not belong to this event.' }); } } } if (rows) { const values = []; for (let row = 0; row < rows; row += 1) for (let column = 1; column <= columns; column += 1) values.push([eventId, String.fromCharCode(65 + row) + column, String.fromCharCode(65 + row), column]); await conn.query('INSERT IGNORE INTO event_seats (event_id,seat_label,seat_row,seat_number) VALUES ?', [values]); } await conn.commit(); res.json({ updated: true }); } catch (e) { await conn.rollback(); throw e; } finally { conn.release(); }
}));
app.post('/api/admin/events/:id/tickets', auth, admin, asyncRoute(async (req, res) => {
  const name = String(req.body.name || '').trim(); const price = Number(req.body.price); const quantity = Number(req.body.quantity);
  if (!name || !Number.isFinite(price) || price < 0 || !Number.isInteger(quantity) || quantity < 1) return res.status(400).json({ message: 'Provide a ticket name, non-negative price, and positive quantity.' });
  const [[event]] = await pool.query('SELECT id FROM events WHERE id=?', [Number(req.params.id)]);
  if (!event) return res.status(404).json({ message: 'Event not found.' });
  const [result] = await pool.query('INSERT INTO ticket_types (event_id,name,price,available_quantity) VALUES (?,?,?,?)', [event.id, name, price, quantity]);
  res.status(201).json({ id: result.insertId });
}));
app.patch('/api/admin/tickets/:id', auth, admin, asyncRoute(async (req, res) => {
  const name = String(req.body.name || '').trim(); const price = Number(req.body.price); const available = Number(req.body.availableQuantity);
  if (!name || !Number.isFinite(price) || price < 0 || !Number.isInteger(available) || available < 0) return res.status(400).json({ message: 'Provide a valid ticket name, price, and inventory.' });
  const [result] = await pool.query('UPDATE ticket_types SET name=?,price=?,available_quantity=? WHERE id=?', [name, price, available, Number(req.params.id)]);
  if (!result.affectedRows) return res.status(404).json({ message: 'Ticket type not found.' }); res.json({ updated: true });
}));
app.delete('/api/admin/tickets/:id', auth, admin, asyncRoute(async (req, res) => {
  const [[ticket]] = await pool.query('SELECT id FROM ticket_types WHERE id=?', [Number(req.params.id)]);
  if (!ticket) return res.status(404).json({ message: 'Ticket type not found.' });
  const [[used]] = await pool.query('SELECT COUNT(*) count FROM bookings WHERE ticket_type_id=?', [ticket.id]);
  if (used.count > 0) return res.status(409).json({ message: 'Ticket types with bookings cannot be deleted.' });
  await pool.query('DELETE FROM ticket_types WHERE id=?', [ticket.id]); res.json({ deleted: true });
}));
app.patch('/api/admin/events/:id/status', auth, admin, asyncRoute(async (req, res) => { const status = ['draft', 'published', 'cancelled'].includes(req.body.status) ? req.body.status : null; if (!status) return res.status(400).json({ message: 'Invalid event status.' }); const [result] = await pool.query('UPDATE events SET status=? WHERE id=?', [status, Number(req.params.id)]); if (!result.affectedRows) return res.status(404).json({ message: 'Event not found.' }); res.json({ status }); }));
app.use((err, _req, res, _next) => { console.error(err.message); res.status(500).json({ message: 'Server error. Check the backend console.' }); });
app.listen(Number(process.env.PORT || 4000), () => console.log(`Eventra API running on port ${process.env.PORT || 4000}`));
