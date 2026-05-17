-- Backfill `families.onboarding_completed_at` for every family that
-- existed before the OnboardWizard landed.
--
-- The PR 5 wizard treats `onboarding_completed_at IS NULL` as the gate to
-- redirect parents to /onboard. Migration 0008 added the column with
-- default NULL, which is correct for families created AFTER the wizard
-- shipped — they need to actually go through it. But every family that
-- was set up via the old signup path has already chosen kids, chores,
-- payout settings, etc., and would otherwise be ambushed by the wizard
-- on next login.
--
-- The COALESCE keeps the migration idempotent on re-run: if the column
-- has been re-zeroed for some reason, only true NULLs get stamped, and
-- families currently mid-wizard (column already non-null) are left alone.

UPDATE "families"
   SET "onboarding_completed_at" = COALESCE("onboarding_completed_at", NOW())
 WHERE "onboarding_completed_at" IS NULL;
