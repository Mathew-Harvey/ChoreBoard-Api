import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  config,
  isAppleIapConfigured,
  isGooglePlayConfigured,
  isStripeConfigured,
} from '../config.js';
import { getStripe } from '../integrations/stripe.js';
import {
  getFamilySubscription,
  recordBillingEvent,
  markEventProcessed,
  upsertSubscription,
} from '../domain/billing.js';

/**
 * Billing routes — three rails, one canonical `subscriptions` row per family.
 *
 *   POST /billing/stripe/checkout   → returns Stripe Checkout URL (web only)
 *   POST /billing/stripe/portal     → returns Stripe billing portal URL
 *   POST /billing/stripe/webhook    → Stripe events (signature verified)
 *   POST /billing/iap/verify        → native passes a fresh receipt; we verify
 *   POST /billing/iap/webhook/apple → App Store Server Notifications v2
 *   POST /billing/iap/webhook/google→ Google Real-Time Developer Notifications
 *   GET  /billing/me                → returns current plan/state for the UI
 *
 * All write paths return 501 `not_configured` if the relevant rail's keys
 * aren't set in env, so the code is safe to deploy from day one and you can
 * flip on rails as you create accounts.
 *
 * Anti-steering: native clients NEVER call /billing/stripe/* and web clients
 * NEVER call /billing/iap/*. The server still allows both because tests, but
 * the client gates the surfaces.
 */
