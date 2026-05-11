import { and, count, eq, isNull, sql, sum } from 'drizzle-orm';
import { db, type DB } from '../db/client.js';
import {
  badgesAwarded,
  badgesCatalog,
  goals,
  ledgerEntries,
  streaks,
  xpLog,
} from '../db/schema.js';
import { bus } from '../realtime/bus.js';
import type { BadgeRule } from './badges.js';
import { lastPayoutMoment, localDayKey } from './cadence.js';
import { levelForXp } from './xp.js';

type Member = { type: 'user' | 'kid'; id: string };
/**
 * Drizzle transactions narrow `db.transaction(tx => ...)` to a subset of the
 * full `DB` type. All helpers accept either so that approval-time side
 * effects can run inside the same transaction as the chore mutation.
 */
type Txn = DB | Parameters<Parameters<DB['transaction']>[0]>[0];

export async function recordXp(
  exec: Txn,
  familyId: string,
  member: Member,
  delta: number,
  reason: string,
): Promise<void> {
  if (delta <= 0) return;
  const beforeRows = await exec
    .select({ total: sum(xpLog.delta) })
    .from(xpLog)
    .where(
      and(
        eq(xpLog.familyId, familyId),
        eq(xpLog.memberType, member.type),
        eq(xpLog.memberId, member.id),
      ),
    );
  const before = Number(beforeRows[0]?.total ?? 0);
  await exec.insert(xpLog).values({
    familyId,
    memberType: member.type,
    memberId: member.id,
    delta,
    reason,
  });
  const beforeLevel = levelForXp(before).level;
  const afterLevel = levelForXp(before + delta).level;
  if (afterLevel > beforeLevel) {
    bus.publish(familyId, {
      type: 'level.up',
      memberType: member.type,
      memberId: member.id,
      level: afterLevel,
    });
  }
}

export async function bumpDailyStreak(
  exec: Txn,
  familyId: string,
  member: Member,
  approvedAt: Date,
  timezone: string,
): Promise<void> {
  const day = localDayKey(approvedAt, timezone);
  const [existing] = await exec
    .select()
    .from(streaks)
    .where(
      and(
        eq(streaks.familyId, familyId),
        eq(streaks.memberType, member.type),
        eq(streaks.memberId, member.id),
        eq(streaks.kind, 'daily'),
      ),
    )
    .limit(1);

  if (!existing) {
    await exec.insert(streaks).values({
      familyId,
      memberType: member.type,
      memberId: member.id,
      kind: 'daily',
      length: 1,
      lastDay: day,
      bestLength: 1,
    });
    return;
  }
  if (existing.lastDay === day) return;

  const yesterdayMs = new Date(approvedAt.getTime() - 24 * 60 * 60 * 1000);
  const yesterday = localDayKey(yesterdayMs, timezone);
  const newLength = existing.lastDay === yesterday ? existing.length + 1 : 1;
  await exec
    .update(streaks)
    .set({
      length: newLength,
      lastDay: day,
      bestLength: Math.max(existing.bestLength, newLength),
    })
    .where(eq(streaks.id, existing.id));
}

// ---------------------------------------------------------------------------
// Badge evaluation
// ---------------------------------------------------------------------------

export async function evaluateBadges(
  exec: Txn,
  input: {
    familyId: string;
    member: Member;
    approvedAt: Date;
    claimedAt: Date | null;
    approvedHourLocal: number;
  },
): Promise<string[]> {
  const awarded: string[] = [];
  const allBadges = await exec.select().from(badgesCatalog);
  const myAwards = await exec
    .select({ badgeId: badgesAwarded.badgeId })
    .from(badgesAwarded)
    .where(
      and(
        eq(badgesAwarded.familyId, input.familyId),
        eq(badgesAwarded.memberType, input.member.type),
        eq(badgesAwarded.memberId, input.member.id),
      ),
    );
  const have = new Set(myAwards.map((a) => a.badgeId));

  const lifetimeChoresRow = await exec
    .select({ c: count() })
    .from(ledgerEntries)
    .where(
      and(
        eq(ledgerEntries.familyId, input.familyId),
        eq(ledgerEntries.memberType, input.member.type),
        eq(ledgerEntries.memberId, input.member.id),
      ),
    );
  const lifetimeChores = Number(lifetimeChoresRow[0]?.c ?? 0);

  const lifetimeCentsRow = await exec
    .select({ s: sum(ledgerEntries.amountCents) })
    .from(ledgerEntries)
    .where(
      and(
        eq(ledgerEntries.familyId, input.familyId),
        eq(ledgerEntries.memberType, input.member.type),
        eq(ledgerEntries.memberId, input.member.id),
      ),
    );
  const lifetimeCents = Number(lifetimeCentsRow[0]?.s ?? 0);

  for (const b of allBadges) {
    if (have.has(b.id)) continue;
    const rule = b.ruleJson as BadgeRule;
    let hit = false;
    switch (rule.kind) {
      case 'first_chore':
        hit = lifetimeChores >= 1;
        break;
      case 'lifetime_chores':
        hit = lifetimeChores >= rule.n;
        break;
      case 'lifetime_cents':
        hit = lifetimeCents >= rule.n;
        break;
      case 'approved_before':
        hit = input.approvedHourLocal < rule.hour;
        break;
      case 'approved_after':
        hit = input.approvedHourLocal >= rule.hour;
        break;
      case 'speed': {
        if (input.claimedAt) {
          const diff = (input.approvedAt.getTime() - input.claimedAt.getTime()) / 1000;
          hit = diff <= rule.seconds;
        }
        break;
      }
    }
    if (hit) {
      await exec.insert(badgesAwarded).values({
        familyId: input.familyId,
        memberType: input.member.type,
        memberId: input.member.id,
        badgeId: b.id,
      });
      awarded.push(b.code);
      bus.publish(input.familyId, {
        type: 'badge.awarded',
        memberType: input.member.type,
        memberId: input.member.id,
        badgeCode: b.code,
      });
    }
  }
  return awarded;
}

