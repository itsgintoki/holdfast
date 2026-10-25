import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { config } from '../config';
import * as schema from './schema';

export const pool = new Pool({
  connectionString: config.databaseUrl,
  max: config.poolMax,
});

export const db = drizzle(pool, { schema });