export async function billingRoutes(app: FastifyInstance): Promise<void> {
  // ----- Headline price quote ----------------------------------------------
  // Used by the SPA's PlanUpsellSheet so the price string is never hardcoded
  // in the bundle. Marketing locks `PRICING_HEADLINE_CENTS` and
  // `PRICING_CURRENCY` in env; this endpoint just echoes them back. Public
  // (unauthenticated) so the upsell can render even on the very first
  // signed-in render before the session query has settled.
  app.get('/billing/quote', async () => ({
    headlinePriceCents: config.pricing.headlinePriceCents,
    currency: config.pricing.currency,
  }));

  // ----- Status ------------------------------------------------------------
  app.get('/billing/me', async (req) => {
    const p = req.requireParent();
    const sub = await getFamilySubscription(p.familyId);
    return {
      subscription: sub,
      surfaces: {
        stripe: isStripeConfigured(),
        apple: isAppleIapConfigured(),
        google: isGooglePlayConfigured(),
      },
    };
  });

  // -----------------------------------------------------------------------
  // Stripe — web subscriptions
  // -----------------------------------------------------------------------

  app.post('/billing/stripe/checkout', async (req, reply) => {
    const p = req.requireParent();
    if (p.role !== 'owner') return reply.code(403).send({ error: 'owner_only' });
    const stripe = getStripe();
    if (!stripe) return reply.code(501).send({ error: 'not_configured' });

    const body = z
      .object({
        successUrl: z.string().url().optional(),
        cancelUrl: z.string().url().optional(),
      })
      .parse(req.body ?? {});

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: config.stripePriceFamily, quantity: 1 }],
      // We use client_reference_id to bind the Checkout session to the family
      // long before any Stripe Customer object exists. The webhook reads it
      // back to know which family to credit.
      client_reference_id: p.familyId,
      customer_email: p.email,
      success_url: body.successUrl ?? `${config.appUrl}/admin/billing?status=success`,
      cancel_url: body.cancelUrl ?? `${config.appUrl}/admin/billing?status=cancelled`,
      allow_promotion_codes: true,
      subscription_data: {
        metadata: { familyId: p.familyId, ownerUserId: p.userId },
      },
    });

    return { url: session.url };
  });

  app.post('/billing/stripe/portal', async (req, reply) => {
    const p = req.requireParent();
    if (p.role !== 'owner') return reply.code(403).send({ error: 'owner_only' });
    const stripe = getStripe();
    if (!stripe) return reply.code(501).send({ error: 'not_configured' });

    const sub = await getFamilySubscription(p.familyId);
    if (sub.source !== 'stripe' || !sub.externalId) {
      return reply.code(409).send({ error: 'no_stripe_subscription' });
    }

    const stripeSub = await stripe.subscriptions.retrieve(sub.externalId);
    const customerId =
      typeof stripeSub.customer === 'string' ? stripeSub.customer : stripeSub.customer.id;

    const portal = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: `${config.appUrl}/admin/billing`,
    });
    return { url: portal.url };
  });

  // -----------------------------------------------------------------------
  // Stripe webhook — encapsulated so its raw-body parser doesn't bleed.
  // -----------------------------------------------------------------------
  //
  // Stripe webhook signature verification needs the *byte-exact* request
  // body. Fastify's default JSON parser turns the body into an object before
  // we ever see it, which would break verification. We solve this by
  // registering a child Fastify scope (`register`) that swaps in a
  // buffer-preserving JSON parser. The parser is encapsulated to just the
  // routes inside this register call — every other route in the app keeps
  // the default behaviour.
  await app.register(async (webhook) => {
    webhook.addContentTypeParser(
      'application/json',
      { parseAs: 'buffer' },
      (req, body, done) => {
        (req as unknown as { rawBody: Buffer }).rawBody = body as Buffer;
        try {
          const parsed = (body as Buffer).length === 0 ? null : JSON.parse((body as Buffer).toString('utf8'));
          done(null, parsed);
        } catch (err) {
          done(err as Error, undefined);
        }
      },
    );

    webhook.post('/billing/stripe/webhook', async (req, reply) => {
      const stripe = getStripe();
      if (!stripe) return reply.code(501).send({ error: 'not_configured' });
      const sig = req.headers['stripe-signature'];
      if (typeof sig !== 'string') {
        return reply.code(400).send({ error: 'missing_signature' });
      }

      const raw = (req as unknown as { rawBody?: Buffer }).rawBody;
      if (!raw) return reply.code(400).send({ error: 'missing_raw_body' });

      let event: import('stripe').default.Event;
      try {
        event = stripe.webhooks.constructEvent(raw, sig, config.stripeWebhookSecret);
      } catch (err: any) {
        req.log.warn({ err }, 'stripe_webhook_signature_failed');
        return reply.code(400).send({ error: 'bad_signature' });
      }

      const familyId = resolveStripeFamilyId(event);
      const fresh = await recordBillingEvent({
        source: 'stripe',
        externalEventId: event.id,
        kind: event.type,
        familyId,
        payload: event,
      });
      if (!fresh) {
        // Duplicate webhook — already processed. Stripe retries on 5xx so
        // we ack with 200 to stop the retry loop.
        return { ok: true, duplicate: true };
      }

      try {
        await applyStripeEvent(stripe, event);
        await markEventProcessed({ source: 'stripe', externalEventId: event.id });
      } catch (err: any) {
        await markEventProcessed({
          source: 'stripe',
          externalEventId: event.id,
          error: err?.message ?? String(err),
        });
        throw err;
      }
      return { ok: true };
    });
  });

  // -----------------------------------------------------------------------
  // Apple StoreKit / Google Play Billing — native IAP
  // -----------------------------------------------------------------------

  app.post('/billing/iap/verify', async (req, reply) => {
    const p = req.requireParent();
    if (p.role !== 'owner') return reply.code(403).send({ error: 'owner_only' });

    const body = z
      .discriminatedUnion('source', [
        z.object({
          source: z.literal('apple'),
          // Base64-encoded App Store receipt (StoreKit 1) OR the JWS signed
          // transaction (StoreKit 2). For v1 we accept both shapes; the
          // verifier picks based on whether it parses as JWS.
          receipt: z.string().min(1),
          productId: z.string().min(1),
          transactionId: z.string().min(1),
        }),
        z.object({
          source: z.literal('google'),
          purchaseToken: z.string().min(1),
          productId: z.string().min(1),
        }),
      ])
      .parse(req.body);

    if (body.source === 'apple') {
      if (!isAppleIapConfigured()) return reply.code(501).send({ error: 'not_configured' });
      // TODO(v1.x): call App Store Server API verifyTransaction or
      // /verifyReceipt with `password = config.appleSharedSecret`. On
      // success, upsertSubscription({ source: 'apple', externalId:
      // originalTransactionId, currentPeriodEnd: <expiresDate>, ... }).
      //
      // Until then we accept the raw transaction id as ground truth in dev
      // so the native UI path is testable end to end. This is GATED on
      // NODE_ENV !== 'production' so we never accept unverified IAPs in prod.
      if (config.nodeEnv === 'production') {
        return reply.code(501).send({ error: 'apple_verifier_not_implemented' });
      }
      await upsertSubscription({
        familyId: p.familyId,
        plan: 'family',
        status: 'active',
        source: 'apple',
        externalId: body.transactionId,
        currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      });
      return { ok: true, dev_unverified: true };
    }

    // Google
    if (!isGooglePlayConfigured()) return reply.code(501).send({ error: 'not_configured' });
    if (config.nodeEnv === 'production') {
      // TODO(v1.x): call androidpublisher.purchases.subscriptionsv2.get with
      // `purchaseToken`, `packageName = config.googlePlayPackageName`. On
      // success, upsertSubscription({ source: 'google', externalId:
      // body.purchaseToken, currentPeriodEnd: <expiryTimeMillis> }).
      return reply.code(501).send({ error: 'google_verifier_not_implemented' });
    }
    await upsertSubscription({
      familyId: p.familyId,
      plan: 'family',
      status: 'active',
      source: 'google',
      externalId: body.purchaseToken,
      currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    });
    return { ok: true, dev_unverified: true };
  });

  app.post('/billing/iap/webhook/apple', async (req, reply) => {
    if (!isAppleIapConfigured()) return reply.code(501).send({ error: 'not_configured' });
    // App Store Server Notifications v2 are signed JWS payloads.
    const body = z
      .object({
        signedPayload: z.string().min(1),
      })
      .parse(req.body);

    // TODO(v1.x): JWS-verify with Apple's root cert chain, then unwrap the
    // notificationType + signedTransactionInfo to upsert the subscription.
    //
    // For now we record the event so the audit trail is intact:
    const eventId = `apple:${Date.now()}:${body.signedPayload.length}`;
    await recordBillingEvent({
      source: 'apple',
      externalEventId: eventId,
      kind: 'unverified_v2_notification',
      payload: body,
    });
    req.log.warn('apple_iap_webhook_received_but_verifier_not_implemented');
    return reply.code(202).send({ ok: true, queued: true });
  });

  app.post('/billing/iap/webhook/google', async (req, reply) => {
    if (!isGooglePlayConfigured()) return reply.code(501).send({ error: 'not_configured' });
    // Google Real-Time Developer Notifications are Pub/Sub push messages
    // wrapping a base64-encoded subscription notification.
    const body = z
      .object({
        message: z.object({
          data: z.string().min(1),
          messageId: z.string(),
        }),
      })
      .parse(req.body);

    // TODO(v1.x): base64-decode body.message.data, JSON.parse, validate the
    // packageName matches config.googlePlayPackageName, then call
    // androidpublisher.purchases.subscriptionsv2.get to get the canonical
    // state and upsertSubscription accordingly.
    await recordBillingEvent({
      source: 'google',
      externalEventId: `google:${body.message.messageId}`,
      kind: 'unverified_rtdn',
      payload: body,
    });
    req.log.warn('google_iap_webhook_received_but_verifier_not_implemented');
    return reply.code(202).send({ ok: true, queued: true });
  });
}

