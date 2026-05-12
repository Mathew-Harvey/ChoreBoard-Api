import Stripe from 'stripe';
import { config, isStripeConfigured } from '../config.js';

let cached: Stripe | null = null;

/**
 * Lazily build a Stripe client. Returns null when no `STRIPE_SECRET_KEY` is
 * configured so the routes can return a clean 501 instead of crashing.
 *
 * We pin to API version `2024-06-20` because at that version subscriptions
 * still expose `current_period_end` at the top level. Newer API versions
 * moved that field onto subscription items, which the v22 SDK types
 * already reflect — but we deliberately stay one major behind so existing
 * webhook handlers keep working.
 */
export function getStripe(): Stripe | null {
  if (!isStripeConfigured()) return null;
  if (!cached) {
    // We pass apiVersion via a typed cast because Stripe's union of valid
    // versions is intentionally narrow to the SDK's "latest". Pinning to a
    // known-good older version is supported at runtime, just not in the
    // type definitions.
    // The SDK only types the most recent API version in its `apiVersion`
    // field, but pinning to an older version is supported at runtime — and
    // recommended, so SDK upgrades don't quietly change webhook payload
    // shapes. We cast to `any` for the version string only.
    cached = new Stripe(config.stripeSecretKey, {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      apiVersion: '2024-06-20' as any,
      appInfo: { name: 'ChoreBoard', version: '0.1.0' },
    });
  }
  return cached;
}
