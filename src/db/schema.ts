import {
  pgTable,
  text,
  integer,
  timestamp,
  boolean,
  jsonb,
  uuid,
  pgEnum,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

// ----------------------------------------------------------------------------
// Enums
// ----------------------------------------------------------------------------

export const roleEnum = pgEnum('role', ['owner', 'parent']);
export const memberTypeEnum = pgEnum('member_type', ['user', 'kid']);
// Member-stated gender used to pick a portrait set in the gamification UI.
// `unspecified` is the default and renders an alternating m/f portrait so a
// "rather not say" member still gets a personal-feeling avatar.
export const genderEnum = pgEnum('gender', ['male', 'female', 'unspecified']);
export const instanceStatusEnum = pgEnum('instance_status', [
  'available',
  'claimed',
  'pending',
  'approved',
  'missed',
  'rejected',
]);
export const ledgerStatusEnum = pgEnum('ledger_status', ['unpaid', 'paid']);
export const jobStatusEnum = pgEnum('job_status', ['pending', 'done', 'failed']);
export const jobKindEnum = pgEnum('job_kind', ['materialize_chore', 'close_week']);

// ----------------------------------------------------------------------------
// Families & members
// ----------------------------------------------------------------------------

export const families = pgTable('families', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  payoutDay: integer('payout_day').notNull().default(0), // 0 = Sunday … 6 = Saturday
  payoutTime: text('payout_time').notNull().default('18:00'), // HH:MM, family timezone
  timezone: text('timezone').notNull().default('Australia/Sydney'),
  // ISO 3166-1 alpha-2 country code used by the chore-suggestion pricing
  // engine to pick local-currency base rates anchored to the RoosterMoney
  // / HeyKit / Wells Fargo allowance surveys. Detected from the browser
  // (geolocation → reverse-geocode, falling back to navigator.language) at
  // signup; editable in Admin → Family afterwards. Nullable so existing
  // families keep working until a parent visits Admin.
  country: text('country'),
  // ISO 4217 currency for the family's chore amounts. Defaults to the
  // currency of `country` when null. Stored separately from `country` so a
  // family in Ireland can pick GBP if they want.
  currency: text('currency'),
  ownerUserId: uuid('owner_user_id'), // back-filled after first user insert
  // Set the moment a parent finishes the four-step OnboardWizard at /onboard
  // (PR 5). Until this is non-null every parent login on this family is
  // redirected to /onboard so the cold-start cliff doesn't leave a brand
  // new household staring at an empty Kanban.
  onboardingCompletedAt: timestamp('onboarding_completed_at', { withTimezone: true }),
  // Whether the TV-mode "Champion of the Week" ceremony plays its chime.
  // Defaults true; surfaced as a toggle in AdminFamily and in the TVMode
  // settings popover so a parent can mute the kitchen wall without
  // disabling the celebration entirely.
  tvCelebrationSound: boolean('tv_celebration_sound').notNull().default(true),
  // Stamped when a parent dismisses the "Pair a kitchen tablet" sticky
  // reminder banner that lives above the Kanban. Auto-clears (i.e. the
  // banner reappears) only if every device pairing is revoked. The
  // dismissal is only reachable from AdminFamily → Paired devices, on
  // purpose — a casual close on the banner itself wouldn't kill the
  // prompt and undermine the second-user pillar.
  pairingReminderDismissedAt: timestamp('pairing_reminder_dismissed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    familyId: uuid('family_id')
      .notNull()
      .references(() => families.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    passwordHash: text('password_hash').notNull(),
    name: text('name').notNull(),
    role: roleEnum('role').notNull().default('parent'),
    avatar: text('avatar'),
    color: text('color').notNull().default('#3253D7'),
    gender: genderEnum('gender').notNull().default('unspecified'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    emailIdx: uniqueIndex('users_email_idx').on(t.email),
    familyIdx: index('users_family_idx').on(t.familyId),
  }),
);

export const kids = pgTable(
  'kids',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    familyId: uuid('family_id')
      .notNull()
      .references(() => families.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    pinHash: text('pin_hash').notNull(),
    // Whole-year age. We store age (not date of birth) because the only
    // thing we use it for is choosing age-appropriate chores and the age
    // multiplier in the pricing engine — both of which only need
    // year-resolution. A future migration could move to DOB if we ever
    // want birthday surprises; for now this matches the signup question
    // ("How old is Skye?") one-to-one.
    age: integer('age'),
    avatar: text('avatar'),
    color: text('color').notNull().default('#3B82F6'),
    gender: genderEnum('gender').notNull().default('unspecified'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    familyIdx: index('kids_family_idx').on(t.familyId),
  }),
);

// Owner-generated invites that let a second (or third, …) parent join an
// existing family. The flow is intentionally email-free: the owner copies
// the join URL out of the admin UI and shares it however they want (SMS,
// Signal, etc.), which dodges the dependency on transactional email infra
// for v1.
//
// One row per *generated* invite. A row is "active" iff
//   consumedAt IS NULL AND revokedAt IS NULL AND expiresAt > now()
// `token` is the URL-safe secret embedded in the join link; we never log it.
export const familyInvites = pgTable(
  'family_invites',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    familyId: uuid('family_id')
      .notNull()
      .references(() => families.id, { onDelete: 'cascade' }),
    token: text('token').notNull(),
    // Owner who generated the invite. Nullable so removing a parent (set null
    // on delete) doesn't blow away their historical invites.
    createdByUserId: uuid('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    consumedByUserId: uuid('consumed_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tokenUniq: uniqueIndex('family_invites_token_uniq').on(t.token),
    familyIdx: index('family_invites_family_idx').on(t.familyId),
  }),
);

// ----------------------------------------------------------------------------
// Chores & instances
// ----------------------------------------------------------------------------

/**
 * cadence_json shape:
 *   { kind: "daily", times: ["07:00", "17:00"] }
 *   { kind: "weekly", days: [1,3,5], time: "08:00" }   // 0=Sun … 6=Sat
 *   { kind: "every_n_days", n: 2, time: "09:00" }
 *   { kind: "every_n_weeks", n: 2, days: [6], time: "10:00" }
 *   { kind: "monthly_dom", day: 1, time: "10:00" }
 *   { kind: "monthly_nth", nth: 1, weekday: 6, time: "10:00" } // first Saturday
 */
export const chores = pgTable(
  'chores',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    familyId: uuid('family_id')
      .notNull()
      .references(() => families.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'),
    amountCents: integer('amount_cents').notNull(),
    cadenceJson: jsonb('cadence_json').notNull(),
    active: boolean('active').notNull().default(true),
    photoRequired: boolean('photo_required').notNull().default(false),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    familyIdx: index('chores_family_idx').on(t.familyId),
  }),
);

