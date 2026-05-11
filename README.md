# ChoreBoard API

Backend for ChoreBoard — a family-dashboard SaaS where members claim and complete
household chores in a shared real-time view. See `spec.md` for the v1 product spec.

## Stack

- Node.js + **Fastify**
- **Drizzle ORM** on **Postgres**
- **Argon2id** password & PIN hashing
- HTTP-only cookie sessions (no JWTs)
- In-process job runner for chore renewals + weekly payouts (no Redis)
- **SSE** for real-time fan-out, one stream per session

Single deploy: this server can also serve the built web client (set `WEB_DIST_DIR`).

## Project layout

```
src/
  config.ts            env loading + flags
  server.ts            Fastify bootstrap, route registration, scheduler start
  db/
    schema.ts          all tables from spec §13
    client.ts          drizzle/pg pool
    migrate.ts         runs migrations from /drizzle
  auth/
    password.ts        argon2 hash/verify (passwords + 4-digit PINs)
    sessions.ts        opaque-token sessions row CRUD
    plugin.ts          Fastify plugin: resolves req.principal, guards, cookies
  domain/
    cadence.ts         cadence math (timezone-aware), week boundaries
    defaultCatalog.ts  the seeded catalog from spec §5
    badges.ts          seed badge definitions
    gamification.ts    XP, streaks, badge evaluation, lifetime stats
    xp.ts              XP curve / level naming
  scheduler/
    runner.ts          materialize chore instances, weekly close
  realtime/
    bus.ts             in-process per-family pub/sub for SSE
  routes/
    auth.ts            signup/login/logout, kid PIN login, /me
    family.ts          family settings + kids CRUD
    chores.ts          chore catalog CRUD
    board.ts           Kanban actions: claim/submit/approve/reject
    stats.ts           leaderboard + member stats + family totals
    ledger.ts          ledger entries, pay marking, CSV export
    goals.ts           per-member $ goals
    sse.ts             /api/events stream
```

## Setup

1. Install Node 20+ and a Postgres 14+ instance.
2. `npm install`
3. Copy `.env.example` → `.env` and fill in `DATABASE_URL` (the others have sane dev defaults).
4. Generate and apply migrations:

```bash
npm run db:generate   # only needed when you change src/db/schema.ts
npm run db:push       # quick path: pushes schema directly (dev only)
# or:
npm run db:migrate    # apply versioned migrations from /drizzle
```

5. Start the dev server:

```bash
npm run dev
```

The API is at `http://localhost:4000`. CORS is open to `WEB_ORIGIN` (default
`http://localhost:5173`, the Vite dev server).

## Auth flow

- **Parent signup** `POST /api/auth/signup` — creates a family, seeds the
  default chore catalog from spec §5, makes the user the **owner**, and starts
  a cookie session.
- **Parent login** `POST /api/auth/login`.
- **Kid PIN login** — the device first calls `GET /api/auth/family/:id/kids`
  to list kid avatars, then `POST /api/auth/kid-login` with `{ kidId, pin }`.
- **Whoami** `GET /api/auth/me`.
- **Logout** `POST /api/auth/logout`.

`req.principal` is `{ kind: "parent" | "kid", ... }`. Routes use
`req.requireParent()` or `req.requireAnyMember()` to enforce access.

## The board

`GET /api/board` returns everything the Kanban needs: instances (available
through ~12 h ahead, plus everything claimed/pending/approved today), kids,
and parents. The Kanban state machine:

```
available  →  claimed  →  pending  →  approved
                   ↑                  ↑ writes ledger entry,
        (drag back to                  XP, streak, badge sweep
        available;
        Parent can also "reject"
        a pending one back to claimed)
```

Endpoints: `POST /api/board/instances/:id/{claim,unclaim,submit,approve,reject}`.

## The scheduler

`src/scheduler/runner.ts` polls `scheduled_jobs` every 30s and runs anything
past `run_at`. There are two job kinds:

- `materialize_chore`: insert any missing instances for a chore through the
  horizon (HORIZON_DAYS = 2). If an `available` instance is still on the board
  when its replacement spawns, the old one is flipped to `missed` (spec §6).
  After running, the job re-enqueues itself for the next horizon boundary.
- `close_week`: at the family's configured payout day/time, snapshot the
  week into the `weeks` table, stamp `week_id` onto every ledger entry from
  that range, pick the champion, broadcast `week.closed`, and schedule the
  next close.

On boot the runner replays missed jobs (the `due` query simply picks anything
`pending` whose `run_at` is in the past) and ensures every family has a
pending close-week job.

## Real-time (SSE)

`GET /api/events` opens an EventSource. Server pushes named events scoped to
the authenticated family — see `realtime/bus.ts` for the union type. Clients
should listen for the event names and refetch the relevant React Query keys.

## Out of scope in this build

These are scaffolded in the schema / event bus but not yet wired end-to-end:

- Photo uploads to R2 (column `photo_key` exists; presign endpoint TBD).
- Web Push (`push_subscriptions` table, `web-push` library not yet wired).
- Email (Resend) — championship-of-the-week + payout summary.

Adding any of these is a matter of dropping in a new route module and a
publisher subscribing to the relevant `FamilyEvent`.
