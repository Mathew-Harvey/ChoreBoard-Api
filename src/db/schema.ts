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
  ownerUserId: uuid('owner_user_id'), // back-filled after first user insert
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
    avatar: text('avatar'),
    color: text('color').notNull().default('#3B82F6'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    familyIdx: index('kids_family_idx').on(t.familyId),
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
    id: text('id').primaryKey(), // opaque random token, stored in cookie
    userId: uuid('user_id'),
    kidId: uuid('kid_id'),
    familyId: uuid('family_id')
      .notNull()
      .references(() => families.id, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    familyIdx: index('sessions_family_idx').on(t.familyId),
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
