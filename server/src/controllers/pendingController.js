import { Router } from 'express';

export const pending = Router();

pending.all('*', (_req, res) => {
  res.status(501).json({ error: 'This API module is not implemented yet.' });
});

