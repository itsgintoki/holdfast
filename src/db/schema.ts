import {
    pgTable, pgEnum, uuid, text, integer, timestamp,
    index, uniqueIndex, check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// Drizzle 0.36+ (the table's third argument returns an array)

export const unitStatus = pgEnum("unit_status", ["available", "held", "sold"]);
export const holdStatus = pgEnum("hold_status", ["active", "converted", "expired", "released"]);

export const tenants = pgTable("tenants", {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const events = pgTable("events", {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    name: text("name").notNull(),
    startsAt: timestamp("starts_at", { withTimezone: true }),
    capacity: integer("capacity").notNull(),
    holdTtlSeconds: integer("hold_ttl_s").notNull().default(300),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const holds = pgTable("holds", {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    eventId: uuid("event_id").notNull().references(() => events.id),
    buyerRef: text("buyer_ref").notNull(),
    status: holdStatus("status").notNull().default("active"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const units = pgTable(
    "units",
    {
        id: uuid("id").primaryKey().defaultRandom(),
        tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
        eventId: uuid("event_id").notNull().references(() => events.id),
        label: text("label").notNull(), // "A-12", "slot 10:30", "SKU-001"
        status: unitStatus("status").notNull().default("available"),
        holdId: uuid("hold_id").references(() => holds.id),
    },
    (t) => [
        uniqueIndex("units_event_label_uq").on(t.eventId, t.label),
        // fast "give me any N available units for this event"
        index("units_available_idx").on(t.eventId).where(sql`${t.status} = 'available'`),
        // an available unit never points at a hold
        check("units_available_has_no_hold", sql`${t.status} <> 'available' OR ${t.holdId} IS NULL`),
        // a held unit always points at a hold
        check("units_held_has_hold", sql`${t.status} <> 'held' OR ${t.holdId} IS NOT NULL`),
    ],
);