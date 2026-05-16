import type { FastifyInstance } from 'fastify';
import { and, asc, desc, eq, gte, sql, sum } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/client.js';
import { badgesAwarded, badgesCatalog, choreInstances, chores, families, kids, ledgerEntries, users, weeks } from '../db/schema.js';
import { lastPayoutMoment, nextWeekClose } from '../domain/cadence.js';
import { lifetimeStats } from '../domain/gamification.js';

export async function statsRoutes(app: FastifyInstance): Promise<void> {
  // Weekly leaderboard.
  app.get('/stats/leaderboard', async (req) => {
    const p = req.requireAnyMember();
    const [fam] = await db.select().from(families).where(eq(families.id, p.familyId)).limit(1);
    if (!fam) return { entries: [], weekStart: null, payoutAt: null };
    const start = lastPayoutMoment(new Date(), fam.timezone, fam.payoutDay, fam.payoutTime);
    const next = nextWeekClose(new Date(), fam.timezone, fam.payoutDay, fam.payoutTime);

    const rows = await db.execute<{
      member_type: 'user' | 'kid';
      member_id: string;
      total: string;
      count: string;
    }>(sql`
      select member_type, member_id,
             sum(amount_cents)::text as total,
             count(*)::text as count
      from ledger_entries
      where family_id = ${fam.id}
        and earned_at >= ${start}
      group by member_type, member_id
      order by sum(amount_cents) desc
    `);

    const ks = await db
      .select({
        id: kids.id,
        name: kids.name,
        color: kids.color,
        avatar: kids.avatar,
        gender: kids.gender,
      })
      .from(kids)
      .where(eq(kids.familyId, p.familyId));
    const us = await db
      .select({
        id: users.id,
        name: users.name,
        avatar: users.avatar,
        role: users.role,
        color: users.color,
        gender: users.gender,
      })
      .from(users)
      .where(eq(users.familyId, p.familyId));

    type LookupRow = {
      name: string;
      color?: string;
      avatar?: string | null;
      gender: 'male' | 'female' | 'unspecified';
      kind: 'kid' | 'parent';
    };
    const lookup = new Map<string, LookupRow>();
    ks.forEach((k) =>
      lookup.set(`kid:${k.id}`, {
        name: k.name,
        color: k.color,
        avatar: k.avatar,
        gender: k.gender,
        kind: 'kid',
      }),
    );
    us.forEach((u) =>
      lookup.set(`user:${u.id}`, {
        name: u.name,
        color: u.color,
        avatar: u.avatar,
        gender: u.gender,
        kind: 'parent',
      }),
    );

    const entries = rows.rows.map((r) => {
      const meta = lookup.get(`${r.member_type}:${r.member_id}`);
      return {
        memberType: r.member_type,
        memberId: r.member_id,
        name: meta?.name ?? 'Unknown',
        color: meta?.color,
        avatar: meta?.avatar ?? null,
        gender: meta?.gender ?? 'unspecified',
        amountCents: Number(r.total),
        choreCount: Number(r.count),
      };
    });

    return { entries, weekStart: start.toISOString(), payoutAt: next.toISOString() };
  });

  // Per-member stats (used by Member Dashboard).
  app.get('/stats/member/:type/:id', async (req, reply) => {
    const p = req.requireAnyMember();
    const params = z
      .object({ type: z.enum(['user', 'kid']), id: z.string().uuid() })
      .parse(req.params);
    // confirm member is in this family
    if (params.type === 'kid') {
      const [k] = await db.select().from(kids).where(eq(kids.id, params.id)).limit(1);
      if (!k || k.familyId !== p.familyId) return reply.code(404).send({ error: 'not_found' });
    } else {
      const [u] = await db.select().from(users).where(eq(users.id, params.id)).limit(1);
      if (!u || u.familyId !== p.familyId) return reply.code(404).send({ error: 'not_found' });
    }

    const stats = await lifetimeStats(p.familyId, { type: params.type, id: params.id });

    const [fam] = await db.select().from(families).where(eq(families.id, p.familyId)).limit(1);
    const weekStart = fam
      ? lastPayoutMoment(new Date(), fam.timezone, fam.payoutDay, fam.payoutTime)
      : new Date(0);

    const weekRow = await db
      .select({ s: sum(ledgerEntries.amountCents) })
      .from(ledgerEntries)
      .where(
        and(
          eq(ledgerEntries.familyId, p.familyId),
          eq(ledgerEntries.memberType, params.type),
          eq(ledgerEntries.memberId, params.id),
          gte(ledgerEntries.earnedAt, weekStart),
        ),
      );
    const weekCents = Number(weekRow[0]?.s ?? 0);

    const unpaidRow = await db
      .select({ s: sum(ledgerEntries.amountCents) })
      .from(ledgerEntries)
      .where(
        and(
          eq(ledgerEntries.familyId, p.familyId),
          eq(ledgerEntries.memberType, params.type),
          eq(ledgerEntries.memberId, params.id),
          eq(ledgerEntries.status, 'unpaid'),
        ),
      );
    const unpaidCents = Number(unpaidRow[0]?.s ?? 0);

    const recent = await db
      .select({
        id: ledgerEntries.id,
        amountCents: ledgerEntries.amountCents,
        earnedAt: ledgerEntries.earnedAt,
        choreName: chores.name,
      })
      .from(ledgerEntries)
      .innerJoin(choreInstances, eq(choreInstances.id, ledgerEntries.instanceId))
      .innerJoin(chores, eq(chores.id, choreInstances.choreId))
      .where(
        and(
          eq(ledgerEntries.familyId, p.familyId),
          eq(ledgerEntries.memberType, params.type),
          eq(ledgerEntries.memberId, params.id),
        ),
      )
      .orderBy(desc(ledgerEntries.earnedAt))
      .limit(20);

    // Badges
    const myBadges = await db
      .select({
        code: badgesCatalog.code,
        name: badgesCatalog.name,
        description: badgesCatalog.description,
        icon: badgesCatalog.icon,
        awardedAt: badgesAwarded.awardedAt,
      })
      .from(badgesAwarded)
      .innerJoin(badgesCatalog, eq(badgesCatalog.id, badgesAwarded.badgeId))
      .where(
        and(
          eq(badgesAwarded.familyId, p.familyId),
          eq(badgesAwarded.memberType, params.type),
          eq(badgesAwarded.memberId, params.id),
        ),
      )
      .orderBy(desc(badgesAwarded.awardedAt));

    return {
      stats: {
        ...stats,
        weekCents,
        unpaidCents,
      },
      recent,
      badges: myBadges,
    };
  });

  // Family-wide stats for the Family Dashboard footer.
  app.get('/stats/family', async (req) => {
    const p = req.requireAnyMember();
    const totals = await db
      .select({
        cents: sum(ledgerEntries.amountCents),
        count: sql<string>`count(*)`,
      })
      .from(ledgerEntries)
      .where(eq(ledgerEntries.familyId, p.familyId));
    return {
      lifetimeCents: Number(totals[0]?.cents ?? 0),
      lifetimeChores: Number(totals[0]?.count ?? 0),
    };
  });
}
