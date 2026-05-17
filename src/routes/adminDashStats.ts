import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';

// ---------------------------------------------------------------------------
// Whitelist
// ---------------------------------------------------------------------------
// Hardcoded on purpose. Putting this in env vars / DB has burned us before
// because dev and prod drift apart silently and you only notice when a
// production admin is locked out of their own dashboard. The list is tiny
// and rotates rarely; ship a code change when it does.
//
// Exported so the client can mirror it for UX-only purposes. The server is
// still the source of truth — see `whitelistOnly` below, which gates every
// request regardless of what the client thinks.

export const ADMIN_CONTACT_EMAIL = 'mathewharvey@gmail.com';

export const WHITELISTED_EMAILS: ReadonlySet<string> = new Set<string>([
  'mathewharvey@gmail.com',
  'jeff-assistant@agentmail.to',
]);

function isWhitelisted(email: string | undefined | null): boolean {
  if (!email) return false;
  return WHITELISTED_EMAILS.has(email.toLowerCase().trim());
}

// ---------------------------------------------------------------------------
// Rate limiter
// ---------------------------------------------------------------------------
// Trusted, tiny audience — but the dashboard auto-refreshes every 60s and
// the SQL batch isn't free. A simple per-IP token bucket is plenty.

const RATE_WINDOW_MS = 60_000;
const RATE_MAX_REQUESTS = 120; // 2/sec sustained, generous for refresh + manual presses
const rateBuckets = new Map<string, { count: number; resetAt: number }>();

