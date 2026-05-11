# ChoreBoard — v1 Spec

## 1. Product summary

A SaaS family dashboard where members claim and complete household chores in a shared, real-time view. Chores carry a $ value, auto-renew on configurable cadences, and accumulate into a weekly tally that pays out every Sunday. Kids work toward $ goals; the family competes for weekly bragging rights with leaderboards, streaks, and badges. The board can run on a touchscreen in the kitchen *and* on phones in pockets, all updating live.

---

## 2. Roles

- **Owner** — created the family account, has billing + admin. Always also a Parent.
- **Parent** — can approve chores, manage the chore catalog, edit members, view ledger.
- **Kid** — claims and completes chores via PIN sign-in. Cannot self-approve.
- **Guest Parent** (later) — e.g. a co-parent in another household. Out of scope for v1.

A Parent signs in with email + password. A Kid signs in with a 4-digit PIN selected from the family's kid roster on the device.

---

## 3. Core flow

1. Parent sets up family, adds kids (name + avatar + PIN + colour).
2. Parent picks chores from the catalog (or accepts the defaults) and confirms prices/cadences.
3. The system materialises **chore instances** as they come due. Daily ones appear every day at the configured time; weekly ones on the configured day; etc.
4. On the Kanban screen, anyone (Parent or Kid) drags an `Available` chore card into their lane → state becomes `Claimed`.
5. They do the chore, then drag the card to `Pending approval`. They can optionally attach a photo at this point.
6. All Parents receive a web push notification. Any Parent can tap Approve or Reject from their phone (or from any view of the app).
7. On approval, the chore goes to `Completed today`, the amount lands in the claimant's weekly tally, XP is awarded, streaks update, and any badge checks fire.
8. On Sunday at the configured payout time, the system snapshots the week into the ledger, marks each line as `unpaid`, and resets the leaderboard. Owner marks lines `paid` when cash/transfer happens. Confetti + champion announcement plays on the Kanban screen.

---

## 4. The screens (multi-desktop layout)

The app is a single SPA. The top of every screen has a row of dot indicators (like phone home screens) showing which "desktop" you're on; swipe left/right on touch, or arrow keys on desktop, or click a dot to jump.

### Desktop 1 — Kanban Board
Columns: `Available` | one column per family member | `Pending approval` | `Completed today`. Cards are big, colour-coded by member (mirroring the swimlane), drag-and-drop and touch-friendly. Overdue chores have a pulsing red border. Top bar shows today's date, time to next renewal, and a mini weekly leaderboard.

### Desktop 2 — Family Dashboard
Big-screen TV mode. Weekly leaderboard with crown on the leader, each member's weekly $ total with a chunky progress bar to their personal goal, current streaks (🔥 day counter), recent badge unlocks, time-until-payout countdown. This is the "ambient" screen meant to live on a wall.

### Desktop 3+ — Member Dashboards
One per family member. That person's stats: weekly tally, goal progress, lifetime earned, lifetime chores done, longest streak, badge case, recent activity. For Parents, also: pending approval queue, "approve" buttons inline.

### Admin (Parents only, separate route `/admin`)
Family settings, chore catalog editor, member management, ledger, payout marking, gamification settings.

---

## 5. Default chore catalog

The system seeds new families with this catalog. Parents can edit, disable, or add to it.

| Chore | Cadence | Renewal | Suggested $ |
|---|---|---|---|
| Pack the dishwasher | Daily | 12:00 | $1.00 |
| Empty the dishwasher | Daily | 07:00 | $1.00 |
| Vacuum high-traffic areas | Daily | 14:00 | $2.00 |
| Tidy the living room | Daily | 17:00 | $1.50 |
| Wipe kitchen benches | Daily | 19:30 | $1.00 |
| Take out kitchen bin | Daily | 19:00 | $0.50 |
| Feed pets | Daily (×2) | 07:00, 17:00 | $0.50 |
| Make your bed | Daily, per kid | 09:00 | $0.50 |
| Sort & start a load of laundry | 3× weekly (Mon/Wed/Fri) | 08:00 | $2.00 |
| Hang or fold a load | 3× weekly (Mon/Wed/Fri) | 16:00 | $2.00 |
| Mop kitchen + bathroom | 2× weekly (Tue/Sat) | 09:00 | $3.00 |
| Vacuum the whole house | Weekly (Sat) | 09:00 | $7.00 |
| Mop the whole house | Weekly (Sat) | 11:00 | $5.00 |
| Clean bathrooms (toilet/shower/basin) | Weekly (Sat) | 09:00 | $8.00 |
| Change bed sheets | Weekly (Sun) | 10:00 | $3.00 per bed |
| Bins out to curb | Weekly (configurable day) | 18:00 | $1.00 |
| Wipe down skirting boards | Fortnightly | Sat 10:00 | $5.00 |
| Vacuum couches | Fortnightly | Sat 10:00 | $3.00 |
| Wash the car | Fortnightly | Sun 09:00 | $10.00 |
| Clean inside the fridge | Monthly | 1st Sat 10:00 | $8.00 |
| Clean inside the oven | Monthly | 1st Sat 10:00 | $10.00 |
| Clean ceiling fans / light fittings | Monthly | 1st Sat 10:00 | $5.00 |
| Tidy the garage | Monthly | 1st Sun 10:00 | $10.00 |
| Wash exterior windows | Monthly | 1st Sun 10:00 | $8.00 |

