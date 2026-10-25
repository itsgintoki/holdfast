import { and, asc, count, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db/client';
import {
  isDeadlockError,
  MAX_TRANSACTION_ATTEMPTS,
  retryDelayMs,
  sleep,
} from '../db/retry';
import { events, holds, units } from '../db/schema';
import { EventNotFoundError, SeatsUnavailableError } from '../errors';

type AttemptResult =
  | { kind: 'held'; holdId: string }
  | { kind: 'short' };

export async function holdAnySeats(args: {
  tenantId: string;
  eventId: string;
  buyerRef: string;
  quantity: number;
}): Promise<string> {
  if (!Number.isInteger(args.quantity) || args.quantity <= 0) {
    throw new SeatsUnavailableError(); // later: a separate 400 validation error
  }

  for (let attempt = 1; attempt <= MAX_TRANSACTION_ATTEMPTS; attempt += 1) {
    try {
      const result = await db.transaction(async (tx): Promise<AttemptResult> => {
        // 0. event must exist AND belong to this tenant
        const [event] = await tx
          .select({ holdTtlSeconds: events.holdTtlSeconds })
          .from(events)
          .where(and(eq(events.id, args.eventId), eq(events.tenantId, args.tenantId)));

        if (!event) {
          throw new EventNotFoundError();
        }

        // 1. take any N available units, skipping rows another buyer has locked
        const candidates = await tx
          .select({ id: units.id })
          .from(units)
          .where(
            and(
              eq(units.tenantId, args.tenantId),
              eq(units.eventId, args.eventId),
              eq(units.status, 'available'),
            ),
          )
          .orderBy(asc(units.id))
          .limit(args.quantity)
          .for('update', { skipLocked: true });

        // A short result may be temporary: the missing rows could be locked by
        // buyers who are still mid-transaction and may roll back.
        if (candidates.length < args.quantity) {
          return { kind: 'short' };
        }

        const unitIds = candidates.map((unit) => unit.id);

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

        // 3. guarded update, even though the selected rows are locked
        const updated = await tx
          .update(units)
          .set({ status: 'held', holdId: hold.id })
          .where(
            and(
              eq(units.tenantId, args.tenantId),
              eq(units.eventId, args.eventId),
              eq(units.status, 'available'),
              inArray(units.id, unitIds),
            ),
          )
          .returning({ id: units.id });

        // 4. all or nothing: throwing rolls back the hold row too
        if (updated.length !== args.quantity) {
          throw new SeatsUnavailableError();
        }

        return { kind: 'held', holdId: hold.id };
      });

      if (result.kind === 'held') {
        return result.holdId;
      }

      if (attempt === MAX_TRANSACTION_ATTEMPTS) {
        throw new SeatsUnavailableError();
      }

      // Cheap non-locking hint: skip retries when even a full release of all
      // currently locked rows could not satisfy the request.
      const [available] = await db
        .select({ value: count() })
        .from(units)
        .where(
          and(
            eq(units.tenantId, args.tenantId),
            eq(units.eventId, args.eventId),
            eq(units.status, 'available'),
          ),
        );

      if (Number(available?.value ?? 0) < args.quantity) {
        throw new SeatsUnavailableError();
      }
    } catch (error) {
      if (attempt === MAX_TRANSACTION_ATTEMPTS || !isDeadlockError(error)) {
        throw error;
      }
    }

    await sleep(retryDelayMs());
  }

  throw new SeatsUnavailableError();
}
