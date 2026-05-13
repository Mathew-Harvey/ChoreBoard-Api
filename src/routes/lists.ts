import type { FastifyInstance } from 'fastify';
import { and, asc, desc, eq, gte, isNull, lte, max } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/client.js';
import { listItems, lists } from '../db/schema.js';
import { bus } from '../realtime/bus.js';

/**
 * Lists — shopping lists, packing lists, todo lists.
 *
 * Items can carry a cached "product card" copied off our /api/products/*
 * proxy. Storing the card on the row means the list still renders prices and
 * thumbnails when the family takes the iPad to a coverage hole at the
 * supermarket — and it freezes the price the family saw at add-time so
 * upstream price changes don't silently shift list totals.
 */

const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD')
  .nullable();

const productSnapshotSchema = z
  .object({
    source: z.enum(['woolworths']),
    externalId: z.string(),
    name: z.string(),
    brand: z.string().nullable().optional(),
    image: z.string().nullable().optional(),
    packageSize: z.string().nullable().optional(),
    priceCents: z.number().int().nullable().optional(),
    wasPriceCents: z.number().int().nullable().optional(),
    onSpecial: z.boolean().optional(),
  })
  .nullable();

function principalIds(p: { kind: 'parent'; userId: string } | { kind: 'kid'; kidId: string }) {
  return p.kind === 'parent'
    ? { createdByUserId: p.userId, createdByKidId: null }
    : { createdByUserId: null, createdByKidId: p.kidId };
}
function checkerIds(p: { kind: 'parent'; userId: string } | { kind: 'kid'; kidId: string }) {
  return p.kind === 'parent'
    ? { checkedByUserId: p.userId, checkedByKidId: null }
    : { checkedByUserId: null, checkedByKidId: p.kidId };
}

