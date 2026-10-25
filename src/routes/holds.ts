import { Router } from 'express';
import {
  EventNotFoundError,
  SeatsUnavailableError,
  UnitsNotFoundError,
} from '../errors';
import { holdAnySeats } from '../holds/holdAnySeats';
import { holdSeats } from '../holds/holdSeats';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type ParsedHoldRequest =
  | {
      tenantId: string;
      eventId: string;
      buyerRef: string;
      unitIds: string[];
    }
  | {
      tenantId: string;
      eventId: string;
      buyerRef: string;
      quantity: number;
    };

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

function parseHoldRequest(body: unknown): ParsedHoldRequest | null {
  if (typeof body !== 'object' || body === null) {
    return null;
  }

  const { tenantId, eventId, buyerRef, unitIds, quantity } = body as Record<
    string,
    unknown
  >;

  if (
    !isUuid(tenantId) ||
    !isUuid(eventId) ||
    typeof buyerRef !== 'string' ||
    buyerRef.trim().length === 0
  ) {
    return null;
  }

  const trimmedBuyerRef = buyerRef.trim();
  const hasUnitIds = unitIds !== undefined;
  const hasQuantity = quantity !== undefined;

  // Exactly one mode: hand-picked unit ids or "any N".
  if (hasUnitIds === hasQuantity) {
    return null;
  }

  if (hasUnitIds) {
    if (
      !Array.isArray(unitIds) ||
      unitIds.length === 0 ||
      !unitIds.every(isUuid)
    ) {
      return null;
    }

    return { tenantId, eventId, buyerRef: trimmedBuyerRef, unitIds };
  }

  if (typeof quantity !== 'number' || !Number.isInteger(quantity) || quantity <= 0) {
    return null;
  }

  return { tenantId, eventId, buyerRef: trimmedBuyerRef, quantity };
}

export const holdsRouter = Router();

holdsRouter.post('/', async (req, res) => {
  const request = parseHoldRequest(req.body);

  if (!request) {
    res.status(400).json({ error: 'invalid_request' });
    return;
  }

  try {
    // No auth layer yet, so the tenant comes from the request body. This should
    // move to the authenticated tenant context before the API is exposed.
    const holdId =
      'unitIds' in request
        ? await holdSeats({
            tenantId: request.tenantId,
            eventId: request.eventId,
            buyerRef: request.buyerRef,
            unitIds: request.unitIds,
          })
        : await holdAnySeats({
            tenantId: request.tenantId,
            eventId: request.eventId,
            buyerRef: request.buyerRef,
            quantity: request.quantity,
          });

    res.status(201).json({ holdId });
  } catch (error) {
    if (error instanceof SeatsUnavailableError) {
      res.status(409).json({ error: 'seats_unavailable' });
      return;
    }

    if (error instanceof EventNotFoundError) {
      res.status(404).json({ error: 'event_not_found' });
      return;
    }

    if (error instanceof UnitsNotFoundError) {
      res.status(404).json({ error: 'units_not_found' });
      return;
    }

    console.error(error);
    res.status(500).json({ error: 'internal_error' });
  }
});
