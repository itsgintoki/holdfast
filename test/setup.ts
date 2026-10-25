import { Client } from 'pg';
import { afterEach, beforeEach } from 'vitest';
import { config } from '../src/config';

// Vitest normally serializes files, but repeat runs have produced rare overlap
// between one test's TRUNCATE and another test's in-flight hold transaction.
// Serialize test cases at the database level so resets cannot race app queries.
// This does not serialize buyers inside a test; concurrency tests still run
// their buyers in parallel.
const TEST_DB_LOCK_KEY = 42424242;

let lockClient: Client | undefined;

beforeEach(async () => {
  const client = new Client({ connectionString: config.databaseUrl });
  await client.connect();

  try {
    await client.query('SELECT pg_advisory_lock($1)', [TEST_DB_LOCK_KEY]);
  } catch (error) {
    await client.end();
    throw error;
  }

  lockClient = client;
});

afterEach(async () => {
  const client = lockClient;
  lockClient = undefined;

  if (!client) {
    return;
  }

  try {
    await client.query('SELECT pg_advisory_unlock($1)', [TEST_DB_LOCK_KEY]);
  } finally {
    await client.end();
  }
});