export async function ensureBadgeCatalogSeeded(): Promise<void> {
  const { SEED_BADGES } = await import('./badges.js');
  const existing = await db.select({ code: badgesCatalog.code }).from(badgesCatalog);
  const have = new Set(existing.map((e) => e.code));
  for (const b of SEED_BADGES) {
    if (have.has(b.code)) continue;
    await db.insert(badgesCatalog).values({
      code: b.code,
      name: b.name,
      description: b.description,
      icon: b.icon,
      ruleJson: b.rule,
    });
  }
}

// ---------------------------------------------------------------------------
// Goal progress
// ---------------------------------------------------------------------------

/**
 * Compute (and persist `hit_at` on) any of this member's active goals that
 * are now satisfied. Returns the goals that newly hit.
 */
export async function evaluateGoals(
  exec: Txn,
  input: {
    familyId: string;
    member: Member;
    timezone: string;
    payoutDay: number;
    payoutTime: string;
  },
): Promise<Array<{ id: string; name: string; targetCents: number; basis: string }>> {
  const rows = await exec
    .select()
    .from(goals)
    .where(
      and(
        eq(goals.familyId, input.familyId),
        eq(goals.memberType, input.member.type),
        eq(goals.memberId, input.member.id),
        isNull(goals.hitAt),
      ),
    );
  if (rows.length === 0) return [];

  const payoutCutoff = lastPayoutMoment(
    new Date(),
    input.timezone,
    input.payoutDay,
    input.payoutTime,
  );

  const weekUnpaid = await exec
    .select({ s: sum(ledgerEntries.amountCents) })
    .from(ledgerEntries)
    .where(
      and(
        eq(ledgerEntries.familyId, input.familyId),
        eq(ledgerEntries.memberType, input.member.type),
        eq(ledgerEntries.memberId, input.member.id),
        sql`(${ledgerEntries.earnedAt} >= ${payoutCutoff} OR ${ledgerEntries.status} = 'unpaid')`,
      ),
    );
  const lifetime = await exec
    .select({ s: sum(ledgerEntries.amountCents) })
    .from(ledgerEntries)
    .where(
      and(
        eq(ledgerEntries.familyId, input.familyId),
        eq(ledgerEntries.memberType, input.member.type),
        eq(ledgerEntries.memberId, input.member.id),
      ),
    );
  const weekUnpaidCents = Number(weekUnpaid[0]?.s ?? 0);
  const lifetimeCents = Number(lifetime[0]?.s ?? 0);

  const hit: Array<{ id: string; name: string; targetCents: number; basis: string }> = [];
  for (const g of rows) {
    const progress = g.basis === 'lifetime' ? lifetimeCents : weekUnpaidCents;
    if (progress >= g.targetCents) {
      await exec.update(goals).set({ hitAt: new Date() }).where(eq(goals.id, g.id));
      hit.push({ id: g.id, name: g.name, targetCents: g.targetCents, basis: g.basis });
      bus.publish(input.familyId, {
        type: 'goal.hit',
        goalId: g.id,
        memberType: input.member.type,
        memberId: input.member.id,
      });
    }
  }
  return hit;
}

export async function lifetimeStats(familyId: string, member: Member) {
  const totals = await db
    .select({
      cents: sum(ledgerEntries.amountCents),
      count: count(),
    })
    .from(ledgerEntries)
    .where(
      and(
        eq(ledgerEntries.familyId, familyId),
        eq(ledgerEntries.memberType, member.type),
        eq(ledgerEntries.memberId, member.id),
      ),
    );
  const xpRows = await db
    .select({ xp: sum(xpLog.delta) })
    .from(xpLog)
    .where(
      and(
        eq(xpLog.familyId, familyId),
        eq(xpLog.memberType, member.type),
        eq(xpLog.memberId, member.id),
      ),
    );
  const streakRows = await db
    .select()
    .from(streaks)
    .where(
      and(
        eq(streaks.familyId, familyId),
        eq(streaks.memberType, member.type),
        eq(streaks.memberId, member.id),
        eq(streaks.kind, 'daily'),
      ),
    );
  const badgeRows = await db
    .select({ c: count() })
    .from(badgesAwarded)
    .where(
      and(
        eq(badgesAwarded.familyId, familyId),
        eq(badgesAwarded.memberType, member.type),
        eq(badgesAwarded.memberId, member.id),
      ),
    );

  const xp = Number(xpRows[0]?.xp ?? 0);
  const level = levelForXp(xp);
  return {
    lifetimeCents: Number(totals[0]?.cents ?? 0),
    lifetimeChores: Number(totals[0]?.count ?? 0),
    xp,
    level: level.level,
    intoLevel: level.intoLevel,
    nextLevelAt: level.nextAt,
    streak: streakRows[0]?.length ?? 0,
    bestStreak: streakRows[0]?.bestLength ?? 0,
    badgeCount: Number(badgeRows[0]?.c ?? 0),
  };
}
