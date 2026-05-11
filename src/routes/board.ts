import type { FastifyInstance, FastifyReply } from 'fastify';
import { and, asc, desc, eq, gte, inArray, lte, or } from 'drizzle-orm';
import { z } from 'zod';
import { db, type DB } from '../db/client.js';
import {
  choreInstances,
  chores,
  families,
  kids,
  ledgerEntries,
  users,
} from '../db/schema.js';
import { bus } from '../realtime/bus.js';
import {
  bumpDailyStreak,
  evaluateBadges,
  evaluateGoals,
  recordXp,
} from '../domain/gamification.js';
import { nextOccurrenceAfter, startOfLocalDay, type Cadence } from '../domain/cadence.js';
import { memberBelongsToFamily } from '../domain/membership.js';

type Txn = DB | Parameters<Parameters<DB['transaction']>[0]>[0];
type FamilyRow = typeof families.$inferSelect;
type InstanceRow = typeof choreInstances.$inferSelect;
type ChoreRow = typeof chores.$inferSelect;
type Member = { type: 'user' | 'kid'; id: string };

export async function boardRoutes(app: FastifyInstance): Promise<void> {
  // GET /board — everything the Kanban needs in one shot.
  app.get('/board', async (req) => {
    const p = req.requireAnyMember();

    const [fam] = await db.select().from(families).where(eq(families.id, p.familyId)).limit(1);
    if (!fam) return { instances: [], chores: [], kids: [], parents: [] };

    const now = new Date();
    const todayStart = startOfLocalDay(now, fam.timezone);

    // Spec §3: "chores appear as they come due." A claimed/pending/approved
    // card stays put regardless of `available_at`; available cards only show
    // once they're actually due.
    const insts = await db
      .select({
        id: choreInstances.id,
        choreId: choreInstances.choreId,
        availableAt: choreInstances.availableAt,
        dueAt: choreInstances.dueAt,
        status: choreInstances.status,
        claimedByType: choreInstances.claimedByType,
        claimedById: choreInstances.claimedById,
        claimedAt: choreInstances.claimedAt,
        completedAt: choreInstances.completedAt,
        approvedAt: choreInstances.approvedAt,
        photoKey: choreInstances.photoKey,
        choreName: chores.name,
        amountCents: chores.amountCents,
        photoRequired: chores.photoRequired,
      })
      .from(choreInstances)
      .innerJoin(chores, eq(chores.id, choreInstances.choreId))
      .where(
        and(
          eq(choreInstances.familyId, p.familyId),
          or(
            and(eq(choreInstances.status, 'available'), lte(choreInstances.availableAt, now)),
            inArray(choreInstances.status, ['claimed', 'pending'] as const),
            and(eq(choreInstances.status, 'approved'), gte(choreInstances.approvedAt, todayStart)),
          ),
        ),
      )
      .orderBy(asc(choreInstances.availableAt));

    const ks = await db
      .select({ id: kids.id, name: kids.name, color: kids.color, avatar: kids.avatar })
      .from(kids)
      .where(eq(kids.familyId, p.familyId));
    const us = await db
      .select({ id: users.id, name: users.name, role: users.role, avatar: users.avatar })
      .from(users)
      .where(eq(users.familyId, p.familyId));

    const decorated = insts.map((i) => ({
      ...i,
      overdue:
        i.status === 'available' && i.dueAt != null && i.dueAt.getTime() <= now.getTime(),
    }));

    return {
      now: now.toISOString(),
      family: {
        id: fam.id,
        name: fam.name,
        timezone: fam.timezone,
        payoutDay: fam.payoutDay,
        payoutTime: fam.payoutTime,
      },
      instances: decorated,
      kids: ks,
      parents: us,
    };
  });

  // POST /board/instances/:id/claim
  app.post('/board/instances/:id/claim', async (req, reply) => {
    const p = req.requireAnyMember();
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z
      .object({
        memberType: z.enum(['user', 'kid']).optional(),
        memberId: z.string().uuid().optional(),
      })
      .parse(req.body ?? {});
    const [inst] = await db
      .select()
      .from(choreInstances)
      .where(and(eq(choreInstances.id, params.id), eq(choreInstances.familyId, p.familyId)))
      .limit(1);
    if (!inst) return reply.code(404).send({ error: 'not_found' });
    if (inst.status !== 'available') {
      return reply.code(409).send({ error: 'not_available' });
    }
    if (inst.availableAt.getTime() > Date.now()) {
      return reply.code(409).send({ error: 'not_yet_available' });
    }
    const member =
      p.kind === 'parent' && body.memberType && body.memberId
        ? { type: body.memberType, id: body.memberId }
        : principalMember(p);
    if (p.kind === 'kid' && (member.type !== 'kid' || member.id !== p.kidId)) {
      return reply.code(403).send({ error: 'not_yours' });
    }
    if (!(await memberBelongsToFamily(member, p.familyId))) {
      return reply.code(404).send({ error: 'member_not_found' });
    }
    const [updated] = await db
      .update(choreInstances)
      .set({
        status: 'claimed',
        claimedByType: member.type,
        claimedById: member.id,
        claimedAt: new Date(),
      })
      .where(and(eq(choreInstances.id, params.id), eq(choreInstances.status, 'available')))
      .returning();
    if (!updated) return reply.code(409).send({ error: 'not_available' });
    bus.publish(p.familyId, { type: 'instance.claimed', instanceId: params.id });
    return { instance: updated };
  });

  // POST /board/instances/:id/unclaim — drag back to available.
  app.post('/board/instances/:id/unclaim', async (req, reply) => {
    const p = req.requireAnyMember();
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const [inst] = await db
      .select()
      .from(choreInstances)
      .where(and(eq(choreInstances.id, params.id), eq(choreInstances.familyId, p.familyId)))
      .limit(1);
    if (!inst) return reply.code(404).send({ error: 'not_found' });
    if (inst.status !== 'claimed' && inst.status !== 'pending') {
      return reply.code(409).send({ error: 'not_unclaimable' });
    }
    const member = principalMember(p);
    const isClaimant =
      inst.claimedByType === member.type && inst.claimedById === member.id;
    if (p.kind === 'kid') {
      if (!isClaimant) return reply.code(403).send({ error: 'not_yours' });
      if (inst.status === 'pending')
        return reply.code(409).send({ error: 'already_submitted' });
    }
    const [updated] = await db
      .update(choreInstances)
      .set({
        status: 'available',
        claimedByType: null,
        claimedById: null,
        claimedAt: null,
        completedAt: null,
      })
      .where(
        and(
          eq(choreInstances.id, params.id),
          inArray(choreInstances.status, ['claimed', 'pending'] as const),
        ),
      )
      .returning();
    if (!updated) return reply.code(409).send({ error: 'not_unclaimable' });
    bus.publish(p.familyId, { type: 'instance.claimed', instanceId: params.id });
    return { instance: updated };
  });

  // POST /board/instances/:id/submit — mark as pending approval
  app.post('/board/instances/:id/submit', async (req, reply) => {
    const p = req.requireAnyMember();
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z.object({ photoKey: z.string().optional() }).parse(req.body ?? {});
    const [inst] = await db
      .select()
      .from(choreInstances)
      .where(and(eq(choreInstances.id, params.id), eq(choreInstances.familyId, p.familyId)))
      .limit(1);
    if (!inst) return reply.code(404).send({ error: 'not_found' });
    if (inst.status !== 'claimed') {
      return reply.code(409).send({ error: 'must_be_claimed' });
    }
    const member = principalMember(p);
    if (p.kind === 'kid' && (inst.claimedByType !== member.type || inst.claimedById !== member.id)) {
      return reply.code(403).send({ error: 'not_yours' });
    }
    const [chore] = await db.select().from(chores).where(eq(chores.id, inst.choreId)).limit(1);
    const effectivePhotoKey = body.photoKey ?? inst.photoKey ?? null;
    if (chore?.photoRequired && !effectivePhotoKey) {
      return reply.code(400).send({ error: 'photo_required' });
    }
    const [updated] = await db
      .update(choreInstances)
      .set({
        status: 'pending',
        completedAt: new Date(),
        photoKey: effectivePhotoKey,
      })
      .where(and(eq(choreInstances.id, params.id), eq(choreInstances.status, 'claimed')))
      .returning();
    if (!updated) return reply.code(409).send({ error: 'must_be_claimed' });
    bus.publish(p.familyId, { type: 'instance.submitted', instanceId: params.id });
    return { instance: updated };
  });

  // POST /board/instances/:id/approve — parent only.
  app.post('/board/instances/:id/approve', async (req, reply) => {
    const p = req.requireParent();
    const params = z.object({ id: z.string().uuid() }).parse(req.params);

    const [fam] = await db.select().from(families).where(eq(families.id, p.familyId)).limit(1);
    if (!fam) return reply.code(404).send({ error: 'family_missing' });

    try {
      const result = await db.transaction(async (tx) => {
        const inst = await loadInstanceForUpdate(tx, params.id, p.familyId);
        if (inst.status !== 'pending') throw new ApprovalError(409, 'not_pending');
        return approveLoadedInstance(tx, { fam, instance: inst, approvedByUserId: p.userId });
      });
      bus.publish(p.familyId, { type: 'instance.approved', instanceId: params.id });
      return { instance: result.instance };
    } catch (e) {
      return handleApprovalError(e, reply);
    }
  });

  // POST /board/instances/:id/reject — back to claimed; the claimant redoes.
  app.post('/board/instances/:id/reject', async (req, reply) => {
    const p = req.requireParent();
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    z.object({ reason: z.string().max(280).optional() }).parse(req.body ?? {});
    const [inst] = await db
      .select()
      .from(choreInstances)
      .where(and(eq(choreInstances.id, params.id), eq(choreInstances.familyId, p.familyId)))
      .limit(1);
    if (!inst) return reply.code(404).send({ error: 'not_found' });
    if (inst.status !== 'pending') return reply.code(409).send({ error: 'not_pending' });
    const [updated] = await db
      .update(choreInstances)
      .set({ status: 'claimed', completedAt: null })
      .where(and(eq(choreInstances.id, params.id), eq(choreInstances.status, 'pending')))
      .returning();
    if (!updated) return reply.code(409).send({ error: 'not_pending' });
    bus.publish(p.familyId, { type: 'instance.rejected', instanceId: params.id });
    return { instance: updated };
  });

  // POST /board/instances/:id/set-status — parent-only manual override.
  // Move a card to any state without dragging through the intermediate ones.
  // When target is `approved`, the canonical approval logic runs in the same
  // transaction so ledger / XP / streak / badge / goal side-effects all land.
  app.post('/board/instances/:id/set-status', async (req, reply) => {
    const p = req.requireParent();
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z
      .object({
        status: z.enum(['available', 'claimed', 'pending', 'approved', 'missed']),
        claimant: z
          .object({
            memberType: z.enum(['user', 'kid']),
            memberId: z.string().uuid(),
          })
          .optional(),
      })
      .parse(req.body);

    const [fam] = await db.select().from(families).where(eq(families.id, p.familyId)).limit(1);
    if (!fam) return reply.code(404).send({ error: 'family_missing' });

    const needsClaimant =
      body.status === 'claimed' ||
      body.status === 'pending' ||
      body.status === 'approved';
    if (needsClaimant && !body.claimant) {
      return reply.code(400).send({ error: 'claimant_required' });
    }
    if (body.claimant) {
      const ok = await memberBelongsToFamily(
        { type: body.claimant.memberType, id: body.claimant.memberId },
        p.familyId,
      );
      if (!ok) return reply.code(404).send({ error: 'member_not_found' });
    }

    try {
      const result = await db.transaction(async (tx) => {
        const current = await loadInstanceForUpdate(tx, params.id, p.familyId);
        const claimant: Member | null = body.claimant
          ? { type: body.claimant.memberType, id: body.claimant.memberId }
          : null;

        switch (body.status) {
          case 'available': {
            const [updated] = await tx
              .update(choreInstances)
              .set({
                status: 'available',
                claimedByType: null,
                claimedById: null,
                claimedAt: null,
                completedAt: null,
                approvedAt: null,
                approvedByUserId: null,
              })
              .where(eq(choreInstances.id, current.id))
              .returning();
            return { kind: 'plain' as const, instance: updated! };
          }
          case 'claimed': {
            const [updated] = await tx
              .update(choreInstances)
              .set({
                status: 'claimed',
                claimedByType: claimant!.type,
                claimedById: claimant!.id,
                claimedAt: current.claimedAt ?? new Date(),
                completedAt: null,
                approvedAt: null,
                approvedByUserId: null,
              })
              .where(eq(choreInstances.id, current.id))
              .returning();
            return { kind: 'plain' as const, instance: updated! };
          }
          case 'pending': {
            const [updated] = await tx
              .update(choreInstances)
              .set({
                status: 'pending',
                claimedByType: claimant!.type,
                claimedById: claimant!.id,
                claimedAt: current.claimedAt ?? new Date(),
                completedAt: new Date(),
                approvedAt: null,
                approvedByUserId: null,
              })
              .where(eq(choreInstances.id, current.id))
              .returning();
            return { kind: 'plain' as const, instance: updated! };
          }
          case 'approved': {
            // Make sure the row reflects the claimant + pending posture
            // before we run the canonical approval logic.
            const [bumped] = await tx
              .update(choreInstances)
              .set({
                status: 'pending',
                claimedByType: claimant!.type,
                claimedById: claimant!.id,
                claimedAt: current.claimedAt ?? new Date(),
                completedAt: current.completedAt ?? new Date(),
              })
              .where(eq(choreInstances.id, current.id))
              .returning();
            const approved = await approveLoadedInstance(tx, {
              fam,
              instance: bumped!,
              approvedByUserId: p.userId,
            });
            return { kind: 'approved' as const, instance: approved.instance };
          }
          case 'missed': {
            const [updated] = await tx
              .update(choreInstances)
              .set({ status: 'missed' })
              .where(eq(choreInstances.id, current.id))
              .returning();
            return { kind: 'plain' as const, instance: updated! };
          }
        }
      });

      bus.publish(
        p.familyId,
        result.kind === 'approved'
          ? { type: 'instance.approved', instanceId: params.id }
          : { type: 'instance.claimed', instanceId: params.id },
      );
      return { instance: result.instance };
    } catch (e) {
      return handleApprovalError(e, reply);
    }
  });

  // GET /board/completed-today — for the "Completed today" column.
  app.get('/board/completed-today', async (req) => {
    const p = req.requireAnyMember();
    const [fam] = await db.select().from(families).where(eq(families.id, p.familyId)).limit(1);
    if (!fam) return { instances: [] };
    const start = startOfLocalDay(new Date(), fam.timezone);
    const insts = await db
      .select()
      .from(choreInstances)
      .where(
        and(
          eq(choreInstances.familyId, p.familyId),
          eq(choreInstances.status, 'approved'),
          gte(choreInstances.approvedAt, start),
        ),
      )
      .orderBy(desc(choreInstances.approvedAt));
    return { instances: insts };
  });
}

