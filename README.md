# Eventra

Eventra is a locally runnable college-event discovery and booking prototype using React/Vite, Express, and MySQL. Payments are explicitly simulated; no money or payment credentials are handled.

## Requirements

- Node.js 18+ and npm
- MySQL 8+

## Setup

1. Create a dedicated database by running `database/schema.sql` in MySQL.
2. Run `database/seed.sql` after the schema. It adds categories, three sample events, ticket inventory, and the development admin.
3. Copy `server/.env.example` to `server/.env` and set the MySQL values. Do not commit `.env`.
4. Install and start:

```powershell
npm install
npm run install:all
npm run dev
```

The client is at http://localhost:5173 and the API is at http://localhost:4000. The seed admin is `admin@eventra.local` / `Admin@123`; change it before any public deployment.

## Routes

`/`, `/events`, `/events/:id`, `/login`, `/register`, `/dashboard`, `/checkout/:id`, `/ticket/:ticketCode`, `/verify/:ticketCode`, and `/admin`.

The booking workflow locks inventory in a MySQL transaction. Successful demo payment creates a confirmed booking and QR ticket; failed/cancelled outcomes return inventory and create no ticket. Customers can cancel future pending or confirmed bookings, which returns inventory and removes an active ticket. Abandoned pending bookings are automatically released after 15 minutes. Events may optionally use a generated seat map; seat selection is transactionally held, sold after successful payment, and released on failed/cancelled bookings. QR codes contain only the ticket code and open the public `/verify/:code` page, which checks `GET /api/tickets/:code/verify`. Confirmed customers can open and print a dedicated ticket view from their dashboard.

The administrator dashboard supports event creation with multiple ticket options, prices, quantities, and an optional seat map in the same form. Existing events can be edited later to update their event details, ticket options, or expand their seat map. Each event has a single catalogue entry, and its buyers can be viewed directly beneath that event with their email, ticket option, quantity, seats, booking reference, and status. Categories are seeded and selectable when creating events. Login attempts are throttled after repeated failures.

Known prototype limitations: no email delivery, production payment provider, or refresh-token/session revocation. Login throttling is in-memory and resets when the backend restarts. Live MySQL verification is covered by the local smoke test after configuring `server/.env`.