The catalog editor lets a Parent toggle, edit, or add chores with arbitrary cadences: daily, every N days, weekly on specific weekday(s), every N weeks, monthly on day-of-month or Nth weekday.

---

## 6. Overdue behaviour

If a chore instance is still `Available` when the next renewal fires, the old instance gets a pulsing red border and an "overdue since X" tag. It does **not** stack — the next renewal replaces it. On replacement, the unfinished instance is logged as `missed` in the chore history for stats but disappears from the board.

---

## 7. Gamification (going all out)

### Weekly leaderboard
Live ranking by $ earned this week. The leader has an animated crown above their avatar everywhere they appear. Sunday payout triggers a Champion of the Week screen on the Family Dashboard with confetti, a crown for the winner, and "best week ever" / "personal best" callouts where they apply.

### XP and levels
Every cent earned = 1 XP, accumulated lifetime. Levels follow a gentle curve (Level 1: 0 XP, Level 2: 500, Level 3: 1500, Level 4: 3500, Level 5: 7500, then ×2 each). Level-up plays a sound and animation. Each level has a name (Apprentice, Helper, Champion, Hero, Legend, Mythic, etc.).

### Streaks
Two kinds: *daily streak* (at least one approved chore that day), and per-chore streaks (e.g. dishwasher dynasty: most consecutive days holding the dishwasher chore). Daily streak shows a flame counter on the dashboard.

### Badges
Unlocked silently and announced on the Family Dashboard. The seed set:

- *First Steps* — first chore ever.
- *Bronze / Silver / Gold / Platinum / Diamond Helper* — 10 / 50 / 200 / 500 / 1000 lifetime chores.
- *Centurion* — $100 lifetime earned. *Millionaire* — $1000.
- *Dishwasher Dynasty* — 7 consecutive days of dishwasher.
- *Vacuum Vandal* — vacuumed the whole house 10 times.
- *Early Bird* — chore approved before 8am.
- *Night Owl* — chore approved after 9pm.
- *Weekend Warrior* — 5 chores in one weekend.
- *Perfect Week* — every available chore claimed by the family that week.
- *Personal Best* — your highest weekly $ ever.
- *Comeback Kid* — start a new streak after a streak of 7+ ended.
- *Goal Crusher* — hit a personal $ goal.
- *Speed Demon* — claim-to-complete in under 5 minutes.
- *Reliable* — 4 weeks running with the same recurring chore.

The catalog is data-driven so we can add more without code changes.

### All-time stats panel
Per member: total earned, total chores, favourite chore (most claimed), fastest chore, longest streak, badge count, current level.

### Family-level stats
On the Family Dashboard: total chores done all-time, total $ paid out all-time, longest collective streak, family level (sum of member XP / 5).

---

## 8. Goals

Each member can set one or more $ goals with a name, target amount, and optional deadline ("Nintendo Switch — $450 by Christmas"). Progress is `(weekly tally + unpaid ledger) / target` by default, with a toggle for `(lifetime earned) / target`. Goal hit → *Goal Crusher* badge, confetti on their dashboard.

---

## 9. Payout ledger

Every approved chore writes a row to `ledger_entries` immediately, with `status = 'unpaid'`. Sunday at the family's configured payout time, the system marks that week as "closed" (no further entries can be backdated into it) and presents a payout summary to the Owner: per-member totals, line items, "mark as paid" buttons (per-member or all). When marked paid, rows flip to `paid` with a `paid_at` and `paid_by`. Ledger is queryable forever, exportable to CSV.

---

## 10. Notifications

Web Push (PWA install) for parents only. Triggers:

- Kid submits a chore for approval (with link straight to Approve/Reject).
- Goal hit by a kid.
- Champion of the week announced.
- (Configurable per parent.)

iOS supports Web Push only when the PWA is installed to home screen, which we'll explain in onboarding. Android and desktop work out of the box. Email fallback for "Champion of the week" and "weekly payout summary" so parents who don't install the PWA still get the headlines.

---

## 11. Real-time sync

Server-Sent Events (SSE), one stream per authenticated session, scoped to that family. Any state change in the family (claim, complete, approve, renewal, badge unlock, level up) broadcasts a small event to all connected family clients. SSE because it's simpler than WebSockets, plays nicely with Render, supports reconnection out of the box, and we don't need bidirectional traffic — clients send mutations via normal HTTP.

