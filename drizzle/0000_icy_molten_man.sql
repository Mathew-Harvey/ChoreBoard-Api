DO $$ BEGIN
 CREATE TYPE "public"."instance_status" AS ENUM('available', 'claimed', 'pending', 'approved', 'missed', 'rejected');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."job_kind" AS ENUM('materialize_chore', 'close_week');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."job_status" AS ENUM('pending', 'done', 'failed');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."ledger_status" AS ENUM('unpaid', 'paid');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."member_type" AS ENUM('user', 'kid');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."role" AS ENUM('owner', 'parent');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "badges_awarded" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"family_id" uuid NOT NULL,
	"member_type" "member_type" NOT NULL,
	"member_id" uuid NOT NULL,
	"badge_id" uuid NOT NULL,
	"awarded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"context_json" jsonb
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "badges_catalog" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"icon" text,
	"rule_json" jsonb NOT NULL,
	CONSTRAINT "badges_catalog_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "chore_instances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chore_id" uuid NOT NULL,
	"family_id" uuid NOT NULL,
	"available_at" timestamp with time zone NOT NULL,
	"due_at" timestamp with time zone,
	"status" "instance_status" DEFAULT 'available' NOT NULL,
	"claimed_by_type" "member_type",
	"claimed_by_id" uuid,
	"claimed_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"approved_at" timestamp with time zone,
	"approved_by_user_id" uuid,
	"photo_key" text,
	"week_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "chores" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"family_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"amount_cents" integer NOT NULL,
	"cadence_json" jsonb NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"photo_required" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "families" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"payout_day" integer DEFAULT 0 NOT NULL,
	"payout_time" text DEFAULT '18:00' NOT NULL,
	"timezone" text DEFAULT 'Australia/Sydney' NOT NULL,
	"owner_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "goals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"family_id" uuid NOT NULL,
	"member_type" "member_type" NOT NULL,
	"member_id" uuid NOT NULL,
	"name" text NOT NULL,
	"target_cents" integer NOT NULL,
	"deadline" timestamp with time zone,
	"basis" text DEFAULT 'weekly_plus_unpaid' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"hit_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "kids" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"family_id" uuid NOT NULL,
	"name" text NOT NULL,
	"pin_hash" text NOT NULL,
	"avatar" text,
	"color" text DEFAULT '#3B82F6' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ledger_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"family_id" uuid NOT NULL,
	"instance_id" uuid NOT NULL,
	"member_type" "member_type" NOT NULL,
	"member_id" uuid NOT NULL,
	"amount_cents" integer NOT NULL,
	"week_id" uuid,
	"status" "ledger_status" DEFAULT 'unpaid' NOT NULL,
	"earned_at" timestamp with time zone DEFAULT now() NOT NULL,
	"paid_at" timestamp with time zone,
	"paid_by_user_id" uuid
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "push_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"endpoint" text NOT NULL,
	"p256dh" text NOT NULL,
	"auth" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "scheduled_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"family_id" uuid NOT NULL,
	"kind" "job_kind" NOT NULL,
	"run_at" timestamp with time zone NOT NULL,
	"payload_json" jsonb NOT NULL,
	"status" "job_status" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ran_at" timestamp with time zone,
	"error" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" uuid,
	"kid_id" uuid,
	"family_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "streaks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"family_id" uuid NOT NULL,
	"member_type" "member_type" NOT NULL,
	"member_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"length" integer DEFAULT 0 NOT NULL,
	"last_day" text,
	"best_length" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"family_id" uuid NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"name" text NOT NULL,
	"role" "role" DEFAULT 'parent' NOT NULL,
	"avatar" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "weeks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"family_id" uuid NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"closed_at" timestamp with time zone,
	"champion_member_type" "member_type",
	"champion_member_id" uuid,
	"champion_amount_cents" integer
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "xp_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"family_id" uuid NOT NULL,
	"member_type" "member_type" NOT NULL,
	"member_id" uuid NOT NULL,
	"delta" integer NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "badges_awarded" ADD CONSTRAINT "badges_awarded_family_id_families_id_fk" FOREIGN KEY ("family_id") REFERENCES "public"."families"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "badges_awarded" ADD CONSTRAINT "badges_awarded_badge_id_badges_catalog_id_fk" FOREIGN KEY ("badge_id") REFERENCES "public"."badges_catalog"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "chore_instances" ADD CONSTRAINT "chore_instances_chore_id_chores_id_fk" FOREIGN KEY ("chore_id") REFERENCES "public"."chores"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "chore_instances" ADD CONSTRAINT "chore_instances_family_id_families_id_fk" FOREIGN KEY ("family_id") REFERENCES "public"."families"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "chores" ADD CONSTRAINT "chores_family_id_families_id_fk" FOREIGN KEY ("family_id") REFERENCES "public"."families"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "goals" ADD CONSTRAINT "goals_family_id_families_id_fk" FOREIGN KEY ("family_id") REFERENCES "public"."families"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "kids" ADD CONSTRAINT "kids_family_id_families_id_fk" FOREIGN KEY ("family_id") REFERENCES "public"."families"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_family_id_families_id_fk" FOREIGN KEY ("family_id") REFERENCES "public"."families"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_instance_id_chore_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."chore_instances"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "scheduled_jobs" ADD CONSTRAINT "scheduled_jobs_family_id_families_id_fk" FOREIGN KEY ("family_id") REFERENCES "public"."families"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sessions" ADD CONSTRAINT "sessions_family_id_families_id_fk" FOREIGN KEY ("family_id") REFERENCES "public"."families"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "streaks" ADD CONSTRAINT "streaks_family_id_families_id_fk" FOREIGN KEY ("family_id") REFERENCES "public"."families"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "users" ADD CONSTRAINT "users_family_id_families_id_fk" FOREIGN KEY ("family_id") REFERENCES "public"."families"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "weeks" ADD CONSTRAINT "weeks_family_id_families_id_fk" FOREIGN KEY ("family_id") REFERENCES "public"."families"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "xp_log" ADD CONSTRAINT "xp_log_family_id_families_id_fk" FOREIGN KEY ("family_id") REFERENCES "public"."families"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "badges_member_idx" ON "badges_awarded" USING btree ("family_id","member_type","member_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "instances_family_idx" ON "chore_instances" USING btree ("family_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "instances_status_idx" ON "chore_instances" USING btree ("family_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "instances_week_idx" ON "chore_instances" USING btree ("week_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chores_family_idx" ON "chores" USING btree ("family_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "goals_member_idx" ON "goals" USING btree ("family_id","member_type","member_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "kids_family_idx" ON "kids" USING btree ("family_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ledger_family_idx" ON "ledger_entries" USING btree ("family_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ledger_member_idx" ON "ledger_entries" USING btree ("family_id","member_type","member_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ledger_week_idx" ON "ledger_entries" USING btree ("week_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "push_user_idx" ON "push_subscriptions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "jobs_run_idx" ON "scheduled_jobs" USING btree ("status","run_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "jobs_family_idx" ON "scheduled_jobs" USING btree ("family_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sessions_family_idx" ON "sessions" USING btree ("family_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "streaks_member_kind_idx" ON "streaks" USING btree ("family_id","member_type","member_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "users_email_idx" ON "users" USING btree ("email");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "users_family_idx" ON "users" USING btree ("family_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "weeks_family_idx" ON "weeks" USING btree ("family_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "xp_member_idx" ON "xp_log" USING btree ("family_id","member_type","member_id");