// ---------------------------------------------------------------------------
// Stripe event projector
// ---------------------------------------------------------------------------
//
// Note on field access: Stripe's TypeScript types correspond to their newest
// API version, which dropped a few top-level fields (subscription.current_period_end,
// invoice.subscription) in favour of nested shapes. We pin to API version
// 2024-06-20 in `getStripe()`, where those fields are still emitted, so we
// read them via small adapter helpers that cast to a permissive local shape.
// This keeps the rest of the file fully typed without lying about the API.

type StripeSub = import('stripe').default.Subscription & {
  current_period_end: number;
  cancel_at: number | null;
};

type StripeInvoice = import('stripe').default.Invoice & {
  subscription: string | { id: string } | null;
};

async function applyStripeEvent(
  stripe: import('stripe').default,
  event: import('stripe').default.Event,
): Promise<void> {
  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object as import('stripe').default.Checkout.Session;
      const familyId = session.client_reference_id;
      if (!familyId || !session.subscription) return;
      const subId =
        typeof session.subscription === 'string' ? session.subscription : session.subscription.id;
      const sub = (await stripe.subscriptions.retrieve(subId)) as unknown as StripeSub;
      await upsertSubscription({
        familyId,
        plan: 'family',
        status: mapStripeStatus(sub.status),
        source: 'stripe',
        externalId: sub.id,
        currentPeriodEnd: new Date(sub.current_period_end * 1000),
        cancelAt: sub.cancel_at ? new Date(sub.cancel_at * 1000) : null,
      });
      return;
    }
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      const sub = event.data.object as StripeSub;
      const familyId =
        (sub.metadata?.familyId as string | undefined) ??
        (await resolveFamilyIdFromStripeSubscription(sub.id));
      if (!familyId) return;
      await upsertSubscription({
        familyId,
        plan: sub.status === 'canceled' || sub.status === 'unpaid' ? 'free' : 'family',
        status: mapStripeStatus(sub.status),
        source: 'stripe',
        externalId: sub.id,
        currentPeriodEnd: new Date(sub.current_period_end * 1000),
        cancelAt: sub.cancel_at ? new Date(sub.cancel_at * 1000) : null,
      });
      return;
    }
    case 'invoice.payment_failed': {
      const invoice = event.data.object as StripeInvoice;
      if (!invoice.subscription) return;
      const subId =
        typeof invoice.subscription === 'string' ? invoice.subscription : invoice.subscription.id;
      const sub = (await stripe.subscriptions.retrieve(subId)) as unknown as StripeSub;
      const familyId =
        (sub.metadata?.familyId as string | undefined) ??
        (await resolveFamilyIdFromStripeSubscription(sub.id));
      if (!familyId) return;
      await upsertSubscription({
        familyId,
        plan: 'family',
        status: 'past_due',
        source: 'stripe',
        externalId: sub.id,
        currentPeriodEnd: new Date(sub.current_period_end * 1000),
      });
      return;
    }
    default:
      // Many other event types we deliberately ignore.
      return;
  }
}

