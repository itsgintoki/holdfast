import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, pool } from '../src/db/client';
import { holds, units } from '../src/db/schema';
import { holdSeats } from '../src/holds/holdSeats';
import { SeatsUnavailableError } from '../src/errors';
import { resetDb, seedEvent } from './helpers';

describe('holdSeats concurrency', () => {
  beforeEach(resetDb);
  afterAll(() => pool.end());

  it('gives one seat to exactly one of 200 buyers', async () => {
    const { tenantId, eventId, unitIds } = await seedEvent(1);

    const results = await Promise.allSettled(
      Array.from({ length: 200 }, (_, i) =>
        holdSeats({
          tenantId,
          eventId,
          buyerRef: `buyer-${i}`,
          unitIds: [unitIds[0]],
        }),
      ),
    );

    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(199);
    expect(rejected.every((result) => result.reason instanceof SeatsUnavailableError)).toBe(true);

    const holdRows = await db
      .select({ id: holds.id, buyerRef: holds.buyerRef })
      .from(holds);

    expect(holdRows).toHaveLength(1);
    expect(holdRows[0].buyerRef).toMatch(/^buyer-\d+$/);

    const [unit] = await db
      .select({ status: units.status, holdId: units.holdId })
      .from(units)
      .where(eq(units.id, unitIds[0]));

    expect(unit.status).toBe('held');
    expect(unit.holdId).toBe(holdRows[0].id);
  });

  it('rolls back the whole request when one requested unit is already held', async () => {
    const { tenantId, eventId, unitIds } = await seedEvent(3);

    const existingHoldId = await holdSeats({
      tenantId,
      eventId,
      buyerRef: 'first-buyer',
      unitIds: [unitIds[2]],
    });

    await expect(
      holdSeats({
        tenantId,
        eventId,
        buyerRef: 'second-buyer',
        unitIds,
      }),
    ).rejects.toBeInstanceOf(SeatsUnavailableError);

    const allUnits = await db
      .select({ id: units.id, status: units.status, holdId: units.holdId })
      .from(units);
    const byId = new Map(allUnits.map((unit) => [unit.id, unit]));

    expect(byId.get(unitIds[0])).toMatchObject({ status: 'available', holdId: null });
    expect(byId.get(unitIds[1])).toMatchObject({ status: 'available', holdId: null });
    expect(byId.get(unitIds[2])).toMatchObject({ status: 'held', holdId: existingHoldId });

    const holdRows = await db.select({ id: holds.id }).from(holds);
    expect(holdRows).toEqual([{ id: existingHoldId }]);
  });

  it('does not deadlock when overlapping sets are requested in opposite order', async () => {
    const { tenantId, eventId, unitIds } = await seedEvent(2);
    const [first, second] = unitIds;

    const results = await Promise.allSettled([
      holdSeats({
        tenantId,
        eventId,
        buyerRef: 'buyer-a',
        unitIds: [first, second],
      }),
      holdSeats({
        tenantId,
        eventId,
        buyerRef: 'buyer-b',
        unitIds: [second, first],
      }),
    ]);

    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBeInstanceOf(SeatsUnavailableError);
    expect((rejected[0].reason as { code?: string }).code).not.toBe('40P01');

    const unitRows = await db
      .select({ status: units.status })
      .from(units);
    expect(unitRows.filter((unit) => unit.status === 'held')).toHaveLength(2);

    const holdRows = await db.select({ id: holds.id }).from(holds);
    expect(holdRows).toHaveLength(1);
  });
});
