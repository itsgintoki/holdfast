import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { db, pool } from '../src/db/client';
import { holds, units } from '../src/db/schema';
import { resetDb, seedEvent } from './helpers';

const app = createApp();

describe('POST /holds', () => {
  beforeEach(resetDb);
  afterAll(() => pool.end());

  it('holds a hand-picked unit', async () => {
    const { tenantId, eventId, unitIds } = await seedEvent(2);

    const response = await request(app)
      .post('/holds')
      .send({
        tenantId,
        eventId,
        buyerRef: '  buyer-a  ',
        unitIds: [unitIds[0]],
      })
      .expect(201);

    expect(response.body).toEqual({ holdId: expect.any(String) });

    const [unit] = await db
      .select({ status: units.status, holdId: units.holdId })
      .from(units)
      .where(eq(units.id, unitIds[0]));

    expect(unit).toEqual({ status: 'held', holdId: response.body.holdId });

    const [hold] = await db.select({ buyerRef: holds.buyerRef }).from(holds);
    expect(hold.buyerRef).toBe('buyer-a');
  });

  it('holds any N units', async () => {
    const { tenantId, eventId } = await seedEvent(3);

    const response = await request(app)
      .post('/holds')
      .send({ tenantId, eventId, buyerRef: 'buyer-a', quantity: 2 })
      .expect(201);

    expect(response.body).toEqual({ holdId: expect.any(String) });

    const unitRows = await db.select({ status: units.status }).from(units);
    expect(unitRows.filter((unit) => unit.status === 'held')).toHaveLength(2);
    expect(unitRows.filter((unit) => unit.status === 'available')).toHaveLength(1);
  });

  it('returns 409 when a hand-picked unit is already held', async () => {
    const { tenantId, eventId, unitIds } = await seedEvent(1);
    const body = { tenantId, eventId, buyerRef: 'buyer-a', unitIds: [unitIds[0]] };

    await request(app).post('/holds').send(body).expect(201);

    const response = await request(app)
      .post('/holds')
      .send({ ...body, buyerRef: 'buyer-b' })
      .expect(409);

    expect(response.body).toEqual({ error: 'seats_unavailable' });

    const holdRows = await db.select({ id: holds.id }).from(holds);
    expect(holdRows).toHaveLength(1);
  });

  it('returns 409 when any-N cannot fill the request', async () => {
    const { tenantId, eventId } = await seedEvent(2);

    const response = await request(app)
      .post('/holds')
      .send({ tenantId, eventId, buyerRef: 'buyer-a', quantity: 3 })
      .expect(409);

    expect(response.body).toEqual({ error: 'seats_unavailable' });
  });

  it('returns 404 for an unknown event', async () => {
    const response = await request(app)
      .post('/holds')
      .send({
        tenantId: randomUUID(),
        eventId: randomUUID(),
        buyerRef: 'buyer-a',
        unitIds: [randomUUID()],
      })
      .expect(404);

    expect(response.body).toEqual({ error: 'event_not_found' });
  });

  it('returns 404 for an unknown unit', async () => {
    const { tenantId, eventId } = await seedEvent(1);

    const response = await request(app)
      .post('/holds')
      .send({
        tenantId,
        eventId,
        buyerRef: 'buyer-a',
        unitIds: [randomUUID()],
      })
      .expect(404);

    expect(response.body).toEqual({ error: 'units_not_found' });
  });

  it('returns 400 for an invalid request body', async () => {
    const base = {
      tenantId: randomUUID(),
      eventId: randomUUID(),
      buyerRef: 'buyer-a',
    };

    const invalidBodies = [
      {},
      { ...base, unitIds: [] },
      { ...base, unitIds: [randomUUID()], quantity: 1 },
      { ...base, quantity: 0 },
      { ...base, quantity: 1.5 },
      { ...base, buyerRef: '   ', quantity: 1 },
      { ...base, eventId: 'not-a-uuid', quantity: 1 },
    ];

    for (const body of invalidBodies) {
      const response = await request(app).post('/holds').send(body).expect(400);
      expect(response.body).toEqual({ error: 'invalid_request' });
    }
  });
});
