import express from 'express';
import apiRoutes from './routes/index.js';

const app = express();

app.use(express.json());
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', service: 'eventra-api' });
});
app.use('/api', apiRoutes);

export default app;

