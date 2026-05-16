import type { FastifyInstance } from 'fastify';
import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/client.js';
import { families, kids, users } from '../db/schema.js';
import {
  lastPayoutMoment,
  startOfLocalDay,
  startOfLocalMonth,
  zonedDateToUtc,
} from '../domain/cadence.js';

type SqlFragment = ReturnType<typeof sql>;

/**
 * History dashboard endpoint.
 *
 * Single rich payload powering the "weeks gone by / all of history /
 * filtered" dashboard. Available to any signed-in family member (parent
 * or kid) and strictly scoped to `principal.familyId`. Heavy lifting is
 * done in Postgres — we hit it with three small aggregate queries plus
 * a weeks join, then resolve member/champion names in JS for display.
 *
 * Range resolution:
 *   - `preset` wins if provided (server resolves it in family timezone so
 *     "this week" lines up with the leaderboard's `lastPayoutMoment`).
 *   - else `from`/`to` (ISO datetimes) is used as a literal window.
 *   - else defaults to "this_month".
 *
 * Member filter (`memberType` + `memberId`) narrows every section to a
 * single member except `weeks` (those rows always reflect the family
 * total + champion so the table stays readable on its own).
 */

const presetSchema = z.enum([
  'this_week',
  'last_week',
  'last_4_weeks',
  'this_month',
  'last_3_months',
  'this_year',
  'all_time',
]);
type Preset = z.infer<typeof presetSchema>;

const querySchema = z.object({
  preset: presetSchema.optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  memberType: z.enum(['user', 'kid']).optional(),
  memberId: z.string().uuid().optional(),
});

type Family = typeof families.$inferSelect;

type ResolvedRange = {
  from: Date;
  to: Date;
  label: string;
  preset: Preset | 'custom';
};

