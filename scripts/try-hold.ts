import { holdSeats } from '../src/holds/holdSeats';
import { pool } from '../src/db/client';

const [tenantId, eventId, ...unitIds] = process.argv.slice(2);

try {
  const holdId = await holdSeats({ tenantId, eventId, buyerRef: 'me', unitIds });
  console.log('hold', holdId);
} catch (e) {
  console.log('failed with:', (e as Error).constructor.name);
} finally {
  await pool.end();
}
