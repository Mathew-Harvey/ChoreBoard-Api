import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  billingEvents,
  subscriptions,
  type subscriptionSourceEnum,
  type subscriptionStatusEnum,
  type subscriptionPlanEnum,
} from '../db/schema.js';

type Source = (typeof subscriptionSourceEnum.enumValues)[number];
type Status = (typeof subscriptionStatusEnum.enumValues)[number];
type Plan = (typeof subscriptionPlanEnum.enumValues)[number];

/**
 * Get (or default-construct) the current subscription record for a family.
 * Every family is presumed to be on the free plan until proven otherwise.
 */
export async function getFamilySubscription(familyId: string): Promise<{
  plan: Plan;
  status: Status;
  source: Source | null;
  externalId: string | null;
  currentPeriodEnd: Date | null;
  cancelAt: Date | null;
}> {
  const [row] = await db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.familyId, familyId))
    .limit(1);
  if (!row) {
    return {
      plan: 'free',
      status: 'active',
      source: null,
      externalId: null,
      currentPeriodEnd: null,
      cancelAt: null,
    };
  }
  return {
    plan: row.plan,
    status: row.status,
    source: row.source,
    externalId: row.externalId,
    currentPeriodEnd: row.currentPeriodEnd,
    cancelAt: row.cancelAt,
  };
}

/**
 * Apply a state change from any of our three rails (Stripe, Apple, Google)
 * into the canonical `subscriptions` row for the family.
 *
 * Conflict policy: if the family already has an active sub from a different
 * `source`, the most recently renewed wins. The other one is left in place
 * but the UI surfaces a "you have a duplicate, please cancel one" warning.
 *
 * For v1 we keep this simple: the latest write to upsertSubscription is the
 * truth. Cross-source dedupe is a follow-up; the `billing_events` log is the
 * audit trail.
 */
export async function upsertSubscription(input: {
  familyId: string;
  plan: Plan;
  status: Status;
  source: Source;
  externalId: string;
  currentPeriodEnd: Date | null;
  cancelAt?: Date | null;
}): Promise<void> {
  const now = new Date();
  await db
    .insert(subscriptions)
    .values({
      familyId: input.familyId,
      plan: input.plan,
      status: input.status,
      source: input.source,
      externalId: input.externalId,
      currentPeriodEnd: input.currentPeriodEnd,
      cancelAt: input.cancelAt ?? null,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: subscriptions.familyId,
      set: {
        plan: input.plan,
        status: input.status,
        source: input.source,
        externalId: input.externalId,
        currentPeriodEnd: input.currentPeriodEnd,
        cancelAt: input.cancelAt ?? null,
        updatedAt: now,
      },
    });
}

/**
 * Append-only audit log for every webhook / receipt verification we receive.
 * Idempotent on `(source, external_event_id)` so retries are safe.
 *
 * Returns true if the event was newly recorded, false if we'd already seen it.
 */
export async function recordBillingEvent(input: {
  source: Source;
  externalEventId: string;
  kind: string;
  familyId?: string | null;
  payload: unknown;
}): Promise<boolean> {
  try {
    await db.insert(billingEvents).values({
      source: input.source,
      externalEventId: input.externalEventId,
      kind: input.kind,
      familyId: input.familyId ?? null,
      payloadJson: input.payload as object,
    });
    return true;
  } catch (err: any) {
    // Unique-constraint violation on (source, external_event_id) means the
    // event is a duplicate. Postgres error code 23505 = unique_violation.
    if (err?.code === '23505') return false;
    throw err;
  }
}

export async function markEventProcessed(input: {
  source: Source;
  externalEventId: string;
  error?: string | null;
}): Promise<void> {
  await db
    .update(billingEvents)
    .set({
      processedAt: new Date(),
      error: input.error ?? null,
    })
    .where(eq(billingEvents.externalEventId, input.externalEventId));
}
