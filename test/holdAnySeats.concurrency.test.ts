import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { db, pool } from '../src/db/client';
import { holds, units } from '../src/db/schema';
import { holdAnySeats } from '../src/holds/holdAnySeats';
import { SeatsUnavailableError } from '../src/errors';
import { resetDb, seedEvent } from './helpers';
import { assertEventInvariants } from './invariants';

describe('holdAnySeats', () => {
  beforeEach(resetDb);
  afterAll(() => pool.end());

  it('gives exactly 100 units to 1,000 buyers', async () => {
    const { tenantId, eventId } = await seedEvent(100);

    const results = await Promise.allSettled(
      Array.from({ length: 1_000 }, (_, i) =>
        holdAnySeats({
          tenantId,
          eventId,
          buyerRef: `buyer-${i}`,
          quantity: 1,
        }),
      ),
    );

    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );

    expect(fulfilled).toHaveLength(100);
    expect(rejected).toHaveLength(900);
    expect(rejected.every((result) => result.reason instanceof SeatsUnavailableError)).toBe(true);

    const holdRows = await db.select({ id: holds.id }).from(holds);
    const unitRows = await db
      .select({ status: units.status, holdId: units.holdId })
      .from(units);

    expect(holdRows).toHaveLength(100);
    expect(unitRows.filter((unit) => unit.status === 'held')).toHaveLength(100);
    expect(unitRows.filter((unit) => unit.status === 'available')).toHaveLength(0);

    const holdIds = new Set(holdRows.map((hold) => hold.id));
    expect(
      unitRows.every((unit) => unit.status === 'available' || holdIds.has(unit.holdId!)),
    ).toBe(true);

    await assertEventInvariants(eventId);
  });

  it('holds nothing when fewer units are available than requested', async () => {
    const { tenantId, eventId } = await seedEvent(2);

    await expect(
      holdAnySeats({
        tenantId,
        eventId,
        buyerRef: 'buyer',
        quantity: 3,
      }),
    ).rejects.toBeInstanceOf(SeatsUnavailableError);

    const holdRows = await db.select({ id: holds.id }).from(holds);
    const unitRows = await db.select({ status: units.status }).from(units);

    expect(holdRows).toHaveLength(0);
    expect(unitRows).toHaveLength(2);
    expect(unitRows.every((unit) => unit.status === 'available')).toBe(true);
  });

  it('retries short SKIP LOCKED results until the attempt cap', async () => {
    const { tenantId, eventId } = await seedEvent(1);

    let releaseBlocker!: () => void;
    const releasePromise = new Promise<void>((resolve) => {
      releaseBlocker = resolve;
    });

    let markLocked!: () => void;
    const lockedPromise = new Promise<void>((resolve) => {
      markLocked = resolve;
    });

    const blocker = db.transaction(async (tx) => {
      await tx.select({ id: units.id }).from(units).for('update');
      markLocked();
      await releasePromise;
    });

    await lockedPromise;

    const started = Date.now();
    try {
      await expect(
        holdAnySeats({
          tenantId,
          eventId,
          buyerRef: 'blocked-buyer',
          quantity: 1,
        }),
      ).rejects.toBeInstanceOf(SeatsUnavailableError);
    } finally {
      releaseBlocker();
      await blocker;
    }

    expect(Date.now() - started).toBeGreaterThanOrEqual(30);

    const holdRows = await db.select({ id: holds.id }).from(holds);
    const unitRows = await db.select({ status: units.status }).from(units);

    expect(holdRows).toHaveLength(0);
    expect(unitRows).toHaveLength(1);
    expect(unitRows[0].status).toBe('available');

    await assertEventInvariants(eventId);
  });

  it('never gives one unit to two buyers', async () => {
    const { tenantId, eventId } = await seedEvent(5);

    const firstHoldId = await holdAnySeats({
      tenantId,
      eventId,
      buyerRef: 'buyer-a',
      quantity: 2,
    });
    const secondHoldId = await holdAnySeats({
      tenantId,
      eventId,
      buyerRef: 'buyer-b',
      quantity: 3,
    });

    const unitRows = await db
      .select({ status: units.status, holdId: units.holdId })
      .from(units);

    expect(firstHoldId).not.toBe(secondHoldId);
    expect(unitRows.filter((unit) => unit.holdId === firstHoldId)).toHaveLength(2);
    expect(unitRows.filter((unit) => unit.holdId === secondHoldId)).toHaveLength(3);
    expect(unitRows.every((unit) => unit.status === 'held')).toBe(true);

    await assertEventInvariants(eventId);
  });
});
