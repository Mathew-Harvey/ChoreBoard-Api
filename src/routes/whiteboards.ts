import type { FastifyInstance } from 'fastify';
import { and, desc, eq, gte, inArray, lte } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/client.js';
import { whiteboards } from '../db/schema.js';
import { bus } from '../realtime/bus.js';

/**
 * Whiteboards — free-form drawings the family makes together.
 *
 * Strokes are stored inline as a JSON array on the row. A stroke is the
 * minimum amount of replay state we need to redraw the canvas:
 *
 *   { tool, color, size, points: [[x,y]…] }
 *
 * That's intentionally tiny: the renderer tessellates between consecutive
 * points with quadratic curves, so even a wobbly five-second scribble is a
 * couple hundred numbers — well under any sensible jsonb size budget.
 *
 * The full payload comes back in a single GET so the editor doesn't have to
 * stitch together delta streams; if a board ever does grow huge the next
 * iteration can shard strokes into a child table.
 */

const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD')
  .nullable();

const pointSchema = z.tuple([z.number(), z.number()]);
const strokeSchema = z.object({
  // 'pen' draws ink, 'eraser' overwrites with the background color, 'highlight'
  // uses a translucent layer. The renderer interprets each tool — the API
  // doesn't care, but we cap to a known set so a hostile client can't smuggle
  // arbitrary CSS into the payload.
  tool: z.enum(['pen', 'highlight', 'eraser']),
  color: z.string().regex(/^#[0-9A-Fa-f]{3,8}$/),
  size: z.number().min(0.5).max(120),
  points: z.array(pointSchema).min(1).max(8000),
});

export type Stroke = z.infer<typeof strokeSchema>;

function principalIds(p: { kind: 'parent'; userId: string } | { kind: 'kid'; kidId: string }) {
  return p.kind === 'parent'
    ? { createdByUserId: p.userId, createdByKidId: null }
    : { createdByUserId: null, createdByKidId: p.kidId };
}

export async function whiteboardRoutes(app: FastifyInstance): Promise<void> {
  // GET /whiteboards — index. Optional ?from=YYYY-MM-DD&to=YYYY-MM-DD filter
  // narrows to a calendar window so the calendar doesn't drag the entire
  // history down on first paint. Always returns metadata only — no strokes.
  app.get('/whiteboards', async (req) => {
    const p = req.requireAnyMember();
    const q = z
      .object({
        from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        limit: z.coerce.number().int().min(1).max(200).optional(),
      })
      .parse(req.query ?? {});

    const where = [eq(whiteboards.familyId, p.familyId)];
    if (q.from) where.push(gte(whiteboards.date, q.from));
    if (q.to) where.push(lte(whiteboards.date, q.to));

    const rows = await db
      .select({
        id: whiteboards.id,
        title: whiteboards.title,
        date: whiteboards.date,
        background: whiteboards.background,
        width: whiteboards.width,
        height: whiteboards.height,
        pointsCount: whiteboards.pointsCount,
        createdByUserId: whiteboards.createdByUserId,
        createdByKidId: whiteboards.createdByKidId,
        createdAt: whiteboards.createdAt,
        updatedAt: whiteboards.updatedAt,
      })
      .from(whiteboards)
      .where(and(...where))
      .orderBy(desc(whiteboards.updatedAt))
      .limit(q.limit ?? 100);

    return { whiteboards: rows };
  });

  // GET /whiteboards/:id — full board including strokes. This is the only
  // endpoint that returns the (potentially fat) strokes_json payload.
  app.get('/whiteboards/:id', async (req, reply) => {
    const p = req.requireAnyMember();
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const [row] = await db
      .select()
      .from(whiteboards)
      .where(and(eq(whiteboards.id, params.id), eq(whiteboards.familyId, p.familyId)))
      .limit(1);
    if (!row) return reply.code(404).send({ error: 'not_found' });
    return { whiteboard: row };
  });

  // POST /whiteboards — create a fresh, empty board. Editor opens this and
  // patches strokes/title in as the user works.
  app.post('/whiteboards', async (req, reply) => {
    const p = req.requireAnyMember();
    const body = z
      .object({
        title: z.string().min(1).max(120).optional(),
        date: dateSchema.optional(),
        background: z.enum(['paper', 'grid', 'dots', 'dark']).optional(),
        width: z.number().int().min(320).max(8192).optional(),
        height: z.number().int().min(240).max(8192).optional(),
      })
      .parse(req.body ?? {});
    const [row] = await db
      .insert(whiteboards)
      .values({
        familyId: p.familyId,
        title: body.title ?? 'Untitled board',
        date: body.date ?? null,
        background: body.background ?? 'paper',
        width: body.width ?? 1600,
        height: body.height ?? 1000,
        ...principalIds(p),
      })
      .returning();
    bus.publish(p.familyId, {
      type: 'whiteboard.created',
      whiteboardId: row!.id,
      date: row!.date,
    });
    reply.code(201);
    return { whiteboard: row };
  });

  // PATCH /whiteboards/:id — title / date / background updates. Strokes use a
  // separate endpoint so big stroke writes don't churn metadata-only PATCHes.
  app.patch('/whiteboards/:id', async (req, reply) => {
    const p = req.requireAnyMember();
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z
      .object({
        title: z.string().min(1).max(120).optional(),
        date: dateSchema.optional(),
        background: z.enum(['paper', 'grid', 'dots', 'dark']).optional(),
      })
      .parse(req.body ?? {});
    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if (body.title !== undefined) patch.title = body.title;
    if (body.date !== undefined) patch.date = body.date;
    if (body.background !== undefined) patch.background = body.background;
    if (Object.keys(patch).length === 1) {
      return reply.code(400).send({ error: 'no_fields' });
    }
    const [row] = await db
      .update(whiteboards)
      .set(patch)
      .where(and(eq(whiteboards.id, params.id), eq(whiteboards.familyId, p.familyId)))
      .returning();
    if (!row) return reply.code(404).send({ error: 'not_found' });
    bus.publish(p.familyId, {
      type: 'whiteboard.updated',
      whiteboardId: row.id,
      date: row.date,
    });
    return { whiteboard: row };
  });

  // PUT /whiteboards/:id/strokes — wholesale replace the stroke array.
  // The editor coalesces ink locally and flushes here on a debounce so we
  // don't write per-stroke. Cap the payload server-side; ten thousand strokes
  // is plenty for a family canvas and prevents pathological writes.
  app.put('/whiteboards/:id/strokes', async (req, reply) => {
    const p = req.requireAnyMember();
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z
      .object({
        strokes: z.array(strokeSchema).max(10_000),
      })
      .parse(req.body);
    const pointsCount = body.strokes.reduce((acc, s) => acc + s.points.length, 0);
    const [row] = await db
      .update(whiteboards)
      .set({
        strokesJson: body.strokes,
        pointsCount,
        updatedAt: new Date(),
      })
      .where(and(eq(whiteboards.id, params.id), eq(whiteboards.familyId, p.familyId)))
      .returning();
    if (!row) return reply.code(404).send({ error: 'not_found' });
    bus.publish(p.familyId, {
      type: 'whiteboard.updated',
      whiteboardId: row.id,
      date: row.date,
    });
    return { whiteboard: row };
  });

  // DELETE /whiteboards/:id — parents can remove any board; kids/parents can
  // remove boards they created.
  app.delete('/whiteboards/:id', async (req, reply) => {
    const p = req.requireAnyMember();
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const [existing] = await db
      .select()
      .from(whiteboards)
      .where(and(eq(whiteboards.id, params.id), eq(whiteboards.familyId, p.familyId)))
      .limit(1);
    if (!existing) return reply.code(404).send({ error: 'not_found' });
    const ownsBoard =
      p.kind === 'parent'
        ? existing.createdByUserId === p.userId
        : existing.createdByKidId === p.kidId;
    if (p.kind !== 'parent' && !ownsBoard) return reply.code(403).send({ error: 'not_yours' });
    const [row] = await db
      .delete(whiteboards)
      .where(and(eq(whiteboards.id, params.id), eq(whiteboards.familyId, p.familyId)))
      .returning();
    if (!row) return reply.code(404).send({ error: 'not_found' });
    bus.publish(p.familyId, {
      type: 'whiteboard.deleted',
      whiteboardId: row.id,
      date: row.date,
    });
    return { ok: true };
  });

  // POST /whiteboards/cleanup-empty — convenience for the editor to drop
  // boards a kid created but didn't draw on. Idempotent, parent-only.
  app.post('/whiteboards/cleanup-empty', async (req) => {
    const p = req.requireParent();
    const body = z
      .object({ ids: z.array(z.string().uuid()).max(50).optional() })
      .parse(req.body ?? {});
    const filters = [
      eq(whiteboards.familyId, p.familyId),
      eq(whiteboards.pointsCount, 0),
    ];
    if (body.ids?.length) filters.push(inArray(whiteboards.id, body.ids));
    const removed = await db.delete(whiteboards).where(and(...filters)).returning({
      id: whiteboards.id,
      date: whiteboards.date,
    });
    for (const r of removed) {
      bus.publish(p.familyId, {
        type: 'whiteboard.deleted',
        whiteboardId: r.id,
        date: r.date,
      });
    }
    return { removed: removed.length };
  });
}