export async function historyStatsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/stats/history', async (req, reply) => {
    const p = req.requireAnyMember();
    const q = querySchema.parse(req.query);

    // member filter is "all or nothing" — both fields together or neither.
    const memberFilter =
      q.memberType && q.memberId
        ? { type: q.memberType, id: q.memberId }
        : null;
    if ((q.memberType && !q.memberId) || (!q.memberType && q.memberId)) {
      return reply.code(400).send({ error: 'member_filter_incomplete' });
    }

    const [fam] = await db
      .select()
      .from(families)
      .where(eq(families.id, p.familyId))
      .limit(1);
    if (!fam) return reply.code(404).send({ error: 'family_not_found' });
    const timezone = validTimezone(fam.timezone) ? fam.timezone : 'UTC';

    const now = new Date();
    const range = resolveRange(q, fam, now, timezone);
    const rangeMs = range.to.getTime() - range.from.getTime();

    // Previous-period comparison: equal-length window immediately before
    // the current one. Skipped for `all_time` (no meaningful prior) and
    // for zero/negative spans.
    const previousRange =
      range.preset === 'all_time' || rangeMs <= 0
        ? null
        : {
            from: new Date(range.from.getTime() - rangeMs),
            to: range.from,
          };

    // Roster lookup keyed by `${type}:${id}` — used to attach name/color
    // to aggregated member rows and to weeks-table champions.
    const [kidRows, userRows] = await Promise.all([
      db
        .select({
          id: kids.id,
          name: kids.name,
          color: kids.color,
          avatar: kids.avatar,
        })
        .from(kids)
        .where(eq(kids.familyId, p.familyId)),
      db
        .select({
          id: users.id,
          name: users.name,
          color: users.color,
          avatar: users.avatar,
          role: users.role,
        })
        .from(users)
        .where(eq(users.familyId, p.familyId)),
    ]);

    type MemberMeta = {
      name: string;
      color?: string;
      avatar?: string | null;
    };
    const roster = new Map<string, MemberMeta>();
    for (const k of kidRows) {
      roster.set(`kid:${k.id}`, { name: k.name, color: k.color, avatar: k.avatar });
    }
    for (const u of userRows) {
      roster.set(`user:${u.id}`, { name: u.name, color: u.color, avatar: u.avatar });
    }

    // ---------- Aggregations -------------------------------------------------
    // We build the optional member-filter SQL fragment once and inline it
    // in every ledger query. Drizzle's `sql` template literal handles
    // parameterization for us.
    const memberFrag = memberFilter
      ? sql`and member_type = ${memberFilter.type} and member_id = ${memberFilter.id}`
      : sql``;

    // 1) Headline totals + best day (single round-trip).
    const totalsRow = await db.execute<{
      cents: string | null;
      chores: string | null;
      active_members: string | null;
      best_day: string | null;
      best_day_cents: string | null;
      best_day_chores: string | null;
    }>(sql`
      with bucketed as (
        select
          to_char(earned_at at time zone ${timezone}, 'YYYY-MM-DD') as day,
          amount_cents,
          member_type,
          member_id
        from ledger_entries
        where family_id = ${p.familyId}
          and earned_at >= ${range.from}
          and earned_at < ${range.to}
          ${memberFrag}
      ),
      by_day as (
        select day, sum(amount_cents)::bigint as cents, count(*)::bigint as chores
        from bucketed
        group by day
      ),
      best as (
        select day, cents, chores
        from by_day
        order by cents desc, day desc
        limit 1
      )
      select
        coalesce(sum(amount_cents), 0)::text as cents,
        count(*)::text as chores,
        count(distinct concat(member_type::text, ':', member_id::text))::text as active_members,
        (select day from best) as best_day,
        (select cents::text from best) as best_day_cents,
        (select chores::text from best) as best_day_chores
      from bucketed
    `);
    const totalsRaw = totalsRow.rows[0] ?? {
      cents: '0',
      chores: '0',
      active_members: '0',
      best_day: null,
      best_day_cents: null,
      best_day_chores: null,
    };
    const totalCents = Number(totalsRaw.cents ?? 0);
    const totalChores = Number(totalsRaw.chores ?? 0);
    const activeMembers = Number(totalsRaw.active_members ?? 0);

    // 2) Daily series — dense (we fill missing days with zero on the server
    //    so the chart axis stays even). Capped to ~370 days for memory.
    const daily = await fetchDailyDense(
      p.familyId,
      timezone,
      range.from,
      range.to,
      memberFrag,
    );

    // 2b) Previous-period daily series, aligned by index so the client can
    //    overlay it as ghost bars. Skipped for `all_time` (no prior window).
    const previousDaily = previousRange
      ? await fetchDailyDense(
          p.familyId,
          timezone,
          previousRange.from,
          previousRange.to,
          memberFrag,
        )
      : [];

    // 2c) Day-of-week heat — totals grouped by family-local weekday.
    //    Postgres `extract(dow ...)` returns 0=Sun..6=Sat which matches
    //    the rest of the codebase's weekday convention.
    const dowRows = await db.execute<{ dow: string; cents: string; chores: string }>(sql`
      select
        extract(dow from earned_at at time zone ${timezone})::int::text as dow,
        sum(amount_cents)::text as cents,
        count(*)::text as chores
      from ledger_entries
      where family_id = ${p.familyId}
        and earned_at >= ${range.from}
        and earned_at < ${range.to}
        ${memberFrag}
      group by dow
    `);
    const byDayOfWeek: Array<{ dow: number; cents: number; chores: number }> =
      Array.from({ length: 7 }, (_, i) => ({ dow: i, cents: 0, chores: 0 }));
    for (const r of dowRows.rows) {
      const idx = Number(r.dow);
      if (idx >= 0 && idx <= 6) {
        byDayOfWeek[idx] = {
          dow: idx,
          cents: Number(r.cents),
          chores: Number(r.chores),
        };
      }
    }

    // 3) Member leaderboard for the range.
    const memberRows = await db.execute<{
      member_type: 'user' | 'kid';
      member_id: string;
      cents: string;
      chores: string;
    }>(sql`
      select
        member_type,
        member_id,
        sum(amount_cents)::text as cents,
        count(*)::text as chores
      from ledger_entries
      where family_id = ${p.familyId}
        and earned_at >= ${range.from}
        and earned_at < ${range.to}
        ${memberFrag}
      group by member_type, member_id
      order by sum(amount_cents) desc
    `);
    const byMember = memberRows.rows.map((r) => {
      const meta = roster.get(`${r.member_type}:${r.member_id}`);
      return {
        memberType: r.member_type,
        memberId: r.member_id,
        name: meta?.name ?? 'Removed member',
        color: meta?.color,
        avatar: meta?.avatar ?? null,
        cents: Number(r.cents),
        chores: Number(r.chores),
      };
    });

    // 4) Top chores in range. Schema cascades chore deletes through
    //    instances → ledger, so a chore row should always exist for any
    //    ledger entry that matches.
    const choreRows = await db.execute<{
      chore_id: string;
      chore_name: string;
      cents: string;
      count: string;
    }>(sql`
      select
        c.id as chore_id,
        c.name as chore_name,
        sum(le.amount_cents)::text as cents,
        count(*)::text as count
      from ledger_entries le
      join chore_instances ci on ci.id = le.instance_id
      join chores c on c.id = ci.chore_id
      where le.family_id = ${p.familyId}
        and le.earned_at >= ${range.from}
        and le.earned_at < ${range.to}
        ${memberFilter
          ? sql`and le.member_type = ${memberFilter.type} and le.member_id = ${memberFilter.id}`
          : sql``}
      group by c.id, c.name
      order by sum(le.amount_cents) desc
      limit 10
    `);
    const byChore = choreRows.rows.map((r) => ({
      choreId: r.chore_id,
      name: r.chore_name,
      cents: Number(r.cents),
      count: Number(r.count),
    }));

    // 5) Status breakdown over completed instances in range. We use
    //    `coalesce(approved_at, completed_at, due_at, available_at)` so
    //    each lifecycle event lands on the timestamp it's defined by.
    //    Approved/missed/rejected only — pending/claimed/available are
    //    "in flight" and meaningless for historical analysis.
    const statusRows = await db.execute<{ status: string; n: string }>(sql`
      select status::text as status, count(*)::text as n
      from chore_instances
      where family_id = ${p.familyId}
        and status::text in ('approved', 'missed', 'rejected')
        and coalesce(approved_at, completed_at, due_at, available_at) >= ${range.from}
        and coalesce(approved_at, completed_at, due_at, available_at) < ${range.to}
        ${memberFilter
          ? sql`and claimed_by_type = ${memberFilter.type} and claimed_by_id = ${memberFilter.id}`
          : sql``}
      group by status
    `);
    const statusBreakdown = { approved: 0, missed: 0, rejected: 0 };
    for (const r of statusRows.rows) {
      const key = r.status as keyof typeof statusBreakdown;
      if (key in statusBreakdown) statusBreakdown[key] = Number(r.n);
    }

    // 6) Weeks-gone-by table. Loose overlap with the range (any closed
    //    week whose [starts_at, ends_at) touches the window). Per-row
    //    totals reflect the member filter when one is set, so a kid's
    //    "history" page lists their personal weekly take.
    const weekRows = await db.execute<{
      id: string;
      starts_at: Date;
      ends_at: Date;
      closed_at: Date | null;
      champion_member_type: 'user' | 'kid' | null;
      champion_member_id: string | null;
      champion_amount_cents: number | null;
      total_cents: string;
      chore_count: string;
    }>(sql`
      select
        w.id,
        w.starts_at,
        w.ends_at,
        w.closed_at,
        w.champion_member_type,
        w.champion_member_id,
        w.champion_amount_cents,
        coalesce(sum(le.amount_cents), 0)::text as total_cents,
        count(le.id)::text as chore_count
      from weeks w
      left join ledger_entries le
        on le.week_id = w.id
       and le.family_id = w.family_id
       ${memberFilter
          ? sql`and le.member_type = ${memberFilter.type} and le.member_id = ${memberFilter.id}`
          : sql``}
      where w.family_id = ${p.familyId}
        and w.starts_at < ${range.to}
        and w.ends_at >= ${range.from}
      group by
        w.id,
        w.starts_at,
        w.ends_at,
        w.closed_at,
        w.champion_member_type,
        w.champion_member_id,
        w.champion_amount_cents
      order by w.starts_at desc
      limit 26
    `);
    const weeksOut = weekRows.rows.map((w) => {
      const championKey =
        w.champion_member_type && w.champion_member_id
          ? `${w.champion_member_type}:${w.champion_member_id}`
          : null;
      const championMeta = championKey ? roster.get(championKey) : undefined;
      return {
        id: w.id,
        startsAt: w.starts_at.toISOString(),
        endsAt: w.ends_at.toISOString(),
        closedAt: w.closed_at ? w.closed_at.toISOString() : null,
        championMemberType: w.champion_member_type,
        championMemberId: w.champion_member_id,
        championAmountCents: w.champion_amount_cents,
        championName: championMeta?.name ?? null,
        championColor: championMeta?.color ?? null,
        totalCents: Number(w.total_cents),
        choreCount: Number(w.chore_count),
      };
    });

    // 7) Previous-period totals for the delta pill. One small round-trip;
    //    null when previousRange is null.
    let previousCents: number | null = null;
    let previousChores: number | null = null;
    if (previousRange) {
      const prevRow = await db.execute<{ cents: string | null; chores: string | null }>(sql`
        select
          coalesce(sum(amount_cents), 0)::text as cents,
          count(*)::text as chores
        from ledger_entries
        where family_id = ${p.familyId}
          and earned_at >= ${previousRange.from}
          and earned_at < ${previousRange.to}
          ${memberFrag}
      `);
      previousCents = Number(prevRow.rows[0]?.cents ?? 0);
      previousChores = Number(prevRow.rows[0]?.chores ?? 0);
    }

    // 8) Highlights — best week in range (top by total cents), biggest
    //    single approved chore (top ledger entry), and most-repeated
    //    chore in range. All three pull from data we've already touched
    //    so they stay cheap.
    const bestWeek =
      weeksOut.length > 0
        ? [...weeksOut].sort((a, b) => b.totalCents - a.totalCents)[0] ?? null
        : null;

    const biggestRow = await db.execute<{
      id: string;
      amount_cents: number;
      earned_at: Date;
      member_type: 'user' | 'kid';
      member_id: string;
      chore_id: string;
      chore_name: string;
    }>(sql`
      select
        le.id, le.amount_cents, le.earned_at,
        le.member_type, le.member_id,
        c.id as chore_id, c.name as chore_name
      from ledger_entries le
      join chore_instances ci on ci.id = le.instance_id
      join chores c on c.id = ci.chore_id
      where le.family_id = ${p.familyId}
        and le.earned_at >= ${range.from}
        and le.earned_at < ${range.to}
        ${memberFilter
          ? sql`and le.member_type = ${memberFilter.type} and le.member_id = ${memberFilter.id}`
          : sql``}
      order by le.amount_cents desc, le.earned_at desc
      limit 1
    `);
    const big = biggestRow.rows[0];
    const biggestSingle = big
      ? (() => {
          const meta = roster.get(`${big.member_type}:${big.member_id}`);
          return {
            ledgerId: big.id,
            choreId: big.chore_id,
            choreName: big.chore_name,
            memberType: big.member_type,
            memberId: big.member_id,
            memberName: meta?.name ?? 'Removed member',
            memberColor: meta?.color ?? null,
            cents: big.amount_cents,
            earnedAt: big.earned_at.toISOString(),
          };
        })()
      : null;

    const mostRepeatedRow = await db.execute<{
      chore_id: string;
      chore_name: string;
      count: string;
      cents: string;
    }>(sql`
      select
        c.id as chore_id,
        c.name as chore_name,
        count(*)::text as count,
        sum(le.amount_cents)::text as cents
      from ledger_entries le
      join chore_instances ci on ci.id = le.instance_id
      join chores c on c.id = ci.chore_id
      where le.family_id = ${p.familyId}
        and le.earned_at >= ${range.from}
        and le.earned_at < ${range.to}
        ${memberFilter
          ? sql`and le.member_type = ${memberFilter.type} and le.member_id = ${memberFilter.id}`
          : sql``}
      group by c.id, c.name
      order by count(*) desc, sum(le.amount_cents) desc
      limit 1
    `);
    const rep = mostRepeatedRow.rows[0];
    const mostRepeated = rep
      ? {
          choreId: rep.chore_id,
          name: rep.chore_name,
          count: Number(rep.count),
          cents: Number(rep.cents),
        }
      : null;

    const deltaCents =
      previousCents == null ? null : totalCents - previousCents;
    const deltaPct =
      previousCents == null || previousCents === 0
        ? null
        : (totalCents - previousCents) / previousCents;

    const bestDay =
      totalsRaw.best_day && totalsRaw.best_day_cents
        ? {
            date: totalsRaw.best_day,
            cents: Number(totalsRaw.best_day_cents),
            chores: Number(totalsRaw.best_day_chores ?? 0),
          }
        : null;

    const days = Math.max(
      1,
      Math.round((range.to.getTime() - range.from.getTime()) / 86_400_000),
    );

    return {
      range: {
        from: range.from.toISOString(),
        to: range.to.toISOString(),
        days,
        label: range.label,
        preset: range.preset,
      },
      previousRange: previousRange
        ? {
            from: previousRange.from.toISOString(),
            to: previousRange.to.toISOString(),
          }
        : null,
      totals: {
        cents: totalCents,
        chores: totalChores,
        activeMembers,
        avgPerChoreCents:
          totalChores > 0 ? Math.round(totalCents / totalChores) : 0,
        avgPerDayCents: Math.round(totalCents / days),
        bestDay,
        previousCents,
        previousChores,
        deltaCents,
        deltaPct,
      },
      daily,
      previousDaily,
      byDayOfWeek,
      byMember,
      byChore,
      weeks: weeksOut,
      statusBreakdown,
      highlights: {
        bestWeek,
        biggestSingle,
        mostRepeated,
      },
    };
  });

  // CSV export — daily series for the same filters. The export is
  // intentionally narrow (one row per day) because that's what a
  // spreadsheet user typically wants to graph; richer per-entry detail
  // already lives at /api/ledger.csv (parent-only). This one is
  // available to any family member, scoped to their family.
  app.get('/stats/history.csv', async (req, reply) => {
    const p = req.requireAnyMember();
    const q = querySchema.parse(req.query);
    if ((q.memberType && !q.memberId) || (!q.memberType && q.memberId)) {
      return reply.code(400).send({ error: 'member_filter_incomplete' });
    }
    const [fam] = await db
      .select()
      .from(families)
      .where(eq(families.id, p.familyId))
      .limit(1);
    if (!fam) return reply.code(404).send({ error: 'family_not_found' });
    const timezone = validTimezone(fam.timezone) ? fam.timezone : 'UTC';

    const now = new Date();
    const range = resolveRange(q, fam, now, timezone);
    const memberFrag =
      q.memberType && q.memberId
        ? sql`and member_type = ${q.memberType} and member_id = ${q.memberId}`
        : sql``;

    const daily = await fetchDailyDense(
      p.familyId,
      timezone,
      range.from,
      range.to,
      memberFrag,
    );

    const fromStr = range.from.toISOString().slice(0, 10);
    const toStr = range.to.toISOString().slice(0, 10);
    const memberSlug =
      q.memberType && q.memberId
        ? `-${q.memberType}-${q.memberId.slice(0, 8)}`
        : '';
    const filename = `choreboard-history-${fromStr}-to-${toStr}${memberSlug}.csv`;

    const lines = [
      'date,cents,dollars,chores',
      ...daily.map((d) =>
        [d.date, d.cents, (d.cents / 100).toFixed(2), d.chores].join(','),
      ),
    ];
    reply.header('Content-Type', 'text/csv; charset=utf-8');
    reply.header('Content-Disposition', `attachment; filename="${filename}"`);
    return lines.join('\n');
  });
}

