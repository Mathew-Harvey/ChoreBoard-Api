import type { FastifyInstance } from 'fastify';
import { and, asc, desc, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/client.js';
import { families, milestoneHits, milestones } from '../db/schema.js';
import { bus } from '../realtime/bus.js';
import {
  computeProgress,
  periodStartFor,
  type MilestoneRow,
} from '../domain/milestones.js';
import { memberBelongsToFamily } from '../domain/membership.js';

const baseBody = z.object({
  name: z.string().min(1).max(80),
  reward: z.string().min(1).max(280),
  icon: z.string().max(8).nullable().optional(),
  scope: z.enum(['family', 'member']),
  memberType: z.enum(['user', 'kid']).nullable().optional(),
  memberId: z.string().uuid().nullable().optional(),
  metric: z.enum(['cents_earned', 'chores_completed']),
  period: z.enum(['week', 'month', 'lifetime']),
  targetValue: z.number().int().min(1).max(100_000_000),
  repeats: z.boolean().default(true),
  active: z.boolean().default(true),
});

export async function milestonesRoutes(app: FastifyInstance): Promise<void> {
  // GET /milestones — every milestone for the family, decorated with progress
  // for the current period and the most recent N hits (so the UI can render
  // both "you're 60% of the way to pizza night this week" and "claimed Apr 1
  // / claimed Apr 8 / outstanding ⚠️" in one round trip).
  app.get('/milestones', async (req) => {
    const p = req.requireAnyMember();
    const [fam] = await db
      .select()
      .from(families)
      .where(eq(families.id, p.familyId))
      .limit(1);
    if (!fam) return { milestones: [] };

    const rows = await db
      .select()
      .from(milestones)
      .where(eq(milestones.familyId, p.familyId))
      .orderBy(asc(milestones.archivedAt), asc(milestones.createdAt));

    if (rows.length === 0) return { milestones: [] };

    const now = new Date();
    const out = await Promise.all(
      rows.map(async (m) => {
        const periodStart = periodStartFor(m, now, fam);
        const [progress, currentHits, recentHits, unclaimedHits] = await Promise.all([
          computeProgress(db, m, periodStart),
          db
            .select()
            .from(milestoneHits)
            .where(
              and(
                eq(milestoneHits.milestoneId, m.id),
                eq(milestoneHits.periodStart, periodStart),
              ),
            )
            .limit(1),
          db
            .select()
            .from(milestoneHits)
            .where(eq(milestoneHits.milestoneId, m.id))
            .orderBy(desc(milestoneHits.hitAt))
            .limit(10),
          db
            .select({ id: milestoneHits.id })
            .from(milestoneHits)
            .where(
              and(
                eq(milestoneHits.milestoneId, m.id),
                isNull(milestoneHits.claimedAt),
              ),
            ),
        ]);
        const currentHit = currentHits[0] ?? null;
        return {
          ...m,
          periodStart: periodStart.toISOString(),
          progress,
          percent: Math.min(100, Math.round((progress / m.targetValue) * 100)),
          hitThisPeriod: !!currentHit,
          currentHit,
          recentHits,
          unclaimedHitCount: unclaimedHits.length,
        };
      }),
    );

    return { milestones: out };
  });

  // POST /milestones — parent only.
  app.post('/milestones', async (req, reply) => {
    const p = req.requireParent();
    const body = baseBody.parse(req.body);
    if (body.scope === 'member') {
      if (!body.memberType || !body.memberId) {
        return reply.code(400).send({ error: 'member_required' });
      }
      const ok = await memberBelongsToFamily(
        { type: body.memberType, id: body.memberId },
        p.familyId,
      );
      if (!ok) return reply.code(404).send({ error: 'member_not_found' });
    }
    if (body.metric === 'cents_earned' && body.targetValue < 1) {
      return reply.code(400).send({ error: 'target_too_small' });
    }

    const [m] = await db
      .insert(milestones)
      .values({
        familyId: p.familyId,
        name: body.name.trim(),
        reward: body.reward.trim(),
        icon: body.icon ?? null,
        scope: body.scope,
        memberType: body.scope === 'member' ? body.memberType! : null,
        memberId: body.scope === 'member' ? body.memberId! : null,
        metric: body.metric,
        period: body.period,
        targetValue: body.targetValue,
        repeats: body.repeats,
        active: body.active,
        createdByUserId: p.userId,
      })
      .returning();
    bus.publish(p.familyId, { type: 'milestone.updated', milestoneId: m!.id });
    reply.code(201);
    return { milestone: m };
  });

  // PATCH /milestones/:id
  app.patch('/milestones/:id', async (req, reply) => {
    const p = req.requireParent();
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = baseBody.partial().parse(req.body);

    const [existing] = await db
      .select()
      .from(milestones)
      .where(and(eq(milestones.id, params.id), eq(milestones.familyId, p.familyId)))
      .limit(1);
    if (!existing) return reply.code(404).send({ error: 'not_found' });

    const patch: Partial<MilestoneRow> & { updatedAt?: Date } = { updatedAt: new Date() };
    if (body.name !== undefined) patch.name = body.name.trim();
    if (body.reward !== undefined) patch.reward = body.reward.trim();
    if (body.icon !== undefined) patch.icon = body.icon ?? null;
    if (body.scope !== undefined) patch.scope = body.scope;
    if (body.memberType !== undefined) patch.memberType = body.memberType ?? null;
    if (body.memberId !== undefined) patch.memberId = body.memberId ?? null;
    if (body.metric !== undefined) patch.metric = body.metric;
    if (body.period !== undefined) patch.period = body.period;
    if (body.targetValue !== undefined) patch.targetValue = body.targetValue;
    if (body.repeats !== undefined) patch.repeats = body.repeats;
    if (body.active !== undefined) patch.active = body.active;

    // After applying the patch, re-validate scope/member coherence.
    const finalScope = patch.scope ?? existing.scope;
    const finalMemberType = patch.memberType ?? existing.memberType;
    const finalMemberId = patch.memberId ?? existing.memberId;
    if (finalScope === 'member') {
      if (!finalMemberType || !finalMemberId) {
        return reply.code(400).send({ error: 'member_required' });
      }
      const ok = await memberBelongsToFamily(
        { type: finalMemberType, id: finalMemberId },
        p.familyId,
      );
      if (!ok) return reply.code(404).send({ error: 'member_not_found' });
    } else if (finalScope === 'family') {
      patch.memberType = null;
      patch.memberId = null;
    }

    const [m] = await db
      .update(milestones)
      .set(patch)
      .where(eq(milestones.id, params.id))
      .returning();
    bus.publish(p.familyId, { type: 'milestone.updated', milestoneId: params.id });
    return { milestone: m };
  });

  // DELETE /milestones/:id — soft-archive (we keep history of past hits).
  app.delete('/milestones/:id', async (req, reply) => {
    const p = req.requireParent();
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const [existing] = await db
      .select()
      .from(milestones)
      .where(and(eq(milestones.id, params.id), eq(milestones.familyId, p.familyId)))
      .limit(1);
    if (!existing) return reply.code(404).send({ error: 'not_found' });
    await db
      .update(milestones)
      .set({ active: false, archivedAt: new Date(), updatedAt: new Date() })
      .where(eq(milestones.id, params.id));
    bus.publish(p.familyId, { type: 'milestone.updated', milestoneId: params.id });
    return { ok: true };
  });

  // POST /milestones/hits/:hitId/claim — parent marks the reward as
  // delivered. Idempotent: claiming an already-claimed hit just refreshes
  // the note and re-stamps who claimed it.
  app.post('/milestones/hits/:hitId/claim', async (req, reply) => {
    const p = req.requireParent();
    const params = z.object({ hitId: z.string().uuid() }).parse(req.params);
    const body = z
      .object({ note: z.string().max(280).optional() })
      .parse(req.body ?? {});
    const [hit] = await db
      .select()
      .from(milestoneHits)
      .where(
        and(
          eq(milestoneHits.id, params.hitId),
          eq(milestoneHits.familyId, p.familyId),
        ),
      )
      .limit(1);
    if (!hit) return reply.code(404).send({ error: 'not_found' });

    const [updated] = await db
      .update(milestoneHits)
      .set({
        claimedAt: hit.claimedAt ?? new Date(),
        claimedByUserId: p.userId,
        claimNote: body.note ?? hit.claimNote,
      })
      .where(eq(milestoneHits.id, params.hitId))
      .returning();
    bus.publish(p.familyId, {
      type: 'milestone.claimed',
      milestoneId: hit.milestoneId,
      hitId: hit.id,
    });
    return { hit: updated };
  });

  // POST /milestones/hits/:hitId/unclaim — undo "marked delivered" if a
  // parent ticked the wrong row.
  app.post('/milestones/hits/:hitId/unclaim', async (req, reply) => {
    const p = req.requireParent();
    const params = z.object({ hitId: z.string().uuid() }).parse(req.params);
    const [hit] = await db
      .select()
      .from(milestoneHits)
      .where(
        and(
          eq(milestoneHits.id, params.hitId),
          eq(milestoneHits.familyId, p.familyId),
        ),
      )
      .limit(1);
    if (!hit) return reply.code(404).send({ error: 'not_found' });
    const [updated] = await db
      .update(milestoneHits)
      .set({ claimedAt: null, claimedByUserId: null, claimNote: null })
      .where(eq(milestoneHits.id, params.hitId))
      .returning();
    bus.publish(p.familyId, {
      type: 'milestone.claimed',
      milestoneId: hit.milestoneId,
      hitId: hit.id,
    });
    return { hit: updated };
  });
}