---

## 12. Tech stack

Single repo, monorepo-light (one server, one web client, shared types).

- **Backend:** Node.js + Fastify. Drizzle ORM. Postgres on Render. Argon2 for password hashing. Cookie-based sessions (HTTP-only, SameSite=Lax) — not JWTs. A small in-process job runner (no Redis, no BullMQ) handles renewals and payouts via `setTimeout` driven by a `scheduled_jobs` table; on boot the server replays missed jobs. Render's single instance is fine for v1; if we ever scale out we swap in a real scheduler.
- **Frontend:** Vite + React + TypeScript SPA. TanStack Query for server state. Zustand for tiny local UI state. `dnd-kit` for drag-and-drop on Kanban (touch + mouse). Tailwind for styling. PWA via Vite PWA plugin for installability + Web Push.
- **Photos:** Cloudflare R2 (S3-compatible, no egress fees). Pre-signed URLs from the backend; client uploads direct. Thumbnails generated on the server with `sharp` on upload.
- **Email:** Resend (transactional only — signup verify, password reset, weekly payout summary).
- **Web Push:** `web-push` library, VAPID keys in env.
- **Hosting:** Render web service for the API (serves the built SPA too — single origin, single deploy). Render Postgres. Render Disk not needed (photos on R2).
- **Telemetry:** PostHog (cheap, captures funnel + product analytics without much code). Sentry for errors.

No Redis, no message broker, no microservices, no Next.js, no Prisma, no auth-as-a-service. One server, one DB, one SPA.

---

## 13. Data model (sketch)

```
families            (id, name, payout_day, payout_time, timezone, created_at, owner_user_id)
users               (id, family_id, email, password_hash, name, role[owner|parent], avatar, created_at)
kids                (id, family_id, name, pin_hash, avatar, color, created_at)
chores              (id, family_id, name, description, amount_cents, cadence_json, active, sort_order)
chore_instances     (id, chore_id, family_id, available_at, due_at, status[available|claimed|pending|approved|missed], claimed_by_type, claimed_by_id, claimed_at, completed_at, approved_at, approved_by_user_id, photo_key, week_id)
ledger_entries      (id, family_id, instance_id, member_type, member_id, amount_cents, week_id, status[unpaid|paid], earned_at, paid_at, paid_by_user_id)
weeks               (id, family_id, starts_at, ends_at, closed_at, champion_member_type, champion_member_id, champion_amount_cents)
goals               (id, member_type, member_id, name, target_cents, deadline, basis[weekly_plus_unpaid|lifetime], created_at, hit_at)
badges_catalog      (id, code, name, description, icon, rule_json)
badges_awarded      (id, member_type, member_id, badge_id, awarded_at, context_json)
streaks             (id, member_type, member_id, kind[daily|chore:<id>], length, last_day, best_length)
xp_log              (id, member_type, member_id, delta, reason, created_at)
push_subscriptions  (id, user_id, endpoint, p256dh, auth, created_at)
sessions            (id, user_id|null, kid_id|null, family_id, expires_at)
scheduled_jobs      (id, family_id, kind, run_at, payload_json, status)
```

`member_type` + `member_id` is the polymorphic key for "user or kid". Slight ugliness but keeps the schema honest.

---

## 14. Out of scope for v1

- Multiple parents in different households / shared custody.
- Real money rails (Stripe Connect, kids' debit cards). The app tracks owed $, the human hands over cash or does a bank transfer.
- Native iOS/Android apps. PWA only.
- Chore dependencies ("vacuum before mop").
- Photo evidence required (it's optional per chore for v1; "required" toggle is a v1.1 add).
- Chore rotation / fairness assignment. v1 is pure claim-based.
- i18n. English/AUD only on day one, but the codebase uses `Intl` from the start so this is easy later.
- Billing. v1 is free / closed beta. Billing layer (Stripe + plans) is its own next step once we know the shape.

---

## 15. Open questions

1. **Elodie's age.** Affects suggested $ amounts and PIN UX (younger kids → emoji/animal "PIN" instead of digits).
2. **Pricing tiers when we open it up.** Free for one family, or freemium with a member cap? My instinct: free forever for up to 4 members, $5/month for more + advanced gamification + history export. Skip for v1 build, decide before launch.
3. **Approval-on-touchscreen path.** A Parent standing at the touchscreen approving a Kid's chore — should they re-enter their parent PIN, or is being signed in on that device enough? I'd default to a short parent PIN prompt for the approval action so a Kid can't approve themselves from the family device.
4. **Photo retention.** Forever, or auto-delete after 90 days? R2 storage is cheap but the photos add up. I'd default to 1-year retention with a setting to extend.
5. **What does Skye think?** Worth a sanity check that the gamification level lands well for your household and isn't going to feel oppressive for the kid. Easy to dial down later but worth a gut check now.