export const choreInstances = pgTable(
  'chore_instances',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    choreId: uuid('chore_id')
      .notNull()
      .references(() => chores.id, { onDelete: 'cascade' }),
    familyId: uuid('family_id')
      .notNull()
      .references(() => families.id, { onDelete: 'cascade' }),
    availableAt: timestamp('available_at', { withTimezone: true }).notNull(),
    dueAt: timestamp('due_at', { withTimezone: true }),
    status: instanceStatusEnum('status').notNull().default('available'),
    claimedByType: memberTypeEnum('claimed_by_type'),
    claimedById: uuid('claimed_by_id'),
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    approvedByUserId: uuid('approved_by_user_id'),
    photoKey: text('photo_key'),
    weekId: uuid('week_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    familyIdx: index('instances_family_idx').on(t.familyId),
    statusIdx: index('instances_status_idx').on(t.familyId, t.status),
    weekIdx: index('instances_week_idx').on(t.weekId),
  }),
);

// ----------------------------------------------------------------------------
// Ledger & weeks
// ----------------------------------------------------------------------------

export const weeks = pgTable(
  'weeks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    familyId: uuid('family_id')
      .notNull()
      .references(() => families.id, { onDelete: 'cascade' }),
    startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
    endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    championMemberType: memberTypeEnum('champion_member_type'),
    championMemberId: uuid('champion_member_id'),
    championAmountCents: integer('champion_amount_cents'),
  },
  (t) => ({
    familyIdx: index('weeks_family_idx').on(t.familyId),
  }),
);