/**
 * Dense daily series for the given (family, range, memberFilter). Returns
 * one row per local day in [from, to], with zeros for days that had no
 * earnings. Capped at 370 rows — for `all_time` queries we keep the
 * tail (the most recent year) since that's what the chart shows.
 */
async function fetchDailyDense(
  familyId: string,
  timezone: string,
  from: Date,
  to: Date,
  memberFrag: SqlFragment,
): Promise<Array<{ date: string; cents: number; chores: number }>> {
  const rows = await db.execute<{ day: string; cents: string; chores: string }>(sql`
    select
      to_char(earned_at at time zone ${timezone}, 'YYYY-MM-DD') as day,
      sum(amount_cents)::text as cents,
      count(*)::text as chores
    from ledger_entries
    where family_id = ${familyId}
      and earned_at >= ${from}
      and earned_at < ${to}
      ${memberFrag}
    group by day
    order by day asc
  `);
  const sparse = new Map<string, { cents: number; chores: number }>();
  for (const r of rows.rows) {
    sparse.set(r.day, { cents: Number(r.cents), chores: Number(r.chores) });
  }
  return densifyDaily({ from, to }, timezone, sparse, 370);
}

// ---------------------------------------------------------------------------
// Range resolution
// ---------------------------------------------------------------------------

