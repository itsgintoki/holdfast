import express from 'express';

export function createApp() {
  const app = express();
  app.use(express.json());
  app.get('/health', (_req, res) => res.json({ ok: true }));
  // TODO: mount the holds routes once holdSeats works
  return app;
}