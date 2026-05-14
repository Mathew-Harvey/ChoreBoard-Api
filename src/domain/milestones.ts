/**
 * Milestone evaluation.
 *
 * A milestone is a parent-defined target (cents earned or chores done) over a
 * window (this week / this month / lifetime), scoped to either the whole
 * family or a single member, paired with a custom reward like "pizza night".
 *
 * `computeProgress` figures out how far along the family/member is for a
 * given milestone in its current period. `evaluateMilestones` runs at chore
 * approval time and writes one `milestone_hits` row per (milestone,
 * period_start) the moment the bar is crossed. The unique index on
 * (milestone_id, period_start) keeps this idempotent — we can safely call
 * the evaluator on every approval without worrying about duplicate rows or
 * fan-out events.
 *
 * Scoping rules:
 *  - family-scope milestones evaluate against the sum/count of *every*
 *    ledger entry in the period. They fire when the family collectively
 *    crosses the bar, regardless of who approved which chore.
 *  - member-scope milestones evaluate against ledger entries belonging to
 *    that one member only. We only re-evaluate them when the approval was
 *    *for* that member; otherwise nothing about their progress can have
 *    changed.
 */

import { and, count, eq, gte, sum } from 'drizzle-orm';
import type { DB } from '../db/client.js';
import {
  ledgerEntries,
  milestoneHits,
  milestones,
} from '../db/schema.js';
import { bus } from '../realtime/bus.js';
import { lastPayoutMoment, startOfLocalMonth } from './cadence.js';

type Txn = DB | Parameters<Parameters<DB['transaction']>[0]>[0];
type Member = { type: 'user' | 'kid'; id: string };

export type MilestoneRow = typeof milestones.$inferSelect;
export type MilestoneHitRow = typeof milestoneHits.$inferSelect;

/**
 * Start of the current bucket for a milestone, in UTC. Used as the unique
 * key in `milestone_hits` so a given recurring milestone can only register
 * one hit per period.
 *
 * - `week`: the most recent payout cutoff. Same boundary the leaderboard
 *   uses for "this week", so a Sunday payout that closes the leaderboard
 *   also resets the milestone counter.
 * - `month`: midnight on the 1st of the local month.
 * - `lifetime`: epoch. There's only ever one bucket.
 */
export function periodStartFor(
  m: Pick<MilestoneRow, 'period'>,
  now: Date,
  family: { timezone: string; payoutDay: number; payoutTime: string },
): Date {
  switch (m.period) {
    case 'week':
      return lastPayoutMoment(now, family.timezone, family.payoutDay, family.payoutTime);
    case 'month':
      return startOfLocalMonth(now, family.timezone);
    case 'lifetime':
      return new Date(0);
  }
}

/**
 * Sum (or count) of ledger entries that count toward this milestone, since
 * `periodStart`. For lifetime milestones we still apply the (0..now] window
 * but it's effectively "all time".
 */
export async function computeProgress(
  exec: Txn,
  m: Pick<MilestoneRow, 'familyId' | 'scope' | 'memberType' | 'memberId' | 'metric'>,
  periodStart: Date,
): Promise<number> {
  const conditions = [
    eq(ledgerEntries.familyId, m.familyId),
    gte(ledgerEntries.earnedAt, periodStart),
  ];
  if (m.scope === 'member' && m.memberType && m.memberId) {
    conditions.push(eq(ledgerEntries.memberType, m.memberType));
    conditions.push(eq(ledgerEntries.memberId, m.memberId));
  }
  if (m.metric === 'cents_earned') {
    const rows = await exec
      .select({ s: sum(ledgerEntries.amountCents) })
      .from(ledgerEntries)
      .where(and(...conditions));
    return Number(rows[0]?.s ?? 0);
  }
  const rows = await exec
    .select({ c: count() })
    .from(ledgerEntries)
    .where(and(...conditions));
  return Number(rows[0]?.c ?? 0);
}

/**
 * Re-evaluate every active milestone affected by `member`'s freshly-approved
 * chore. Returns the milestones that newly crossed their target on this call
 * (each one already has a `milestone_hits` row inserted; the caller is free
 * to fan them out as a single notification batch).
 *
 * Safe to call inside the same transaction as the ledger insert — uses the
 * unique (milestone_id, period_start) index to be idempotent.
 */
export async function evaluateMilestones(
  exec: Txn,
  input: {
    familyId: string;
    member: Member;
    family: { timezone: string; payoutDay: number; payoutTime: string };
    now?: Date;
  },
): Promise<Array<{ milestone: MilestoneRow; hit: MilestoneHitRow }>> {
  const now = input.now ?? new Date();
  const all = await exec
    .select()
    .from(milestones)
    .where(
      and(eq(milestones.familyId, input.familyId), eq(milestones.active, true)),
    );

  const relevant = all.filter((m) => {
    if (m.scope === 'family') return true;
    return m.memberType === input.member.type && m.memberId === input.member.id;
  });
  if (relevant.length === 0) return [];

  const out: Array<{ milestone: MilestoneRow; hit: MilestoneHitRow }> = [];

  for (const m of relevant) {
    const periodStart = periodStartFor(m, now, input.family);
    const progress = await computeProgress(exec, m, periodStart);
    if (progress < m.targetValue) continue;

    // ON CONFLICT DO NOTHING via the (milestone_id, period_start) unique
    // index — if the row already exists for this period we just skip,
    // which means this approval bumped progress past the line in a period
    // where the milestone had already fired. No double-celebration.
    const inserted = await exec
      .insert(milestoneHits)
      .values({
        familyId: input.familyId,
        milestoneId: m.id,
        periodStart,
        hitAt: now,
        amount: progress,
      })
      .onConflictDoNothing({
        target: [milestoneHits.milestoneId, milestoneHits.periodStart],
      })
      .returning();
    const hitRow = inserted[0];
    if (!hitRow) continue;

    // One-shot milestones go inactive after their first hit. Repeating
    // milestones stay armed for next period.
    if (!m.repeats) {
      await exec
        .update(milestones)
        .set({ active: false, updatedAt: now })
        .where(eq(milestones.id, m.id));
    }

    bus.publish(input.familyId, {
      type: 'milestone.hit',
      milestoneId: m.id,
      hitId: hitRow.id,
      scope: m.scope,
      memberType: m.memberType ?? null,
      memberId: m.memberId ?? null,
    });
    out.push({ milestone: m, hit: hitRow });
  }
  return out;
}