function resolveRange(
  q: z.infer<typeof querySchema>,
  fam: Family,
  now: Date,
  timezone = fam.timezone,
): ResolvedRange {
  if (q.preset) {
    return rangeForPreset(q.preset, fam, now, timezone);
  }
  if (q.from || q.to) {
    const from = q.from ? new Date(q.from) : startOfLocalMonth(now, timezone);
    const to = q.to ? new Date(q.to) : now;
    return { from, to, label: 'Custom range', preset: 'custom' };
  }
  return rangeForPreset('this_month', fam, now, timezone);
}

function rangeForPreset(
  preset: Preset,
  fam: Family,
  now: Date,
  timezone = fam.timezone,
): ResolvedRange {
  const tz = timezone;
  switch (preset) {
    case 'this_week': {
      const from = lastPayoutMoment(now, tz, fam.payoutDay, fam.payoutTime);
      return { from, to: now, label: 'This week', preset };
    }
    case 'last_week': {
      const thisWeekStart = lastPayoutMoment(
        now,
        tz,
        fam.payoutDay,
        fam.payoutTime,
      );
      // The instant before `thisWeekStart` is unambiguously in last week,
      // so walking the payout helper back once gives us the prior payout
      // moment and avoids hard-coding 7×86_400_000 (DST-safe).
      const lastWeekStart = lastPayoutMoment(
        new Date(thisWeekStart.getTime() - 1),
        tz,
        fam.payoutDay,
        fam.payoutTime,
      );
      return {
        from: lastWeekStart,
        to: thisWeekStart,
        label: 'Last week',
        preset,
      };
    }
    case 'last_4_weeks': {
      const thisWeekStart = lastPayoutMoment(
        now,
        tz,
        fam.payoutDay,
        fam.payoutTime,
      );
      // Walk four payout cycles back without assuming exact 7×24h slabs.
      let cursor = thisWeekStart;
      for (let i = 0; i < 4; i++) {
        cursor = lastPayoutMoment(
          new Date(cursor.getTime() - 1),
          tz,
          fam.payoutDay,
          fam.payoutTime,
        );
      }
      return { from: cursor, to: now, label: 'Last 4 weeks', preset };
    }
    case 'this_month': {
      const from = startOfLocalMonth(now, tz);
      return { from, to: now, label: 'This month', preset };
    }
    case 'last_3_months': {
      const thisMonthStart = startOfLocalMonth(now, tz);
      const partsBackThree = monthsBack(thisMonthStart, tz, 3);
      return {
        from: partsBackThree,
        to: now,
        label: 'Last 3 months',
        preset,
      };
    }
    case 'this_year': {
      // Jan 1, 00:00 family local.
      const year = localYear(now, tz);
      const from = zonedDateToUtc(year, 1, 1, 0, 0, tz);
      return { from, to: now, label: 'This year', preset };
    }
    case 'all_time': {
      return {
        from: new Date(0),
        to: now,
        label: 'All time',
        preset,
      };
    }
  }
}

