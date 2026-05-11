import type { FastifyInstance } from 'fastify';
import { asc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/client.js';
import { families, goals } from '../db/schema.js';
import { bus } from '../realtime/bus.js';
import { lastPayoutMoment } from '../domain/cadence.js';
import { memberBelongsToFamily } from '../domain/membership.js';

export async function goalsRoutes(app: FastifyInstance): Promise<void> {
  // GET /goals — every goal in the family, with computed progress so the
  // member dashboard can render chunky progress bars without a second round trip.
  app.get('/goals', async (req) => {
    const p = req.requireAnyMember();
    const rows = await db
      .select()
      .from(goals)
      .where(eq(goals.familyId, p.familyId))
      .orderBy(asc(goals.createdAt));
    if (rows.length === 0) return { goals: [] };

    const [fam] = await db.select().from(families).where(eq(families.id, p.familyId)).limit(1);
    if (!fam) return { goals: [] };

    const cutoff = lastPayoutMoment(new Date(), fam.timezone, fam.payoutDay, fam.payoutTime);
    const progressByMember = new Map<string, { weekUnpaid: number; lifetime: number }>();

    // Compute per-(memberType,memberId) totals in one query each.
    const weekUnpaidRows = await db.execute<{
      member_type: 'user' | 'kid';
      member_id: string;
      total: string;
    }>(sql`
      select member_type, member_id, sum(amount_cents)::text as total
      from ledger_entries
      where family_id = ${fam.id}
        and (earned_at >= ${cutoff} or status = 'unpaid')
      group by member_type, member_id
    `);
    const lifetimeRows = await db.execute<{
      member_type: 'user' | 'kid';
      member_id: string;
      total: string;
    }>(sql`
      select member_type, member_id, sum(amount_cents)::text as total
      from ledger_entries
      where family_id = ${fam.id}
      group by member_type, member_id
    `);
    for (const r of weekUnpaidRows.rows) {
      const key = `${r.member_type}:${r.member_id}`;
      const existing = progressByMember.get(key) ?? { weekUnpaid: 0, lifetime: 0 };
      existing.weekUnpaid = Number(r.total);
      progressByMember.set(key, existing);
    }
    for (const r of lifetimeRows.rows) {
      const key = `${r.member_type}:${r.member_id}`;
      const existing = progressByMember.get(key) ?? { weekUnpaid: 0, lifetime: 0 };
      existing.lifetime = Number(r.total);
      progressByMember.set(key, existing);
    }

    const out = rows.map((g) => {
      const prog = progressByMember.get(`${g.memberType}:${g.memberId}`) ?? {
        weekUnpaid: 0,
        lifetime: 0,
      };
      const progressCents = g.basis === 'lifetime' ? prog.lifetime : prog.weekUnpaid;
      return {
        ...g,
        progressCents,
        percent: Math.min(100, Math.round((progressCents / g.targetCents) * 100)),
      };
    });

    return { goals: out };
  });

  app.post('/goals', async (req, reply) => {
    const p = req.requireAnyMember();
    const body = z
      .object({
        memberType: z.enum(['user', 'kid']),
        memberId: z.string().uuid(),
        name: z.string().min(1).max(64),
        targetCents: z.number().int().min(1).max(10_000_000),
        deadline: z.string().datetime().optional(),
        basis: z.enum(['weekly_plus_unpaid', 'lifetime']).default('weekly_plus_unpaid'),
      })
      .parse(req.body);

    // Kids may only set goals for themselves.
    if (p.kind === 'kid' && (body.memberType !== 'kid' || body.memberId !== p.kidId)) {
      return reply.code(403).send({ error: 'not_yours' });
    }
    const inFamily = await memberBelongsToFamily(
      { type: body.memberType, id: body.memberId },
      p.familyId,
    );
    if (!inFamily) {
      return reply.code(404).send({ error: 'member_not_found' });
    }

    const [g] = await db
      .insert(goals)
      .values({
        familyId: p.familyId,
        memberType: body.memberType,
        memberId: body.memberId,
        name: body.name,
        targetCents: body.targetCents,
        deadline: body.deadline ? new Date(body.deadline) : null,
        basis: body.basis,
      })
      .returning();
    bus.publish(p.familyId, { type: 'goal.updated', goalId: g!.id });
    reply.code(201);
    return { goal: g };
  });

  app.delete('/goals/:id', async (req, reply) => {
    const p = req.requireAnyMember();
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const [existing] = await db.select().from(goals).where(eq(goals.id, params.id)).limit(1);
    if (!existing || existing.familyId !== p.familyId) {
      return reply.code(404).send({ error: 'not_found' });
    }
    if (p.kind === 'kid' && (existing.memberType !== 'kid' || existing.memberId !== p.kidId)) {
      return reply.code(403).send({ error: 'not_yours' });
    }
    await db.delete(goals).where(eq(goals.id, params.id));
    bus.publish(p.familyId, { type: 'goal.updated', goalId: existing.id });
    return { ok: true };
  });
}
