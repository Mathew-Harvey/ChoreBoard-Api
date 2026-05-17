-- PR 1 + PR 3 — drop the family-canvas (whiteboards / lists / supermarket)
-- tables and add the pairing + onboarding + notification-prefs surfaces.
--
-- Hand-written because drizzle-kit's interactive rename heuristic confuses
-- the dropped tables with the new ones; the schema.ts is the source of truth
-- and this SQL is its faithful diff against snapshot 0007.

--> statement-breakpoint
DROP TABLE IF EXISTS "list_items" CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS "lists" CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS "whiteboards" CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS "product_cache" CASCADE;
--> statement-breakpoint
DROP TYPE IF EXISTS "list_kind";

--> statement-breakpoint
ALTER TABLE "families"
  ADD COLUMN IF NOT EXISTS "onboarding_completed_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "families"
  ADD COLUMN IF NOT EXISTS "tv_celebration_sound" boolean NOT NULL DEFAULT true;
--> statement-breakpoint
ALTER TABLE "families"
  ADD COLUMN IF NOT EXISTS "pairing_reminder_dismissed_at" timestamp with time zone;

--> statement-breakpoint
ALTER TABLE "sessions"
  ADD COLUMN IF NOT EXISTS "elevation_expires_at" timestamp with time zone;

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "device_pairings" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "family_id" uuid NOT NULL,
  "code_hash" text NOT NULL,
  "issued_by_user_id" uuid,
  "issued_at" timestamp with time zone DEFAULT now() NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "consumed_at" timestamp with time zone,
  "consumed_device_label" text,
  "consumed_session_id" text,
  "revoked_at" timestamp with time zone,
  "last_seen_at" timestamp with time zone
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "device_pairings"
   ADD CONSTRAINT "device_pairings_family_id_families_id_fk"
   FOREIGN KEY ("family_id") REFERENCES "families"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "device_pairings"
   ADD CONSTRAINT "device_pairings_issued_by_user_id_users_id_fk"
   FOREIGN KEY ("issued_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "device_pairings_family_idx" ON "device_pairings" ("family_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "device_pairings_active_idx" ON "device_pairings" ("family_id","consumed_at","revoked_at");

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "notification_prefs" (
  "user_id" uuid PRIMARY KEY NOT NULL,
  "push_approvals_requested" boolean NOT NULL DEFAULT true,
  "email_approvals_requested" boolean NOT NULL DEFAULT true,
  "push_goal_hit" boolean NOT NULL DEFAULT true,
  "email_goal_hit" boolean NOT NULL DEFAULT true,
  "push_champion" boolean NOT NULL DEFAULT true,
  "email_champion" boolean NOT NULL DEFAULT true,
  "push_weekly_summary" boolean NOT NULL DEFAULT true,
  "email_weekly_summary" boolean NOT NULL DEFAULT true,
  "quiet_start" text,
  "quiet_end" text,
  "quiet_tz" text NOT NULL DEFAULT 'Australia/Sydney',
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "notification_prefs"
   ADD CONSTRAINT "notification_prefs_user_id_users_id_fk"
   FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
