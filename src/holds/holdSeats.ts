import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db/client';
import { events, holds, units } from '../db/schema';
import {
  EventNotFoundError,
  SeatsUnavailableError,
  UnitsNotFoundError,
} from '../errors';

export async function holdSeats(args: {
  tenantId: string;
  eventId: string;
  buyerRef: string;
  unitIds: string[];
}): Promise<string> {
  const uniqueUnitIds = [...new Set(args.unitIds)];

  if (uniqueUnitIds.length === 0) {
    throw new SeatsUnavailableError(); // later: a separate 400 validation error
  }

  return await db.transaction(async (tx) => {
    // 0. event must exist AND belong to this tenant (plain read, no lock)
    const [event] = await tx
      .select({ holdTtlSeconds: events.holdTtlSeconds })
      .from(events)
      .where(and(eq(events.id, args.eventId), eq(events.tenantId, args.tenantId)));

    if (!event) {
      throw new EventNotFoundError();
    }

    // 1. lock the rows in a fixed order (waits our turn, decides nothing)
    const locked = await tx
      .select({ id: units.id, status: units.status })
      .from(units)
      .where(
        and(
          eq(units.tenantId, args.tenantId),
          eq(units.eventId, args.eventId),
          inArray(units.id, uniqueUnitIds),
        ),
      )
      .orderBy(asc(units.id))
      .for('update');

    // some ids don't exist for this event: the buyer's mistake, not a conflict
    if (locked.length !== uniqueUnitIds.length) {
      throw new UnitsNotFoundError();
    }

    // a locked unit may have been taken while we waited for the lock
    if (locked.some((unit) => unit.status !== 'available')) {
      throw new SeatsUnavailableError();
    }

    // 2. hold row, expiry computed on the database clock
    const [hold] = await tx
      .insert(holds)
      .values({
        tenantId: args.tenantId,
        eventId: args.eventId,
        buyerRef: args.buyerRef,
        expiresAt: sql`now() + make_interval(secs => ${event.holdTtlSeconds})`,
      })
      .returning({ id: holds.id });

    // 3. guarded update (decides who actually gets the seats)
    const updated = await tx
      .update(units)
      .set({ status: 'held', holdId: hold.id })
      .where(
        and(
          eq(units.tenantId, args.tenantId),
          eq(units.eventId, args.eventId),
          eq(units.status, 'available'),
          inArray(units.id, uniqueUnitIds),
        ),
      )
      .returning({ id: units.id });

    // 4. all or nothing: throwing rolls back the hold row too
    if (updated.length !== uniqueUnitIds.length) {
      throw new SeatsUnavailableError();
    }

    return hold.id;
  });
}