export async function listsRoutes(app: FastifyInstance): Promise<void> {
  // GET /lists — index, with optional ?from/?to date filter and ?archived
  // toggle. Always returns metadata + a count of items / unchecked items so
  // the calendar can show progress without dragging item rows down.
  app.get('/lists', async (req) => {
    const p = req.requireAnyMember();
    const q = z
      .object({
        from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        archived: z.coerce.boolean().optional(),
      })
      .parse(req.query ?? {});

    const where = [eq(lists.familyId, p.familyId)];
    if (q.from) where.push(gte(lists.date, q.from));
    if (q.to) where.push(lte(lists.date, q.to));
    if (q.archived !== true) where.push(isNull(lists.archivedAt));

    const rows = await db
      .select()
      .from(lists)
      .where(and(...where))
      .orderBy(desc(lists.updatedAt));

    if (rows.length === 0) return { lists: [] };
    // Pull aggregate counts in one query for the index — cheap, and avoids
    // the editor having to hydrate every list before the calendar paints.
    const items = await db
      .select({
        listId: listItems.listId,
        text: listItems.text,
        checkedAt: listItems.checkedAt,
        unitPriceCents: listItems.unitPriceCents,
        qty: listItems.qty,
      })
      .from(listItems)
      .where(eq(listItems.familyId, p.familyId));
    const counts = new Map<string, { total: number; checked: number; totalCents: number }>();
    for (const it of items) {
      const c = counts.get(it.listId) ?? { total: 0, checked: 0, totalCents: 0 };
      c.total += 1;
      if (it.checkedAt) c.checked += 1;
      if (typeof it.unitPriceCents === 'number') {
        c.totalCents += it.unitPriceCents * Math.max(1, it.qty);
      }
      counts.set(it.listId, c);
    }
    const decorated = rows.map((r) => {
      const c = counts.get(r.id) ?? { total: 0, checked: 0, totalCents: 0 };
      return { ...r, itemCount: c.total, checkedCount: c.checked, totalCents: c.totalCents };
    });
    return { lists: decorated };
  });

  // GET /lists/:id — full list including items, items sorted by sort_order.
  app.get('/lists/:id', async (req, reply) => {
    const p = req.requireAnyMember();
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const [list] = await db
      .select()
      .from(lists)
      .where(and(eq(lists.id, params.id), eq(lists.familyId, p.familyId)))
      .limit(1);
    if (!list) return reply.code(404).send({ error: 'not_found' });
    const items = await db
      .select()
      .from(listItems)
      .where(eq(listItems.listId, list.id))
      .orderBy(asc(listItems.sortOrder), asc(listItems.createdAt));
    return { list, items };
  });

  // POST /lists — create a new list. Defaults to 'shopping' kind so the
  // common case (Woolworths run) is one tap.
  app.post('/lists', async (req, reply) => {
    const p = req.requireAnyMember();
    const body = z
      .object({
        title: z.string().min(1).max(120),
        kind: z.enum(['shopping', 'todo', 'packing', 'other']).optional(),
        date: dateSchema.optional(),
        store: z.enum(['woolworths']).nullable().optional(),
      })
      .parse(req.body);
    const [row] = await db
      .insert(lists)
      .values({
        familyId: p.familyId,
        title: body.title,
        kind: body.kind ?? 'shopping',
        date: body.date ?? null,
        store: body.store ?? (body.kind === 'shopping' || !body.kind ? 'woolworths' : null),
        ...principalIds(p),
      })
      .returning();
    bus.publish(p.familyId, { type: 'list.created', listId: row!.id, date: row!.date });
    reply.code(201);
    return { list: row };
  });

  // PATCH /lists/:id — title / date / kind / store / archive toggle.
  app.patch('/lists/:id', async (req, reply) => {
    const p = req.requireAnyMember();
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z
      .object({
        title: z.string().min(1).max(120).optional(),
        kind: z.enum(['shopping', 'todo', 'packing', 'other']).optional(),
        date: dateSchema.optional(),
        store: z.enum(['woolworths']).nullable().optional(),
        archived: z.boolean().optional(),
      })
      .parse(req.body ?? {});
    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if (body.title !== undefined) patch.title = body.title;
    if (body.kind !== undefined) patch.kind = body.kind;
    if (body.date !== undefined) patch.date = body.date;
    if (body.store !== undefined) patch.store = body.store;
    if (body.archived !== undefined) patch.archivedAt = body.archived ? new Date() : null;
    if (Object.keys(patch).length === 1) {
      return reply.code(400).send({ error: 'no_fields' });
    }
    const [row] = await db
      .update(lists)
      .set(patch)
      .where(and(eq(lists.id, params.id), eq(lists.familyId, p.familyId)))
      .returning();
    if (!row) return reply.code(404).send({ error: 'not_found' });
    bus.publish(p.familyId, { type: 'list.updated', listId: row.id, date: row.date });
    return { list: row };
  });

  // DELETE /lists/:id — parent-only (kids can archive instead).
  app.delete('/lists/:id', async (req, reply) => {
    const p = req.requireParent();
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const [row] = await db
      .delete(lists)
      .where(and(eq(lists.id, params.id), eq(lists.familyId, p.familyId)))
      .returning();
    if (!row) return reply.code(404).send({ error: 'not_found' });
    bus.publish(p.familyId, { type: 'list.deleted', listId: row.id, date: row.date });
    return { ok: true };
  });

  // POST /lists/:id/items — add a line to a list. Optionally carries a
  // product snapshot from /api/products/* so the line shows price + image.
  app.post('/lists/:id/items', async (req, reply) => {
    const p = req.requireAnyMember();
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z
      .object({
        text: z.string().min(1).max(280),
        qty: z.number().int().min(1).max(999).optional(),
        unitPriceCents: z.number().int().min(0).max(10_000_000).nullable().optional(),
        product: productSnapshotSchema.optional(),
      })
      .parse(req.body);
    const [list] = await db
      .select({ id: lists.id, date: lists.date })
      .from(lists)
      .where(and(eq(lists.id, params.id), eq(lists.familyId, p.familyId)))
      .limit(1);
    if (!list) return reply.code(404).send({ error: 'not_found' });

    // Append-friendly sort order: pick the largest existing one and add 10
    // so manual reorders (drag-to-rearrange) have headroom on either side.
    const sortRows = await db
      .select({ value: max(listItems.sortOrder) })
      .from(listItems)
      .where(eq(listItems.listId, list.id));
    const nextSort = (sortRows[0]?.value ?? -10) + 10;

    const [row] = await db
      .insert(listItems)
      .values({
        listId: list.id,
        familyId: p.familyId,
        text: body.text,
        qty: body.qty ?? 1,
        unitPriceCents:
          body.unitPriceCents ?? body.product?.priceCents ?? null,
        productJson: body.product ?? null,
        sortOrder: nextSort,
      })
      .returning();
    bus.publish(p.familyId, { type: 'list.item.changed', listId: list.id });
    bus.publish(p.familyId, { type: 'list.updated', listId: list.id, date: list.date });
    reply.code(201);
    return { item: row };
  });

  // PATCH /lists/:id/items/:itemId — text / qty / price / sort tweaks.
  app.patch('/lists/:id/items/:itemId', async (req, reply) => {
    const p = req.requireAnyMember();
    const params = z
      .object({ id: z.string().uuid(), itemId: z.string().uuid() })
      .parse(req.params);
    const body = z
      .object({
        text: z.string().min(1).max(280).optional(),
        qty: z.number().int().min(1).max(999).optional(),
        unitPriceCents: z.number().int().min(0).max(10_000_000).nullable().optional(),
        product: productSnapshotSchema.optional(),
        sortOrder: z.number().int().optional(),
      })
      .parse(req.body ?? {});
    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if (body.text !== undefined) patch.text = body.text;
    if (body.qty !== undefined) patch.qty = body.qty;
    if (body.unitPriceCents !== undefined) patch.unitPriceCents = body.unitPriceCents;
    if (body.product !== undefined) {
      patch.productJson = body.product;
      // Keep the snapshot price in sync when a product is attached for the
      // first time and no explicit override was provided.
      if (body.unitPriceCents === undefined && body.product?.priceCents != null) {
        patch.unitPriceCents = body.product.priceCents;
      }
    }
    if (body.sortOrder !== undefined) patch.sortOrder = body.sortOrder;
    if (Object.keys(patch).length === 1) {
      return reply.code(400).send({ error: 'no_fields' });
    }
    const [row] = await db
      .update(listItems)
      .set(patch)
      .where(
        and(
          eq(listItems.id, params.itemId),
          eq(listItems.listId, params.id),
          eq(listItems.familyId, p.familyId),
        ),
      )
      .returning();
    if (!row) return reply.code(404).send({ error: 'not_found' });
    bus.publish(p.familyId, { type: 'list.item.changed', listId: row.listId });
    return { item: row };
  });

  // POST /lists/:id/items/:itemId/check — toggle done (anyone in the family).
  app.post('/lists/:id/items/:itemId/check', async (req, reply) => {
    const p = req.requireAnyMember();
    const params = z
      .object({ id: z.string().uuid(), itemId: z.string().uuid() })
      .parse(req.params);
    const body = z.object({ checked: z.boolean() }).parse(req.body ?? {});
    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if (body.checked) {
      patch.checkedAt = new Date();
      Object.assign(patch, checkerIds(p));
    } else {
      patch.checkedAt = null;
      patch.checkedByUserId = null;
      patch.checkedByKidId = null;
    }
    const [row] = await db
      .update(listItems)
      .set(patch)
      .where(
        and(
          eq(listItems.id, params.itemId),
          eq(listItems.listId, params.id),
          eq(listItems.familyId, p.familyId),
        ),
      )
      .returning();
    if (!row) return reply.code(404).send({ error: 'not_found' });
    bus.publish(p.familyId, { type: 'list.item.changed', listId: row.listId });
    return { item: row };
  });

  // DELETE /lists/:id/items/:itemId — remove a line.
  app.delete('/lists/:id/items/:itemId', async (req, reply) => {
    const p = req.requireAnyMember();
    const params = z
      .object({ id: z.string().uuid(), itemId: z.string().uuid() })
      .parse(req.params);
    const [row] = await db
      .delete(listItems)
      .where(
        and(
          eq(listItems.id, params.itemId),
          eq(listItems.listId, params.id),
          eq(listItems.familyId, p.familyId),
        ),
      )
      .returning();
    if (!row) return reply.code(404).send({ error: 'not_found' });
    bus.publish(p.familyId, { type: 'list.item.changed', listId: row.listId });
    return { ok: true };
  });

  // POST /lists/:id/items/clear-checked — sweep done items (e.g. after a
  // shopping run). Returns count for the toast.
  app.post('/lists/:id/items/clear-checked', async (req, reply) => {
    const p = req.requireAnyMember();
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const [list] = await db
      .select({ id: lists.id, date: lists.date })
      .from(lists)
      .where(and(eq(lists.id, params.id), eq(lists.familyId, p.familyId)))
      .limit(1);
    if (!list) return reply.code(404).send({ error: 'not_found' });
    // Drizzle's NOT NULL on a timestamp: we use `gte` against the epoch.
    const removed = await db
      .delete(listItems)
      .where(
        and(
          eq(listItems.listId, list.id),
          eq(listItems.familyId, p.familyId),
          gte(listItems.checkedAt, new Date(0)),
        ),
      )
      .returning({ id: listItems.id });
    bus.publish(p.familyId, { type: 'list.item.changed', listId: list.id });
    return { removed: removed.length };
  });
}
