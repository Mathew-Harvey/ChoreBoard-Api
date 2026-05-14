DO $$ BEGIN
 CREATE TYPE "public"."milestone_metric" AS ENUM('cents_earned', 'chores_completed');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."milestone_period" AS ENUM('week', 'month', 'lifetime');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."milestone_scope" AS ENUM('family', 'member');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "milestone_hits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"family_id" uuid NOT NULL,
	"milestone_id" uuid NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"hit_at" timestamp with time zone DEFAULT now() NOT NULL,
	"amount" integer NOT NULL,
	"claimed_at" timestamp with time zone,
	"claimed_by_user_id" uuid,
	"claim_note" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "milestones" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"family_id" uuid NOT NULL,
	"name" text NOT NULL,
	"reward" text NOT NULL,
	"icon" text,
	"scope" "milestone_scope" DEFAULT 'family' NOT NULL,
	"member_type" "member_type",
	"member_id" uuid,
	"metric" "milestone_metric" DEFAULT 'cents_earned' NOT NULL,
	"period" "milestone_period" DEFAULT 'week' NOT NULL,
	"target_value" integer NOT NULL,
	"repeats" boolean DEFAULT true NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "milestone_hits" ADD CONSTRAINT "milestone_hits_family_id_families_id_fk" FOREIGN KEY ("family_id") REFERENCES "public"."families"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "milestone_hits" ADD CONSTRAINT "milestone_hits_milestone_id_milestones_id_fk" FOREIGN KEY ("milestone_id") REFERENCES "public"."milestones"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "milestones" ADD CONSTRAINT "milestones_family_id_families_id_fk" FOREIGN KEY ("family_id") REFERENCES "public"."families"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "milestone_hits_family_idx" ON "milestone_hits" USING btree ("family_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "milestone_hits_milestone_idx" ON "milestone_hits" USING btree ("milestone_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "milestone_hits_bucket_uniq" ON "milestone_hits" USING btree ("milestone_id","period_start");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "milestones_family_idx" ON "milestones" USING btree ("family_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "milestones_family_active_idx" ON "milestones" USING btree ("family_id","active");