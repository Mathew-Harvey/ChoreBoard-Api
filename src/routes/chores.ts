import type { FastifyInstance } from 'fastify';
import { and, asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/client.js';
import { chores, families } from '../db/schema.js';
import { scheduler } from '../scheduler/runner.js';
import { bus } from '../realtime/bus.js';
import { spawnInstanceNow } from './board.js';

const timeRe = /^\d{2}:\d{2}$/;
const cadenceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('daily'), times: z.array(z.string().regex(timeRe)).min(1) }),
  z.object({
    kind: z.literal('weekly'),
    days: z.array(z.number().int().min(0).max(6)).min(1),
    time: z.string().regex(timeRe),
  }),
  z.object({
    kind: z.literal('every_n_days'),
    n: z.number().int().min(1).max(60),
    time: z.string().regex(timeRe),
  }),
  z.object({
    kind: z.literal('every_n_weeks'),
    n: z.number().int().min(1).max(8),
    days: z.array(z.number().int().min(0).max(6)).min(1),
    time: z.string().regex(timeRe),
  }),
  z.object({
    kind: z.literal('monthly_dom'),
    day: z.number().int().min(1).max(31),
    time: z.string().regex(timeRe),
  }),
  z.object({
    kind: z.literal('monthly_nth'),
    nth: z.number().int().min(1).max(5),
    weekday: z.number().int().min(0).max(6),
    time: z.string().regex(timeRe),
  }),
]);

export async function choreRoutes(app: FastifyInstance): Promise<void> {
  app.get('/chores', async (req) => {
    const p = req.requireAnyMember();
    const rows = await db
      .select()
      .from(chores)
      .where(eq(chores.familyId, p.familyId))
      .orderBy(asc(chores.sortOrder), asc(chores.name));
    return { chores: rows };
  });

  app.post('/chores', async (req, reply) => {
    const p = req.requireParent();
    const body = z
      .object({
        name: z.string().min(1).max(128),
        description: z.string().max(500).optional(),
        amountCents: z.number().int().min(0).max(100_000),
        cadence: cadenceSchema,
        active: z.boolean().default(true),
        photoRequired: z.boolean().default(false),
        sortOrder: z.number().int().optional(),
      })
      .parse(req.body);
    const [c] = await db
      .insert(chores)
      .values({
        familyId: p.familyId,
        name: body.name,
        description: body.description,
        amountCents: body.amountCents,
        cadenceJson: body.cadence,
        active: body.active,
        photoRequired: body.photoRequired,
        sortOrder: body.sortOrder ?? 0,
      })
      .returning();
    if (c!.active) await scheduler.scheduleMaterializeNow(c!.id, p.familyId);
    bus.publish(p.familyId, { type: 'chore.updated', choreId: c!.id });
    reply.code(201);
    return { chore: c };
  });

  app.patch('/chores/:id', async (req) => {
    const p = req.requireParent();
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z
      .object({
        name: z.string().min(1).max(128).optional(),
        description: z.string().max(500).optional(),
        amountCents: z.number().int().min(0).max(100_000).optional(),
        cadence: cadenceSchema.optional(),
        active: z.boolean().optional(),
        photoRequired: z.boolean().optional(),
        sortOrder: z.number().int().optional(),
      })
      .parse(req.body);
    const patch: Record<string, unknown> = {};
    if (body.name !== undefined) patch.name = body.name;
    if (body.description !== undefined) patch.description = body.description;
    if (body.amountCents !== undefined) patch.amountCents = body.amountCents;
    if (body.cadence !== undefined) patch.cadenceJson = body.cadence;
    if (body.active !== undefined) patch.active = body.active;
    if (body.photoRequired !== undefined) patch.photoRequired = body.photoRequired;
    if (body.sortOrder !== undefined) patch.sortOrder = body.sortOrder;

    if (Object.keys(patch).length === 0) {
      const err = new Error('no_fields') as any;
      err.statusCode = 400;
      throw err;
    }

    const [c] = await db
      .update(chores)
      .set(patch)
      .where(and(eq(chores.id, params.id), eq(chores.familyId, p.familyId)))
      .returning();
    if (c?.active) await scheduler.scheduleMaterializeNow(c.id, p.familyId);
    bus.publish(p.familyId, { type: 'chore.updated', choreId: params.id });
    return { chore: c };
  });

  // POST /chores/:id/spawn — parent immediately drops a fresh instance of
  // this chore onto the board. Bypasses the cadence timer for the "do it
  // right now" case (one-off chores, scheduler caught up late, etc).
  app.post('/chores/:id/spawn', async (req, reply) => {
    const p = req.requireParent();
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const [chore] = await db
      .select()
      .from(chores)
      .where(and(eq(chores.id, params.id), eq(chores.familyId, p.familyId)))
      .limit(1);
    if (!chore) return reply.code(404).send({ error: 'not_found' });
    const [fam] = await db.select().from(families).where(eq(families.id, p.familyId)).limit(1);
    if (!fam) return reply.code(404).send({ error: 'family_missing' });

    const inst = await spawnInstanceNow(db, { familyId: p.familyId, chore, fam });
    bus.publish(p.familyId, { type: 'instance.materialized', instanceId: inst.id });
    reply.code(201);
    return { instance: inst };
  });

  app.delete('/chores/:id', async (req) => {
    const p = req.requireParent();
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const [c] = await db
      .update(chores)
      .set({ active: false })
      .where(and(eq(chores.id, params.id), eq(chores.familyId, p.familyId)))
      .returning();
    bus.publish(p.familyId, { type: 'chore.updated', choreId: params.id });
    return { ok: true, chore: c ?? null };
  });
}
