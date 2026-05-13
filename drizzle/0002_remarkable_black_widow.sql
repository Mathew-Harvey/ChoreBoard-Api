DO $$ BEGIN
 CREATE TYPE "public"."list_kind" AS ENUM('shopping', 'todo', 'packing', 'other');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "list_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"list_id" uuid NOT NULL,
	"family_id" uuid NOT NULL,
	"text" text NOT NULL,
	"qty" integer DEFAULT 1 NOT NULL,
	"product_json" jsonb,
	"unit_price_cents" integer,
	"checked_at" timestamp with time zone,
	"checked_by_user_id" uuid,
	"checked_by_kid_id" uuid,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "lists" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"family_id" uuid NOT NULL,
	"title" text NOT NULL,
	"kind" "list_kind" DEFAULT 'shopping' NOT NULL,
	"date" text,
	"store" text,
	"archived_at" timestamp with time zone,
	"created_by_user_id" uuid,
	"created_by_kid_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "product_cache" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" text NOT NULL,
	"external_id" text NOT NULL,
	"name" text NOT NULL,
	"brand" text,
	"image" text,
	"package_size" text,
	"price_cents" integer,
	"was_price_cents" integer,
	"on_special" boolean DEFAULT false NOT NULL,
	"payload_json" jsonb,
	"cached_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "whiteboards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"family_id" uuid NOT NULL,
	"title" text DEFAULT 'Untitled board' NOT NULL,
	"date" text,
	"width" integer DEFAULT 1600 NOT NULL,
	"height" integer DEFAULT 1000 NOT NULL,
	"background" text DEFAULT 'paper' NOT NULL,
	"strokes_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"points_count" integer DEFAULT 0 NOT NULL,
	"created_by_user_id" uuid,
	"created_by_kid_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "list_items" ADD CONSTRAINT "list_items_list_id_lists_id_fk" FOREIGN KEY ("list_id") REFERENCES "public"."lists"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "list_items" ADD CONSTRAINT "list_items_family_id_families_id_fk" FOREIGN KEY ("family_id") REFERENCES "public"."families"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "lists" ADD CONSTRAINT "lists_family_id_families_id_fk" FOREIGN KEY ("family_id") REFERENCES "public"."families"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "whiteboards" ADD CONSTRAINT "whiteboards_family_id_families_id_fk" FOREIGN KEY ("family_id") REFERENCES "public"."families"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "list_items_list_idx" ON "list_items" USING btree ("list_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "list_items_family_idx" ON "list_items" USING btree ("family_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "lists_family_idx" ON "lists" USING btree ("family_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "lists_family_date_idx" ON "lists" USING btree ("family_id","date");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "product_cache_source_ext_uniq" ON "product_cache" USING btree ("source","external_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "product_cache_name_idx" ON "product_cache" USING btree ("source","name");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "whiteboards_family_idx" ON "whiteboards" USING btree ("family_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "whiteboards_family_date_idx" ON "whiteboards" USING btree ("family_id","date");