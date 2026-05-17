import { count, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { kids, users } from '../db/schema.js';
import { getFamilySubscription } from './billing.js';

/**
 * Plan-aware entitlements for a family. Computed on demand on the server,
 * cached briefly via TanStack Query on the SPA. This is the single source
 * of truth for:
 *
 *   - Free-tier ceilings on parent and kid creation (enforced at the create
 *     endpoints with a 402 `plan_upgrade_required` payload — see auth.ts and
 *     family.ts).
 *   - The PlanUpsellSheet's "X kids remaining" copy on the SPA.
 *   - Lapsed-plan read-only feature gates (push, full history, all badges,
 *     CSV export). Lapsing never deletes existing rows; it just turns the
 *     premium switches off.
 *
 * The Round-2 brief committed:
 *   FREE   → 1 parent, 2 kids; no push; 30-day history; bronze-tier badges
 *            only; no CSV export.
 *   FAMILY → unlimited members, full push, full history, all badges, CSV.
 *
 * Kid sign-in and the Champion-of-the-Week celebration are NEVER paywalled,
 * so they don't appear in `features` here.
 */

export type EntitlementsPlan = 'free' | 'family';

export type Entitlements = {
  plan: EntitlementsPlan;
  status: 'trialing' | 'active' | 'past_due' | 'cancelled' | 'expired';
  limits: { kids: number | null; parents: number | null };
  remaining: { kids: number; parents: number };
  features: {
    push: boolean;
    fullHistory: boolean;
    allBadges: boolean;
    csvExport: boolean;
  };
};

const FREE_KIDS = 2;
const FREE_PARENTS = 1;

export async function getEntitlements(familyId: string): Promise<Entitlements> {
  const sub = await getFamilySubscription(familyId);
  const kidsRows = (await db
    .select({ kidsCount: count(kids.id) })
    .from(kids)
    .where(eq(kids.familyId, familyId))) as Array<{ kidsCount: number }>;
  const parentRows = (await db
    .select({ parentsCount: count(users.id) })
    .from(users)
    .where(eq(users.familyId, familyId))) as Array<{ parentsCount: number }>;
  const kidsCount = kidsRows[0]?.kidsCount ?? 0;
  const parentsCount = parentRows[0]?.parentsCount ?? 0;

  const onFamily =
    sub.plan === 'family' && (sub.status === 'active' || sub.status === 'trialing');

  if (onFamily) {
    return {
      plan: 'family',
      status: sub.status,
      limits: { kids: null, parents: null },
      // Number.MAX_SAFE_INTEGER would serialise oddly; pick a number large
      // enough that the SPA's "X remaining" copy reads as "plenty" and the
      // 402 gate at create endpoints never fires for a family-plan family.
      remaining: { kids: 9999, parents: 9999 },
      features: { push: true, fullHistory: true, allBadges: true, csvExport: true },
    };
  }

  return {
    plan: 'free',
    status: sub.status,
    limits: { kids: FREE_KIDS, parents: FREE_PARENTS },
    remaining: {
      kids: Math.max(0, FREE_KIDS - Number(kidsCount ?? 0)),
      parents: Math.max(0, FREE_PARENTS - Number(parentsCount ?? 0)),
    },
    features: { push: false, fullHistory: false, allBadges: false, csvExport: false },
  };
}
