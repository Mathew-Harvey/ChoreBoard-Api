import { and, asc, desc, eq, lte, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  choreInstances,
  chores,
  families,
  ledgerEntries,
  scheduledJobs,
  weeks,
} from '../db/schema.js';
import {
  lastPayoutMoment,
  nextOccurrenceAfter,
  nextWeekClose,
  occurrencesBetween,
  type Cadence,
} from '../domain/cadence.js';
import { bus } from '../realtime/bus.js';

const HORIZON_DAYS = 2; // how far ahead we materialize instances
const TICK_MS = 30_000; // job poll cadence (also acts as drift safety net)

type Job = typeof scheduledJobs.$inferSelect;

class Scheduler {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  async start(): Promise<void> {
    if (this.timer) return;
    await this.bootstrap();
    this.timer = setInterval(() => {
      this.tick().catch((e) => console.error('Scheduler tick failed:', e));
    }, TICK_MS);
    // Run an initial tick right away.
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * On boot: ensure each active chore is materialized through the horizon
   * and every family has a "close_week" job pending.
   */
  private async bootstrap(): Promise<void> {
    const fams = await db.select().from(families);
    for (const fam of fams) {
      await this.materializeFamily(fam.id);
      await this.ensureWeekCloseJob(fam.id);
    }
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const now = new Date();
      const due = await db
        .select()
        .from(scheduledJobs)
        .where(and(eq(scheduledJobs.status, 'pending'), lte(scheduledJobs.runAt, now)))
        .orderBy(asc(scheduledJobs.runAt))
        .limit(50);
      for (const job of due) {
        await this.runJob(job);
      }
    } finally {
      this.running = false;
    }
  }

  private async runJob(job: Job): Promise<void> {
    try {
      if (job.kind === 'materialize_chore') {
        await this.handleMaterialize(job);
      } else if (job.kind === 'close_week') {
        await this.handleCloseWeek(job);
      }
      await db
        .update(scheduledJobs)
        .set({ status: 'done', ranAt: new Date() })
        .where(eq(scheduledJobs.id, job.id));
    } catch (err) {
      console.error('Job failed:', job.kind, job.id, err);
      await db
        .update(scheduledJobs)
        .set({ status: 'failed', ranAt: new Date(), error: String(err) })
        .where(eq(scheduledJobs.id, job.id));
    }
  }

  // ----- Materialization ----------------------------------------------------

  private async handleMaterialize(job: Job): Promise<void> {
    const payload = job.payloadJson as { choreId: string };
    const [chore] = await db.select().from(chores).where(eq(chores.id, payload.choreId)).limit(1);
    if (!chore || !chore.active) return;
    await this.materializeChore(chore.familyId, chore.id, job.id);
  }

  /**
   * Insert any missing instances for a chore from now → now+HORIZON_DAYS
   * and schedule a follow-up job at the next occurrence so we re-materialize
   * before the horizon slides past it.
   *
   * If an `available` instance for the same chore is still on the board when
   * a new renewal fires, it gets marked `missed` (spec §6).
   */
  private async materializeChore(
    familyId: string,
    choreId: string,
    currentJobId?: string,
  ): Promise<void> {
    const [fam] = await db.select().from(families).where(eq(families.id, familyId)).limit(1);
    const [chore] = await db.select().from(chores).where(eq(chores.id, choreId)).limit(1);
    if (!fam || !chore || !chore.active) return;

    const now = new Date();
    const occs = occurrencesBetween(
      chore.cadenceJson as Cadence,
      new Date(now.getTime() - 60_000), // small grace window so "right now" still spawns
      HORIZON_DAYS,
      fam.timezone,
    );

    // Pull existing future instances to avoid duplicates.
    const existing = await db
      .select({ availableAt: choreInstances.availableAt })
      .from(choreInstances)
      .where(
        and(
          eq(choreInstances.choreId, choreId),
          sql`${choreInstances.availableAt} >= ${new Date(now.getTime() - 24 * 60 * 60 * 1000)}`,
        ),
      );
    const seen = new Set(existing.map((e) => e.availableAt.getTime()));

    const toInsert = occs.filter((o) => !seen.has(o.getTime()));

    for (const occ of toInsert) {
      const dueAt = nextOccurrenceAfter(chore.cadenceJson as Cadence, occ, fam.timezone);
      const [inst] = await db
        .insert(choreInstances)
        .values({
          familyId,
          choreId,
          availableAt: occ,
          dueAt,
          status: 'available',
        })
        .returning();
      if (inst) {
        bus.publish(familyId, { type: 'instance.materialized', instanceId: inst.id });
      }
    }

    await this.markReplacedAvailableInstances(familyId, choreId, now);

    // Schedule a follow-up materialize job so we keep refilling the horizon.
    const followAt = new Date(now.getTime() + (HORIZON_DAYS - 1) * 24 * 60 * 60 * 1000);
    // Don't pile up duplicates: only schedule one pending job per chore.
    const pendingConditions = [
      eq(scheduledJobs.kind, 'materialize_chore'),
      eq(scheduledJobs.status, 'pending'),
      sql`${scheduledJobs.payloadJson} ->> 'choreId' = ${choreId}`,
    ];
    if (currentJobId) {
      pendingConditions.push(sql`${scheduledJobs.id} <> ${currentJobId}`);
    }
    const pending = await db
      .select()
      .from(scheduledJobs)
      .where(and(...pendingConditions));
    if (pending.length === 0) {
      await db.insert(scheduledJobs).values({
        familyId,
        kind: 'materialize_chore',
        runAt: followAt,
        payloadJson: { choreId },
      });
    }
  }

