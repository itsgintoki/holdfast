import express from 'express';
import { holdsRouter } from './routes/holds';

export function createApp() {
  const app = express();
  app.use(express.json());
  app.get('/health', (_req, res) => res.json({ ok: true }));
  app.use('/holds', holdsRouter);
  return app;
}