// ---------------------------------------------------------------------------
// Approval helpers (shared by `/approve` and `/set-status` paths)
// ---------------------------------------------------------------------------

class ApprovalError extends Error {
  constructor(public status: number, public code: string) {
    super(code);
  }
}

async function loadInstanceForUpdate(
  tx: Txn,
  instanceId: string,
  familyId: string,
): Promise<InstanceRow> {
  const [inst] = await tx
    .select()
    .from(choreInstances)
    .where(and(eq(choreInstances.id, instanceId), eq(choreInstances.familyId, familyId)))
    .limit(1);
  if (!inst) throw new ApprovalError(404, 'not_found');
  return inst;
}

async function approveLoadedInstance(
  tx: Txn,
  args: {
    fam: FamilyRow;
    instance: InstanceRow;
    approvedByUserId: string;
  },
): Promise<{ instance: InstanceRow }> {
  const { fam, instance, approvedByUserId } = args;
  if (instance.status !== 'pending') throw new ApprovalError(409, 'not_pending');
  if (!instance.claimedByType || !instance.claimedById)
    throw new ApprovalError(409, 'no_claimant');

  const [chore] = await tx
    .select()
    .from(chores)
    .where(eq(chores.id, instance.choreId))
    .limit(1);
  if (!chore) throw new ApprovalError(404, 'chore_missing');

  const approvedAt = new Date();
  const [updated] = await tx
    .update(choreInstances)
    .set({ status: 'approved', approvedAt, approvedByUserId })
    .where(and(eq(choreInstances.id, instance.id), eq(choreInstances.status, 'pending')))
    .returning();
  if (!updated) throw new ApprovalError(409, 'not_pending');

  await tx.insert(ledgerEntries).values({
    familyId: fam.id,
    instanceId: instance.id,
    memberType: instance.claimedByType,
    memberId: instance.claimedById,
    amountCents: chore.amountCents,
    earnedAt: approvedAt,
    status: 'unpaid',
  });

  const member: Member = { type: instance.claimedByType, id: instance.claimedById };
  const approvedHourLocal = Number(
    new Intl.DateTimeFormat('en-US', {
      timeZone: fam.timezone,
      hour: '2-digit',
      hour12: false,
    })
      .format(approvedAt)
      .replace('24', '00'),
  );
  await recordXp(tx, fam.id, member, chore.amountCents, `chore:${chore.id}`);
  await bumpDailyStreak(tx, fam.id, member, approvedAt, fam.timezone);
  await evaluateBadges(tx, {
    familyId: fam.id,
    member,
    approvedAt,
    claimedAt: instance.claimedAt,
    approvedHourLocal,
  });
  await evaluateGoals(tx, {
    familyId: fam.id,
    member,
    timezone: fam.timezone,
    payoutDay: fam.payoutDay,
    payoutTime: fam.payoutTime,
  });

  return { instance: updated };
}

function handleApprovalError(e: unknown, reply: FastifyReply) {
  if (e instanceof ApprovalError) {
    return reply.code(e.status).send({ error: e.code });
  }
  throw e;
}

function principalMember(p: { kind: 'parent'; userId: string } | { kind: 'kid'; kidId: string }) {
  if (p.kind === 'kid') return { type: 'kid' as const, id: p.kidId };
  return { type: 'user' as const, id: p.userId };
}

// ---------------------------------------------------------------------------
// Public helper: spawn a chore instance "now" (called from chore route).
// ---------------------------------------------------------------------------

export async function spawnInstanceNow(
  exec: Txn,
  args: { familyId: string; chore: ChoreRow; fam: FamilyRow },
): Promise<InstanceRow> {
  const { familyId, chore, fam } = args;
  const now = new Date();
  const dueAt = nextOccurrenceAfter(chore.cadenceJson as Cadence, now, fam.timezone);
  const [inst] = await exec
    .insert(choreInstances)
    .values({
      familyId,
      choreId: chore.id,
      availableAt: now,
      dueAt,
      status: 'available',
    })
    .returning();
  return inst!;
}
