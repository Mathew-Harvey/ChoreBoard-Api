DO $$ BEGIN
 CREATE TYPE "public"."gender" AS ENUM('male', 'female', 'unspecified');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
ALTER TABLE "kids" ADD COLUMN "gender" "gender" DEFAULT 'unspecified' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "gender" "gender" DEFAULT 'unspecified' NOT NULL;