export const ledgerEntries = pgTable(
  'ledger_entries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    familyId: uuid('family_id')
      .notNull()
      .references(() => families.id, { onDelete: 'cascade' }),
    instanceId: uuid('instance_id')
      .notNull()
      .references(() => choreInstances.id, { onDelete: 'cascade' }),
    memberType: memberTypeEnum('member_type').notNull(),
    memberId: uuid('member_id').notNull(),
    amountCents: integer('amount_cents').notNull(),
    weekId: uuid('week_id'),
    status: ledgerStatusEnum('status').notNull().default('unpaid'),
    earnedAt: timestamp('earned_at', { withTimezone: true }).notNull().defaultNow(),
    paidAt: timestamp('paid_at', { withTimezone: true }),
    paidByUserId: uuid('paid_by_user_id'),
  },
  (t) => ({
    familyIdx: index('ledger_family_idx').on(t.familyId),
    memberIdx: index('ledger_member_idx').on(t.familyId, t.memberType, t.memberId),
    weekIdx: index('ledger_week_idx').on(t.weekId),
  }),
);

// ----------------------------------------------------------------------------
// Goals / gamification
// ----------------------------------------------------------------------------

export const goals = pgTable(
  'goals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    familyId: uuid('family_id')
      .notNull()
      .references(() => families.id, { onDelete: 'cascade' }),
    memberType: memberTypeEnum('member_type').notNull(),
    memberId: uuid('member_id').notNull(),
    name: text('name').notNull(),
    targetCents: integer('target_cents').notNull(),
    deadline: timestamp('deadline', { withTimezone: true }),
    basis: text('basis').notNull().default('weekly_plus_unpaid'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    hitAt: timestamp('hit_at', { withTimezone: true }),
  },
  (t) => ({
    memberIdx: index('goals_member_idx').on(t.familyId, t.memberType, t.memberId),
  }),
);

export const badgesCatalog = pgTable('badges_catalog', {
  id: uuid('id').primaryKey().defaultRandom(),
  code: text('code').notNull().unique(),
  name: text('name').notNull(),
  description: text('description').notNull(),
  icon: text('icon'),
  ruleJson: jsonb('rule_json').notNull(),
});

export const badgesAwarded = pgTable(
  'badges_awarded',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    familyId: uuid('family_id')
      .notNull()
      .references(() => families.id, { onDelete: 'cascade' }),
    memberType: memberTypeEnum('member_type').notNull(),
    memberId: uuid('member_id').notNull(),
    badgeId: uuid('badge_id')
      .notNull()
      .references(() => badgesCatalog.id, { onDelete: 'cascade' }),
    awardedAt: timestamp('awarded_at', { withTimezone: true }).notNull().defaultNow(),
    contextJson: jsonb('context_json'),
  },
  (t) => ({
    memberIdx: index('badges_member_idx').on(t.familyId, t.memberType, t.memberId),
  }),
);

export const streaks = pgTable(
  'streaks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    familyId: uuid('family_id')
      .notNull()
      .references(() => families.id, { onDelete: 'cascade' }),
    memberType: memberTypeEnum('member_type').notNull(),
    memberId: uuid('member_id').notNull(),
    kind: text('kind').notNull(), // 'daily' or 'chore:<choreId>'
    length: integer('length').notNull().default(0),
    lastDay: text('last_day'), // YYYY-MM-DD in family TZ
    bestLength: integer('best_length').notNull().default(0),
  },
  (t) => ({
    memberKindIdx: uniqueIndex('streaks_member_kind_idx').on(
      t.familyId,
      t.memberType,
      t.memberId,
      t.kind,
    ),
  }),
);

export const xpLog = pgTable(
  'xp_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    familyId: uuid('family_id')
      .notNull()
      .references(() => families.id, { onDelete: 'cascade' }),
    memberType: memberTypeEnum('member_type').notNull(),
    memberId: uuid('member_id').notNull(),
    delta: integer('delta').notNull(),
    reason: text('reason').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    memberIdx: index('xp_member_idx').on(t.familyId, t.memberType, t.memberId),
  }),
);

// ----------------------------------------------------------------------------
// Sessions, push, jobs
// ----------------------------------------------------------------------------