function monthsBack(monthStartUtc: Date, timezone: string, months: number): Date {
  // monthStartUtc is the UTC instant of "1st of some month, 00:00 family TZ".
  // We pull out the family-local year/month, subtract `months`, and rebuild.
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
  });
  const parts: Record<string, string> = {};
  for (const p of fmt.formatToParts(monthStartUtc)) {
    if (p.type !== 'literal') parts[p.type] = p.value;
  }
  const y = Number(parts.year);
  const m = Number(parts.month);
  // Compute target year/month with wrap.
  const total = y * 12 + (m - 1) - months;
  const ty = Math.floor(total / 12);
  const tm = (total % 12) + 1;
  return zonedDateToUtc(ty, tm, 1, 0, 0, timezone);
}

function localYear(d: Date, timezone: string): number {
  return Number(
    new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
    }).format(d),
  );
}

function validTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Daily densifier
// ---------------------------------------------------------------------------

/**
 * Build a contiguous list of `{date, cents, chores}` entries from the
 * sparse Postgres aggregation, filling gaps with zeros. Capped at
 * `maxDays` so unbounded "all_time" ranges don't explode JSON payloads —
 * if the cap kicks in we return only the last `maxDays` days, which is
 * what the chart wants to render anyway.
 */
function densifyDaily(
  range: { from: Date; to: Date },
  timezone: string,
  sparse: Map<string, { cents: number; chores: number }>,
  maxDays: number,
): Array<{ date: string; cents: number; chores: number }> {
  const out: Array<{ date: string; cents: number; chores: number }> = [];
  // Start at the local-day boundary that contains range.from, end at the
  // local-day boundary that contains range.to. We iterate by adding 24h
  // and reformatting in zone — DST transitions only ever shift by ±1h,
  // which never crosses a date boundary at noon.
  const startLocal = startOfLocalDay(range.from, timezone);
  const endLocal = startOfLocalDay(range.to, timezone);
  let cursor = startLocal.getTime();
  // +1 day so the day containing `range.to` is included.
  const endTime = endLocal.getTime() + 86_400_000;
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  // Anchor at noon-UTC so DST never tips us into the wrong day.
  while (cursor < endTime) {
    const probe = new Date(cursor + 12 * 3_600_000);
    const date = fmt.format(probe); // YYYY-MM-DD
    const hit = sparse.get(date);
    out.push({
      date,
      cents: hit?.cents ?? 0,
      chores: hit?.chores ?? 0,
    });
    cursor += 86_400_000;
  }
  if (out.length > maxDays) {
    return out.slice(out.length - maxDays);
  }
  return out;
}
