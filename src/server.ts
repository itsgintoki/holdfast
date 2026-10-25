import { createApp } from './app';
import { config } from './config';
import { pool } from './db/client';

const server = createApp().listen(config.port, () =>
  console.log(`listening on ${config.port}`),
);

process.on('SIGTERM', () => {
  server.close(async () => {
    await pool.end();
    process.exit(0);
  });
});