function mapStripeStatus(
  s: import('stripe').default.Subscription.Status,
): 'trialing' | 'active' | 'past_due' | 'cancelled' | 'expired' {
  switch (s) {
    case 'trialing':
      return 'trialing';
    case 'active':
      return 'active';
    case 'past_due':
    case 'unpaid':
      return 'past_due';
    case 'canceled':
      return 'cancelled';
    default:
      return 'expired';
  }
}

function resolveStripeFamilyId(event: import('stripe').default.Event): string | null {
  const obj = event.data.object as unknown as {
    client_reference_id?: string;
    metadata?: Record<string, string>;
    subscription_data?: { metadata?: Record<string, string> };
  };
  if (typeof obj?.client_reference_id === 'string') return obj.client_reference_id;
  if (obj?.metadata?.familyId) return obj.metadata.familyId;
  if (obj?.subscription_data?.metadata?.familyId) {
    return obj.subscription_data.metadata.familyId;
  }
  return null;
}

async function resolveFamilyIdFromStripeSubscription(subId: string): Promise<string | null> {
  const stripe = getStripe();
  if (!stripe) return null;
  try {
    const sub = await stripe.subscriptions.retrieve(subId);
    return (sub.metadata?.familyId as string | undefined) ?? null;
  } catch {
    return null;
  }
}