export const sessions = pgTable(
  'sessions',
  {
    id: text('id').primaryKey(), // opaque random token; sent as cookie OR Bearer
    userId: uuid('user_id'),
    kidId: uuid('kid_id'),
    familyId: uuid('family_id')
      .notNull()
      .references(() => families.id, { onDelete: 'cascade' }),
    // 'cookie' for browser sessions, 'bearer' for Capacitor native sessions,
    // 'pairing' for the device session minted by POST /api/auth/pair (PR 4).
    // Same opaque token regardless; this column is for telemetry + revoking
    // all native sessions in a single sweep if a device is lost.
    transport: text('transport').notNull().default('cookie'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    // Set on a parent session that was created via POST /api/auth/elevate
    // on a shared family device. While non-null, the session's parent
    // privileges last only until this timestamp; every write extends it by
    // config.parentTabletIdleMin minutes, reads do not. The auth plugin
    // refuses elevated sessions whose elevation has expired and deletes the
    // session row. Plain (non-elevated) parent sessions leave this null.
    elevationExpiresAt: timestamp('elevation_expires_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    familyIdx: index('sessions_family_idx').on(t.familyId),
    userIdx: index('sessions_user_idx').on(t.userId),
  }),
);

export const pushSubscriptions = pgTable(
  'push_subscriptions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    endpoint: text('endpoint').notNull(),
    p256dh: text('p256dh').notNull(),
    auth: text('auth').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userIdx: index('push_user_idx').on(t.userId),
    endpointIdx: uniqueIndex('push_user_endpoint_idx').on(t.userId, t.endpoint),
  }),
);

// ----------------------------------------------------------------------------
// Native push device tokens (Capacitor iOS/Android)
// ----------------------------------------------------------------------------
// One row per device per parent. We never store kid device tokens because kids
// don't get push (only parents are notified about chore approvals etc.).

export const platformEnum = pgEnum('device_platform', ['ios', 'android']);

export const deviceTokens = pgTable(
  'device_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    platform: platformEnum('platform').notNull(),
    token: text('token').notNull(),
    appVersion: text('app_version'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userIdx: index('device_tokens_user_idx').on(t.userId),
    // A given physical device should only have one row per user.
    tokenIdx: uniqueIndex('device_tokens_user_token_idx').on(t.userId, t.token),
  }),
);

// ----------------------------------------------------------------------------
// Subscriptions / billing
// ----------------------------------------------------------------------------
// One subscription per family. `source` records which rail collected the
// money (Stripe on web, Apple StoreKit on iOS, Google Play Billing on
// Android). Headline price is the same on every surface — we eat the
// platform fee on IAP.

export const subscriptionSourceEnum = pgEnum('subscription_source', [
  'stripe',
  'apple',
  'google',
]);

export const subscriptionStatusEnum = pgEnum('subscription_status', [
  'trialing',
  'active',
  'past_due',
  'cancelled',
  'expired',
]);

export const subscriptionPlanEnum = pgEnum('subscription_plan', ['free', 'family']);

export const subscriptions = pgTable(
  'subscriptions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    familyId: uuid('family_id')
      .notNull()
      .references(() => families.id, { onDelete: 'cascade' }),
    plan: subscriptionPlanEnum('plan').notNull().default('free'),
    status: subscriptionStatusEnum('status').notNull().default('active'),
    source: subscriptionSourceEnum('source'),
    // External provider identifier:
    //   stripe → "sub_..." (Stripe subscription ID)
    //   apple  → original_transaction_id
    //   google → purchaseToken
    externalId: text('external_id'),
    currentPeriodEnd: timestamp('current_period_end', { withTimezone: true }),
    cancelAt: timestamp('cancel_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    familyUniq: uniqueIndex('subscriptions_family_uniq').on(t.familyId),
  }),
);

// Append-only log of every webhook / verification we received from Stripe,
// Apple, or Google. Lets us replay state if we ever screw up the projection
// into `subscriptions`, and gives us an audit trail for refund disputes.
export const billingEvents = pgTable(
  'billing_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    familyId: uuid('family_id'), // nullable: webhook may arrive before we know the family
    source: subscriptionSourceEnum('source').notNull(),
    kind: text('kind').notNull(), // e.g. 'invoice.paid', 'DID_RENEW', 'SUBSCRIPTION_RENEWED'
    externalEventId: text('external_event_id').notNull(),
    payloadJson: jsonb('payload_json').notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp('processed_at', { withTimezone: true }),
    error: text('error'),
  },
  (t) => ({
    // Idempotency key — if a webhook is replayed, we no-op.
    eventUniq: uniqueIndex('billing_events_uniq').on(t.source, t.externalEventId),
    familyIdx: index('billing_events_family_idx').on(t.familyId),
  }),
);

