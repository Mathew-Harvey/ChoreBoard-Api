-- PR — Age-aware chore suggestions + per-country pricing.
--
-- Adds three nullable columns:
--   - `kids.age`              integer (years; null = legacy row pre-feature)
--   - `families.country`      ISO 3166-1 alpha-2 (e.g. 'AU', 'US', 'GB')
--   - `families.currency`     ISO 4217 (e.g. 'AUD', 'USD', 'GBP')
--
-- Hand-written for the same reason as 0008: drizzle-kit's interactive
-- prompt confuses additive column adds with renames. The schema.ts is
-- the source of truth and this SQL is its faithful diff against snapshot
-- 0009.
--
-- All three columns are nullable so existing rows keep working. The
-- chore-suggestion API (`GET /api/chores/suggest`) and the pricing engine
-- both fall back gracefully when these are NULL, defaulting to a US/USD
-- baseline anchored to the Wells Fargo 2025 allowance study. Parents who
-- want better-tuned suggestions enter age in the wizard / AdminFamily and
-- accept (or override) the auto-detected country.

--> statement-breakpoint
ALTER TABLE "kids"
  ADD COLUMN IF NOT EXISTS "age" integer;

--> statement-breakpoint
ALTER TABLE "families"
  ADD COLUMN IF NOT EXISTS "country" text;

--> statement-breakpoint
ALTER TABLE "families"
  ADD COLUMN IF NOT EXISTS "currency" text;
