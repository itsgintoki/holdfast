import { sql } from 'drizzle-orm';
import { config } from '../src/config';
import { db } from '../src/db/client';
import { tenants, events, holds, units } from '../src/db/schema';

export async function resetDb(): Promise<void> {
  if (!config.databaseUrl.includes('_test')) {
    throw new Error('Safety check failed: DATABASE_URL does not point to a test database.');
  }
  await db.execute(sql`TRUNCATE TABLE ${tenants}, ${events}, ${holds}, ${units} CASCADE;`);
}

export async function seedEvent(unitCount: number) {
  const [tenant] = await db.insert(tenants).values({ name: 'test' }).returning({ id: tenants.id });
  const tenantId = tenant.id;

  const [event] = await db
    .insert(events)
    .values({ tenantId, name: 'Test Event', capacity: unitCount })
    .returning({ id: events.id });
  const eventId = event.id;

  const insertedUnits = await db
    .insert(units)
    .values(Array.from({ length: unitCount }, (_, i) => ({ tenantId, eventId, label: `A-${i + 1}` })))
    .returning({ id: units.id });

  return { tenantId, eventId, unitIds: insertedUnits.map((u) => u.id) };
}