// ----------------------------------------------------------------------------
// Milestones & rewards
// ----------------------------------------------------------------------------
// A *milestone* is a parent-defined target ("hit $50 as a family this week",
// "Skye does 20 chores this month", "the family earns $1000 lifetime") paired
// with a custom reward the parent commits to honouring ("pizza night out",
// "trip to the zoo"). Milestones are richer than `goals`:
//
//  - they can be scoped to the *whole family* or to a single member,
//  - they can measure either dollars or chore counts,
//  - they can repeat each week/month and reset automatically,
//  - they carry a reward description + emoji, not just a $ target,
//  - each individual time a recurring milestone is hit is stored in
//    `milestone_hits` so the parent has a permanent record of which weekly
//    rewards have been delivered and which are still outstanding.
//
// Evaluation runs at chore-approval time (see `domain/milestones.ts`),
// piggy-backing on the same transaction as the ledger insert. Recurring
// milestones use `period_start` (the family-TZ start of the current week or
// month, or the unix epoch for lifetime) as the bucket key so we can write
// at most one `milestone_hits` row per (milestone, period).

export const milestoneScopeEnum = pgEnum('milestone_scope', ['family', 'member']);
export const milestoneMetricEnum = pgEnum('milestone_metric', [
  'cents_earned',
  'chores_completed',
]);
export const milestonePeriodEnum = pgEnum('milestone_period', [
  'week',
  'month',
  'lifetime',
]);

export const milestones = pgTable(
  'milestones',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    familyId: uuid('family_id')
      .notNull()
      .references(() => families.id, { onDelete: 'cascade' }),
    name: text('name').notNull(), // "Pizza night week"
    reward: text('reward').notNull(), // "Pizza night out as a family"
    icon: text('icon'), // optional emoji, e.g. "🍕"
    scope: milestoneScopeEnum('scope').notNull().default('family'),
    // memberType + memberId are non-null iff scope = 'member'.
    memberType: memberTypeEnum('member_type'),
    memberId: uuid('member_id'),
    metric: milestoneMetricEnum('metric').notNull().default('cents_earned'),
    period: milestonePeriodEnum('period').notNull().default('week'),
    // Cents when metric=cents_earned; raw count when metric=chores_completed.
    targetValue: integer('target_value').notNull(),
    // If true, the milestone resets at every period boundary and can be hit
    // again. If false, it fires once and goes inactive automatically.
    repeats: boolean('repeats').notNull().default(true),
    active: boolean('active').notNull().default(true),
    createdByUserId: uuid('created_by_user_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
  },
  (t) => ({
    familyIdx: index('milestones_family_idx').on(t.familyId),
    activeIdx: index('milestones_family_active_idx').on(t.familyId, t.active),
  }),
);

// One row per *time* a milestone is hit. For a non-repeating lifetime
// milestone there's only ever one row. For a repeating weekly milestone
// there'll be one per week the family ever crossed the line.
//
// `period_start` is the canonical bucket key — for `week` it's the family
// payout cutoff (start of the current week), for `month` it's midnight on
// the 1st in the family timezone, for `lifetime` it's the unix epoch. The
// (milestone_id, period_start) unique index keeps evaluation idempotent: the
// approver-side handler can call `evaluateMilestones` after every chore
// approval without worrying about double-firing.
export const milestoneHits = pgTable(
  'milestone_hits',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    familyId: uuid('family_id')
      .notNull()
      .references(() => families.id, { onDelete: 'cascade' }),
    milestoneId: uuid('milestone_id')
      .notNull()
      .references(() => milestones.id, { onDelete: 'cascade' }),
    periodStart: timestamp('period_start', { withTimezone: true }).notNull(),
    hitAt: timestamp('hit_at', { withTimezone: true }).notNull().defaultNow(),
    // Snapshot of the metric at the time of the hit (cents or count). Lets
    // the dashboard show "you blew past it by $12" without recomputing.
    amount: integer('amount').notNull(),
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
    claimedByUserId: uuid('claimed_by_user_id'),
    claimNote: text('claim_note'),
  },
  (t) => ({
    familyIdx: index('milestone_hits_family_idx').on(t.familyId),
    milestoneIdx: index('milestone_hits_milestone_idx').on(t.milestoneId),
    bucketUniq: uniqueIndex('milestone_hits_bucket_uniq').on(
      t.milestoneId,
      t.periodStart,
    ),
  }),
);