  private async markReplacedAvailableInstances(
    familyId: string,
    choreId: string,
    now: Date,
  ): Promise<void> {
    const [latestFired] = await db
      .select({ availableAt: choreInstances.availableAt })
      .from(choreInstances)
      .where(and(eq(choreInstances.choreId, choreId), lte(choreInstances.availableAt, now)))
      .orderBy(desc(choreInstances.availableAt))
      .limit(1);
    if (!latestFired) return;

    const stale = await db
      .select()
      .from(choreInstances)
      .where(
        and(
          eq(choreInstances.choreId, choreId),
          eq(choreInstances.status, 'available'),
          sql`${choreInstances.availableAt} < ${latestFired.availableAt}`,
        ),
      );
    for (const s of stale) {
      await db
        .update(choreInstances)
        .set({ status: 'missed' })
        .where(eq(choreInstances.id, s.id));
      bus.publish(familyId, { type: 'instance.missed', instanceId: s.id });
    }
  }

  // ----- Week close ---------------------------------------------------------

  /**
   * Make sure exactly one pending `close_week` job exists for this family.
   * Public so signup and family-settings changes can call it.
   */
  async ensureWeekCloseJob(familyId: string, currentJobId?: string): Promise<void> {
    const [fam] = await db.select().from(families).where(eq(families.id, familyId)).limit(1);
    if (!fam) return;

    const pendingConditions = [
      eq(scheduledJobs.familyId, familyId),
      eq(scheduledJobs.kind, 'close_week'),
      eq(scheduledJobs.status, 'pending'),
    ];
    if (currentJobId) {
      pendingConditions.push(sql`${scheduledJobs.id} <> ${currentJobId}`);
    }
    const pending = await db
      .select()
      .from(scheduledJobs)
      .where(and(...pendingConditions));
    if (pending.length > 0) return;

    const runAt = nextWeekClose(new Date(), fam.timezone, fam.payoutDay, fam.payoutTime);
    await db.insert(scheduledJobs).values({
      familyId,
      kind: 'close_week',
      runAt,
      payloadJson: {},
    });
  }

  private async handleCloseWeek(job: Job): Promise<void> {
    const [fam] = await db.select().from(families).where(eq(families.id, job.familyId)).limit(1);
    if (!fam) return;

    // Use the last *closed* week as our starting boundary if we have one,
    // otherwise the previous payout moment in family local time.
    const [latestWeek] = await db
      .select({ endsAt: weeks.endsAt })
      .from(weeks)
      .where(eq(weeks.familyId, fam.id))
      .orderBy(desc(weeks.endsAt))
      .limit(1);
    const weekStart =
      latestWeek?.endsAt ??
      lastPayoutMoment(new Date(), fam.timezone, fam.payoutDay, fam.payoutTime);
    const weekEnd = new Date(); // close at "now" — when the job runs

    // Insert week row.
    const [week] = await db
      .insert(weeks)
      .values({
        familyId: fam.id,
        startsAt: weekStart,
        endsAt: weekEnd,
        closedAt: new Date(),
      })
      .returning();
    if (!week) return;

    // Stamp this week onto every ledger entry earned during it.
    await db
      .update(ledgerEntries)
      .set({ weekId: week.id })
      .where(
        and(
          eq(ledgerEntries.familyId, fam.id),
          sql`${ledgerEntries.weekId} IS NULL`,
          sql`${ledgerEntries.earnedAt} >= ${weekStart}`,
          sql`${ledgerEntries.earnedAt} <= ${weekEnd}`,
        ),
      );

    // Compute champion.
    const totals = await db.execute<{
      member_type: 'user' | 'kid';
      member_id: string;
      total: string;
    }>(sql`
      select member_type, member_id, sum(amount_cents)::text as total
      from ledger_entries
      where family_id = ${fam.id} and week_id = ${week.id}
      group by member_type, member_id
      order by sum(amount_cents) desc
      limit 1
    `);
    const top = totals.rows[0];
    if (top) {
      await db
        .update(weeks)
        .set({
          championMemberType: top.member_type,
          championMemberId: top.member_id,
          championAmountCents: Number(top.total),
        })
        .where(eq(weeks.id, week.id));
    }

    bus.publish(fam.id, {
      type: 'week.closed',
      weekId: week.id,
      championMemberType: top?.member_type ?? null,
      championMemberId: top?.member_id ?? null,
      championAmountCents: top ? Number(top.total) : null,
    });

    // Queue the next close.
    await this.ensureWeekCloseJob(fam.id, job.id);
  }

  /**
   * Delete any pending `close_week` jobs for this family and queue a fresh
   * one. Called after payout-day/time/timezone changes.
   */
  async rescheduleWeekClose(familyId: string): Promise<void> {
    await db
      .delete(scheduledJobs)
      .where(
        and(
          eq(scheduledJobs.familyId, familyId),
          eq(scheduledJobs.kind, 'close_week'),
          eq(scheduledJobs.status, 'pending'),
        ),
      );
    await this.ensureWeekCloseJob(familyId);
  }

  // ----- Public entry points ------------------------------------------------

  /** Called from routes after a chore is created/updated/activated. */
  async materializeFamily(familyId: string): Promise<void> {
    const fc = await db
      .select()
      .from(chores)
      .where(and(eq(chores.familyId, familyId), eq(chores.active, true)));
    for (const c of fc) {
      await this.materializeChore(familyId, c.id);
    }
  }

  async scheduleMaterializeNow(choreId: string, familyId: string): Promise<void> {
    await db.insert(scheduledJobs).values({
      familyId,
      kind: 'materialize_chore',
      runAt: new Date(),
      payloadJson: { choreId },
    });
  }
}

export const scheduler = new Scheduler();
