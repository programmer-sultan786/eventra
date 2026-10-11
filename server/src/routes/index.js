import { Router } from 'express';
import { pending } from '../controllers/pendingController.js';

const router = Router();
const plannedModules = [
  'auth', 'events', 'venues', 'schedules', 'bookings', 'payments',
  'tickets', 'history', 'admin', 'notifications', 'reviews',
];

plannedModules.forEach((moduleName) => {
  router.use(`/${moduleName}`, pending);
});

export default router;

