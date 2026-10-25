import { eq } from 'drizzle-orm';
import { db } from '../src/db/client';
import { events, holds, units } from '../src/db/schema';

/**
 * Checks the M1 invariants for one event:
 * - held units never exceed capacity
 * - an available unit never points at a hold
 * - a held unit always points at an active hold for the same event
 */
export async function assertEventInvariants(eventId: string): Promise<void> {
  const [event] = await db
    .select({ capacity: events.capacity })
    .from(events)
    .where(eq(events.id, eventId));

  if (!event) {
    throw new Error(`Invariant check failed: event ${eventId} does not exist`);
  }

  const rows = await db
    .select({
      unitId: units.id,
      status: units.status,
      holdId: units.holdId,
      holdStatus: holds.status,
      holdEventId: holds.eventId,
    })
    .from(units)
    .leftJoin(holds, eq(units.holdId, holds.id))
    .where(eq(units.eventId, eventId));

  const held = rows.filter((row) => row.status === 'held');

  if (held.length > event.capacity) {
    throw new Error(
      `Invariant check failed: ${held.length} held units exceeds capacity ${event.capacity}`,
    );
  }

  for (const row of rows) {
    if (row.status === 'available' && row.holdId !== null) {
      throw new Error(`Invariant check failed: available unit ${row.unitId} points at a hold`);
    }

    if (row.status === 'held') {
      if (row.holdId === null || row.holdStatus === null) {
        throw new Error(`Invariant check failed: held unit ${row.unitId} has no hold`);
      }

      if (row.holdStatus !== 'active') {
        throw new Error(
          `Invariant check failed: unit ${row.unitId} points at a ${row.holdStatus} hold`,
        );
      }

      if (row.holdEventId !== eventId) {
        throw new Error(
          `Invariant check failed: unit ${row.unitId} points at a hold for another event`,
        );
      }
    }
  }
}