export const scheduledJobs = pgTable(
  'scheduled_jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    familyId: uuid('family_id')
      .notNull()
      .references(() => families.id, { onDelete: 'cascade' }),
    kind: jobKindEnum('kind').notNull(),
    runAt: timestamp('run_at', { withTimezone: true }).notNull(),
    payloadJson: jsonb('payload_json').notNull(),
    status: jobStatusEnum('status').notNull().default('pending'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    ranAt: timestamp('ran_at', { withTimezone: true }),
    error: text('error'),
  },
  (t) => ({
    runIdx: index('jobs_run_idx').on(t.status, t.runAt),
    familyIdx: index('jobs_family_idx').on(t.familyId),
  }),
);

// ----------------------------------------------------------------------------
// Device pairings (kitchen tablet flow)
// ----------------------------------------------------------------------------
// One row per pairing-code issuance. Any parent can call POST /api/family/pairings
// to mint a 6-digit code; the plaintext is shown once, the row stores only its
// argon2 hash. POST /api/auth/pair consumes the code (verifies expiry,
// non-consumption, non-revocation), creates a long-lived "device session" in
// the `sessions` table with transport='pairing', and writes that session id
// back to `consumed_session_id`. Revoking a pairing deletes the device session.
//
// Modelled after `family_invites`; same lifecycle (pending → consumed | revoked
// | expired) and the same defensive-by-construction approach where a single
// active row "wins" — except we allow multiple consumed pairings per family
// (one per kitchen tablet, playroom screen, etc).

export const devicePairings = pgTable(
  'device_pairings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    familyId: uuid('family_id')
      .notNull()
      .references(() => families.id, { onDelete: 'cascade' }),
    // argon2id hash of the 6-digit code. We never store plaintext.
    codeHash: text('code_hash').notNull(),
    issuedByUserId: uuid('issued_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    issuedAt: timestamp('issued_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    // Human-readable label inferred from the User-Agent at consume time
    // ("Apple iPad", "Pixel Tablet", etc), editable by parents inline in
    // AdminFamily → Paired devices.
    consumedDeviceLabel: text('consumed_device_label'),
    // Soft pointer (no FK — sessions.id is text) to the device session this
    // pairing minted. Used by DELETE /api/family/pairings/:id to revoke.
    consumedSessionId: text('consumed_session_id'),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    // Bumped by the auth plugin every time a request arrives bearing this
    // pairing's device session. Powers the "Active 2m ago" / "Last seen
    // yesterday" display in admin.
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
  },
  (t) => ({
    familyIdx: index('device_pairings_family_idx').on(t.familyId),
    activeIdx: index('device_pairings_active_idx').on(
      t.familyId,
      t.consumedAt,
      t.revokedAt,
    ),
  }),
);

// ----------------------------------------------------------------------------
// Notification preferences (per parent)
// ----------------------------------------------------------------------------
// One row per parent. Backfilled on every successful signup or invite-accept;
// the push fan-out in `integrations/push.ts` reads this to gate per-event
// delivery, and (when Resend lands) the email fan-out reads the email_*
// columns. Quiet hours are evaluated in the parent's own `quiet_tz` so a
// travelling parent isn't pinged at 2am their local time just because the
// family's clock is in Sydney.

export const notificationPrefs = pgTable('notification_prefs', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  pushApprovalsRequested: boolean('push_approvals_requested').notNull().default(true),
  emailApprovalsRequested: boolean('email_approvals_requested').notNull().default(true),
  pushGoalHit: boolean('push_goal_hit').notNull().default(true),
  emailGoalHit: boolean('email_goal_hit').notNull().default(true),
  pushChampion: boolean('push_champion').notNull().default(true),
  emailChampion: boolean('email_champion').notNull().default(true),
  pushWeeklySummary: boolean('push_weekly_summary').notNull().default(true),
  emailWeeklySummary: boolean('email_weekly_summary').notNull().default(true),
  // 'HH:MM' or null. Both must be set together; quiet hours wrap midnight
  // (e.g. 21:30 → 06:00) and the wrap-around case is honoured by the
  // delivery gate.
  quietStart: text('quiet_start'),
  quietEnd: text('quiet_end'),
  // Defaults to families.timezone at row-create time but is independently
  // editable so a parent on the road can set their own quiet hours.
  quietTz: text('quiet_tz').notNull().default('Australia/Sydney'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