function rateLimit(req: FastifyRequest, reply: FastifyReply): boolean {
  const key = (req.ip ?? 'unknown') + ':' + (req.headers['user-agent'] ?? '');
  const now = Date.now();
  const b = rateBuckets.get(key);
  if (!b || b.resetAt < now) {
    rateBuckets.set(key, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return true;
  }
  b.count += 1;
  if (b.count > RATE_MAX_REQUESTS) {
    reply.code(429).send({ error: 'rate_limited' });
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// 60s in-memory cache
// ---------------------------------------------------------------------------

type DashPayload = Awaited<ReturnType<typeof computeDashPayload>>;

let cache: { data: DashPayload; expiresAt: number } | null = null;
const CACHE_TTL_MS = 60_000;

// ---------------------------------------------------------------------------
// Daily gap-fill
// ---------------------------------------------------------------------------
// Pads a rows-by-date series so the 90-day window never has missing bars.
// Dates are bucketed in UTC; client renders them as-is.

function fillDailySeries(
  rows: Array<{ date: string; count: number }>,
  days: number,
): Array<{ date: string; count: number }> {
  const byDate = new Map(rows.map((r) => [r.date, r.count]));
  const out: Array<{ date: string; count: number }> = [];
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setUTCDate(today.getUTCDate() - i);
    const key =
      d.getUTCFullYear() +
      '-' +
      String(d.getUTCMonth() + 1).padStart(2, '0') +
      '-' +
      String(d.getUTCDate()).padStart(2, '0');
    out.push({ date: key, count: byDate.get(key) ?? 0 });
  }
  return out;
}

// ---------------------------------------------------------------------------
// SQL batch — one query per table, fanned out with Promise.all
// ---------------------------------------------------------------------------
// Domain mapping for ChoreBoard:
//   "signups"            → parent users (the `users` table; kids sign in via PIN)
//   "workspaces"         → families
//   "items / applets"    → completed chore instances (status='approved')
//   "marketplace cats"   → list kinds (shopping / todo / packing / other)
//   "top public applets" → top chore-catalog entries by total approved completions

async function computeDashPayload() {
  type Row = Record<string, unknown>;

  const [
    userTotals,
    sessionTotals,
    choreInstanceTotals,
    familyTotals,
    miscTotals,
    planRows,
    workspaceTypeRow,
    dailySignupRows,
    dailyApprovedRows,
    topChoreRows,
    recentSignupRows,
  ] = await Promise.all([
    db.execute<Row>(sql`
      SELECT
        COUNT(*)::int                                                                                     AS signups,
        COUNT(*) FILTER (WHERE created_at >= now() - interval '24 hours')::int                            AS signups_24h,
        COUNT(*) FILTER (WHERE created_at >= now() - interval '7 days')::int                              AS signups_7d,
        COUNT(*) FILTER (WHERE created_at >= now() - interval '30 days')::int                             AS signups_30d
      FROM users
    `),
    db.execute<Row>(sql`
      SELECT
        COUNT(DISTINCT user_id) FILTER (WHERE user_id IS NOT NULL AND created_at >= now() - interval '7 days')::int  AS active_7d,
        COUNT(DISTINCT user_id) FILTER (WHERE user_id IS NOT NULL AND created_at >= now() - interval '30 days')::int AS active_30d,
        COUNT(*) FILTER (WHERE expires_at > now())::int                                                              AS open_sessions
      FROM sessions
    `),
    db.execute<Row>(sql`
      SELECT
        COUNT(*) FILTER (WHERE status = 'approved')::int                                                              AS completed_total,
        COUNT(*) FILTER (WHERE status = 'approved' AND approved_at >= now() - interval '7 days')::int                 AS completed_7d,
        COUNT(*) FILTER (WHERE status = 'approved' AND approved_at >= now() - interval '30 days')::int                AS completed_30d
      FROM chore_instances
    `),
    db.execute<Row>(sql`
      SELECT
        (SELECT COUNT(*)::int FROM families)     AS workspaces,
        (SELECT COUNT(*)::int FROM kids)         AS kids,
        (SELECT COUNT(*)::int FROM chores)       AS chores,
        (SELECT COUNT(*)::int FROM milestones)   AS milestones_total
    `),
    db.execute<Row>(sql`
      SELECT
        (SELECT COUNT(*)::int FROM milestone_hits)                          AS milestone_hits_total,
        (SELECT COUNT(*)::int FROM badges_awarded)                          AS badges_awarded
    `),
    db.execute<Row>(sql`
      SELECT plan, COUNT(*)::int AS count
      FROM (
        SELECT
          f.id,
          CASE
            WHEN s.plan = 'family' AND s.status IN ('active', 'trialing') THEN 'family'
            ELSE 'free'
          END AS plan
        FROM families f
        LEFT JOIN subscriptions s ON s.family_id = f.id
      ) sub
      GROUP BY plan
      ORDER BY count DESC
    `),
    db.execute<Row>(sql`
      SELECT
        COUNT(*) FILTER (WHERE k.kid_count > 0)::int  AS family,
        COUNT(*) FILTER (WHERE k.kid_count = 0)::int  AS solo
      FROM (
        SELECT f.id, COUNT(kids.id)::int AS kid_count
        FROM families f
        LEFT JOIN kids ON kids.family_id = f.id
        GROUP BY f.id
      ) k
    `),
    db.execute<Row>(sql`
      SELECT to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS date, COUNT(*)::int AS count
      FROM users
      WHERE created_at >= now() - interval '90 days'
      GROUP BY 1
      ORDER BY 1
    `),
    db.execute<Row>(sql`
      SELECT to_char(approved_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS date, COUNT(*)::int AS count
      FROM chore_instances
      WHERE status = 'approved' AND approved_at >= now() - interval '90 days'
      GROUP BY 1
      ORDER BY 1
    `),
    db.execute<Row>(sql`
      SELECT c.name AS name, COUNT(*)::int AS installs
      FROM chore_instances ci
      INNER JOIN chores c ON c.id = ci.chore_id
      WHERE ci.status = 'approved'
      GROUP BY c.name
      ORDER BY installs DESC
      LIMIT 10
    `),
    db.execute<Row>(sql`
      SELECT
        u.email                                                AS email,
        u.name                                                 AS display_name,
        u.created_at                                           AS created_at,
        u.role                                                 AS role,
        (SELECT MAX(s.created_at) FROM sessions s WHERE s.user_id = u.id) AS last_login_at,
        f.name                                                 AS workspace_name,
        f.id                                                   AS workspace_id,
        (SELECT COUNT(*)::int FROM kids k WHERE k.family_id = f.id) AS workspace_kid_count,
        CASE
          WHEN sub.plan = 'family' AND sub.status IN ('active', 'trialing') THEN 'family'
          ELSE 'free'
        END                                                    AS plan
      FROM users u
      INNER JOIN families f ON f.id = u.family_id
      LEFT JOIN subscriptions sub ON sub.family_id = u.family_id
      ORDER BY u.created_at DESC
      LIMIT 500
    `),
  ]);

  const ut = (userTotals.rows[0] ?? {}) as Row;
  const st = (sessionTotals.rows[0] ?? {}) as Row;
  const cit = (choreInstanceTotals.rows[0] ?? {}) as Row;
  const ft = (familyTotals.rows[0] ?? {}) as Row;
  const mt = (miscTotals.rows[0] ?? {}) as Row;
  const wt = (workspaceTypeRow.rows[0] ?? {}) as Row;

  const signups = Number(ut.signups ?? 0);
  const activeUsers = Number(st.active_30d ?? 0);
  const workspaces = Number(ft.workspaces ?? 0);

  const dailySignups = fillDailySeries(
    dailySignupRows.rows.map((r) => ({
      date: String((r as Row).date),
      count: Number((r as Row).count ?? 0),
    })),
    90,
  );
  const dailyApplets = fillDailySeries(
    dailyApprovedRows.rows.map((r) => ({
      date: String((r as Row).date),
      count: Number((r as Row).count ?? 0),
    })),
    90,
  );

  return {
    generatedAt: new Date().toISOString(),
    totals: {
      signups,
      activeUsers,
      // ChoreBoard has no email-verification step; every signed-up parent
      // is considered verified. Kept in the payload so the client contract
      // doesn't change when verification lands.
      verifiedUsers: signups,
      workspaces,
      kids: Number(ft.kids ?? 0),
      chores: Number(ft.chores ?? 0),
      completedChores: Number(cit.completed_total ?? 0),
      milestones: Number(ft.milestones_total ?? 0),
      milestoneHits: Number(mt.milestone_hits_total ?? 0),
      badgesAwarded: Number(mt.badges_awarded ?? 0),
    },
    activity: {
      signups24h: Number(ut.signups_24h ?? 0),
      signups7d: Number(ut.signups_7d ?? 0),
      signups30d: Number(ut.signups_30d ?? 0),
      active7d: Number(st.active_7d ?? 0),
      active30d: Number(st.active_30d ?? 0),
      items7d: Number(cit.completed_7d ?? 0),
      items30d: Number(cit.completed_30d ?? 0),
      openSessions: Number(st.open_sessions ?? 0),
    },
    workspaceTypes: {
      family: Number(wt.family ?? 0),
      solo: Number(wt.solo ?? 0),
    },
    planDistribution: planRows.rows.map((r) => ({
      plan: String((r as Row).plan),
      count: Number((r as Row).count ?? 0),
    })),
    dailySignups,
    dailyApplets,
    topPublicApplets: topChoreRows.rows.map((r) => ({
      name: String((r as Row).name),
      icon: null as string | null,
      installs: Number((r as Row).installs ?? 0),
    })),
    recentSignups: recentSignupRows.rows.map((r) => {
      const row = r as Row;
      const lastLoginRaw = row.last_login_at as Date | string | null | undefined;
      const lastLoginAt =
        lastLoginRaw == null
          ? null
          : lastLoginRaw instanceof Date
            ? lastLoginRaw.toISOString()
            : String(lastLoginRaw);
      const createdRaw = row.created_at as Date | string;
      const createdAt =
        createdRaw instanceof Date ? createdRaw.toISOString() : String(createdRaw);
      // "Active" = had a session in the last 30 days. Used by the table's
      // status pill since ChoreBoard has no disabled-user flag.
      const isActive =
        lastLoginAt !== null &&
        Date.now() - new Date(lastLoginAt).getTime() <= 30 * 24 * 60 * 60 * 1000;
      const kidCount = Number(row.workspace_kid_count ?? 0);
      return {
        email: String(row.email),
        displayName: String(row.display_name),
        createdAt,
        lastLoginAt,
        isActive,
        emailVerified: true,
        plan: String(row.plan ?? 'free'),
        role: String(row.role ?? 'parent'),
        workspaceName: String(row.workspace_name ?? ''),
        workspaceType: kidCount > 0 ? ('family' as const) : ('solo' as const),
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export async function adminDashStatsRoutes(app: FastifyInstance): Promise<void> {
  // Both endpoints share these guards. We deliberately return 403 (not 401)
  // for "logged in but not whitelisted" so the SPA's generic auth flow
  // doesn't try to redirect to /login — the inline page handles its own
  // sign-in / access-denied states.
  const requireWhitelist = async (req: FastifyRequest, reply: FastifyReply) => {
    if (!rateLimit(req, reply)) return reply;
    const p = req.principal;
    if (!p || p.kind !== 'parent') {
      reply.code(403).send({
        error: 'not_signed_in',
        message: 'Sign in with a whitelisted admin account.',
        adminEmail: ADMIN_CONTACT_EMAIL,
      });
      return reply;
    }
    if (!isWhitelisted(p.email)) {
      reply.code(403).send({
        error: 'not_whitelisted',
        message: `${p.email} isn't on the admin allowlist.`,
        adminEmail: ADMIN_CONTACT_EMAIL,
      });
      return reply;
    }
    return undefined;
  };

  app.get('/admin/dash-stats/check', async (req, reply) => {
    const blocked = await requireWhitelist(req, reply);
    if (blocked) return blocked;
    return { ok: true, email: req.principal!.kind === 'parent' ? (req.principal as any).email : null };
  });

  app.get('/admin/dash-stats', async (req, reply) => {
    const blocked = await requireWhitelist(req, reply);
    if (blocked) return blocked;

    reply.header('Cache-Control', 'private, no-store');

    const now = Date.now();
    if (cache && cache.expiresAt > now) {
      reply.header('X-Cache', 'HIT');
      return cache.data;
    }

    const data = await computeDashPayload();
    cache = { data, expiresAt: now + CACHE_TTL_MS };
    reply.header('X-Cache', 'MISS');
    return data;
  });
}
