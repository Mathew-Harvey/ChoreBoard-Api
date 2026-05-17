import type { FastifyInstance } from 'fastify';
import { and, eq, gt, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/client.js';
import {
  familyInvites,
  families,
  kids,
  notificationPrefs,
  sessions,
  users,
} from '../db/schema.js';
import { hashPassword, verifyPassword, verifyPin } from '../auth/password.js';
import {
  endSession,
  pickTransport,
  startKidSession,
  startParentSession,
} from '../auth/plugin.js';
import { newSessionId } from '../auth/sessions.js';
import { scheduler } from '../scheduler/runner.js';
import { bus } from '../realtime/bus.js';
import { config } from '../config.js';
import { getEntitlements } from '../domain/entitlements.js';

export async function authRoutes(app: FastifyInstance): Promise<void> {
  // ----- Parent signup (creates family + seeds catalog) --------------------
  app.post('/auth/signup', async (req, reply) => {
    const body = z
      .object({
        email: z.string().email(),
        password: z.string().min(8),
        name: z.string().min(1).max(64),
        familyName: z.string().min(1).max(64),
        timezone: z.string().default('Australia/Sydney'),
        gender: z.enum(['male', 'female', 'unspecified']).default('unspecified'),
        // Detected by the SPA at signup time (geolocation → reverse-geocode,
        // falling back to navigator.language). Both optional so a Capacitor
        // shell that hasn't surfaced location permission yet still signs
        // up cleanly; AdminFamily can fill them in later. Length-checked to
        // keep noise from poisoning the pricing engine's lookup.
        country: z.string().length(2).optional(),
        currency: z.string().length(3).optional(),
      })
      .parse(req.body);

    const existing = await db.select().from(users).where(eq(users.email, body.email)).limit(1);
    if (existing.length > 0) {
      return reply.code(409).send({ error: 'email_taken' });
    }

    const [family] = await db
      .insert(families)
      .values({
        name: body.familyName,
        timezone: body.timezone,
        country: body.country?.toUpperCase(),
        currency: body.currency?.toUpperCase(),
      })
      .returning();
    const [user] = await db
      .insert(users)
      .values({
        familyId: family!.id,
        email: body.email,
        passwordHash: await hashPassword(body.password),
        name: body.name,
        role: 'owner',
        gender: body.gender,
      })
      .returning();
    await db
      .update(families)
      .set({ ownerUserId: user!.id })
      .where(eq(families.id, family!.id));

    // Backfill the parent's notification_prefs row with permissive defaults
    // and a quiet_tz that matches the family timezone they just chose. PR 6
    // exposes a route for the parent to edit it later.
    await db
      .insert(notificationPrefs)
      .values({ userId: user!.id, quietTz: family!.timezone })
      .onConflictDoNothing({ target: notificationPrefs.userId });

    // No default chore catalog — the four-step OnboardWizard at /onboard
    // (PR 5) lets the parent pick a starter pack against the rule set in
    // the Round-2 brief. Brand-new families land on /onboard with zero
    // chores; ensureWeekCloseJob still primes the Sunday close so the
    // very first week closes cleanly even if no chores ever land in it.
    await scheduler.ensureWeekCloseJob(family!.id);

    const session = await startParentSession(reply, user!.id, family!.id, pickTransport(req));
    return {
      user: publicUser(user!),
      family: { id: family!.id, name: family!.name },
      session,
    };
  });

  // ----- Parent login ------------------------------------------------------
  app.post('/auth/login', async (req, reply) => {
    const body = z
      .object({ email: z.string().email(), password: z.string() })
      .parse(req.body);
    const [u] = await db.select().from(users).where(eq(users.email, body.email)).limit(1);
    if (!u) return reply.code(401).send({ error: 'invalid_credentials' });
    const ok = await verifyPassword(u.passwordHash, body.password);
    if (!ok) return reply.code(401).send({ error: 'invalid_credentials' });

    const session = await startParentSession(reply, u.id, u.familyId, pickTransport(req));
    return { user: publicUser(u), session };
  });

  // ----- Parent elevation on a shared family device ------------------------
  //
  // Used by the "Sign me in to approve" sheet on the kitchen tablet (PR 7).
  // A kid is signed in on this device; a parent walks up to approve a
  // pending chore. They enter their email + password; we mint a fresh
  // parent session stamped with elevation_expires_at = now + idle minutes.
  // Every subsequent write on this session bumps the timer; reads do not.
  // After idle-out, the session row is deleted by the auth plugin and the
  // device falls back to the kid principal.
  //
  // Mechanically distinct from /auth/login so we can rate-limit it later
  // and so callers (the SPA's ParentSignInSheet) get a clear contract:
  // the response token replaces the active session, but only briefly.
  app.post('/auth/elevate', async (req, reply) => {
    const body = z
      .object({ email: z.string().email(), password: z.string() })
      .parse(req.body);
    const [u] = await db.select().from(users).where(eq(users.email, body.email)).limit(1);
    if (!u) return reply.code(401).send({ error: 'invalid_credentials' });
    const ok = await verifyPassword(u.passwordHash, body.password);
    if (!ok) return reply.code(401).send({ error: 'invalid_credentials' });

    const transport = pickTransport(req);
    const elevationExpiresAt = new Date(
      Date.now() + config.parentTabletIdleMin * 60 * 1000,
    );
    const [session] = await db
      .insert(sessions)
      .values({
        id: newSessionId(),
        userId: u.id,
        familyId: u.familyId,
        transport,
        expiresAt: new Date(Date.now() + config.sessionTtlDays * 24 * 60 * 60 * 1000),
        elevationExpiresAt,
      })
      .returning();
    if (transport === 'cookie') reply.setSessionCookie(session!.id);
    return {
      user: publicUser(u),
      session: {
        token: session!.id,
        expiresAt: session!.expiresAt.toISOString(),
        elevationExpiresAt: elevationExpiresAt.toISOString(),
      },
    };
  });

  // ----- Family kid roster (for the PIN entry screen) ----------------------
  // Returns just enough info to pick which kid you are. No PIN hashes.
  app.get('/auth/family/:familyId/kids', async (req, _reply) => {
    const params = z.object({ familyId: z.string().uuid() }).parse(req.params);
    const list = await db
      .select({
        id: kids.id,
        name: kids.name,
        color: kids.color,
        avatar: kids.avatar,
        gender: kids.gender,
      })
      .from(kids)
      .where(eq(kids.familyId, params.familyId));
    return { kids: list };
  });

  // ----- Kid PIN login -----------------------------------------------------
  app.post('/auth/kid-login', async (req, reply) => {
    const body = z
      .object({ kidId: z.string().uuid(), pin: z.string().regex(/^\d{4}$/) })
      .parse(req.body);
    const [k] = await db.select().from(kids).where(eq(kids.id, body.kidId)).limit(1);
    if (!k) return reply.code(401).send({ error: 'invalid_pin' });
    const ok = await verifyPin(k.pinHash, body.pin);
    if (!ok) return reply.code(401).send({ error: 'invalid_pin' });
    const session = await startKidSession(reply, k.id, k.familyId, pickTransport(req));
    return {
      kid: { id: k.id, name: k.name, color: k.color, avatar: k.avatar, gender: k.gender },
      session,
    };
  });

  // ----- Logout ------------------------------------------------------------
  app.post('/auth/logout', async (req, reply) => {
    await endSession(req, reply);
    return { ok: true };
  });

  // ----- Whoami ------------------------------------------------------------
  app.get('/auth/me', async (req, _reply) => {
    if (!req.principal) return { principal: null, entitlements: null };
    // Co-locate entitlements with the session response so the SPA's
    // useEntitlements hook (PR 8) doesn't need a second round trip on
    // every page load. Returned for kid principals too — the kid-side UI
    // doesn't show paywalled features but the entitlements payload tells
    // the kid's tablet whether the family is on the Family plan, which
    // matters for things like badge ceilings. Recomputed every call;
    // cheap enough to not warrant memoisation today.
    const entitlements = await getEntitlements(req.principal.familyId);
    return { principal: req.principal, entitlements };
  });

  // ----- Mark onboarding complete (any parent of the family) ---------------
  // Called by the final step of OnboardWizard at /onboard once the parent
  // has named the family payout day, added at least one kid, picked a
  // starter pack, and seen (or skipped) the device-pairing code. Idempotent:
  // setting it twice does no harm. Until this is non-null the SPA's parent
  // route guard redirects every signed-in parent to /onboard.
  app.post('/auth/onboarding/complete', async (req) => {
    const p = req.requireParent();
    await db
      .update(families)
      .set({ onboardingCompletedAt: new Date() })
      .where(eq(families.id, p.familyId));
    bus.publish(p.familyId, { type: 'family.updated' });
    return { ok: true };
  });

  // ----- Delete own account ------------------------------------------------
  // A non-owner parent can delete their own user account. Owners must use
  // DELETE /auth/family below (which deletes the entire family) — orphaning
  // the family is worse than a clear refusal here.
  //
  // Kids are managed by parents via /family/kids/:id and can't self-delete
  // from a shared device.
  app.delete('/auth/me', async (req, reply) => {
    const p = req.requireParent();
    if (p.role === 'owner') {
      return reply.code(409).send({ error: 'owner_cannot_self_delete' });
    }

    // Drop sessions explicitly: the column has no FK so cascade won't catch them.
    await db.delete(sessions).where(eq(sessions.userId, p.userId));
    await db.delete(users).where(eq(users.id, p.userId));

    reply.clearSessionCookie();
    bus.publish(p.familyId, { type: 'family.updated' });
    return { ok: true };
  });

  // ----- Co-parent invites: public lookup + accept ------------------------
  //
  // The owner-side of this flow (create / revoke) lives in /family/invites.
  // The two endpoints below are deliberately *unauthenticated* — the bearer
  // of the URL is the principal — so a new parent who doesn't yet have a
  // ChoreBoard account can preview the invite and then join.

  // Look up an invite by token. Returns a small public projection so the
  // join screen can render "Join the Smith family — invited by Sam".
  // Doesn't reveal anything else about the family (e.g. kid names) before
  // the joiner commits.
  app.get('/auth/invites/:token', async (req, reply) => {
    const params = z.object({ token: z.string().min(8).max(128) }).parse(req.params);
    const result = await lookupInvite(params.token);
    if (result.kind !== 'ok') {
      return reply.code(result.kind === 'not_found' ? 404 : 410).send({ error: result.kind });
    }
    return {
      invite: {
        familyName: result.familyName,
        invitedByName: result.invitedByName,
        expiresAt: result.invite.expiresAt.toISOString(),
      },
    };
  });

  // Accept an invite and create the second parent. Mirrors signup's shape
  // (returns `{ user, family, session }`) so the SPA can hand off to the
  // dashboard the same way it does after signup/login.
  app.post('/auth/invites/:token/accept', async (req, reply) => {
    const params = z.object({ token: z.string().min(8).max(128) }).parse(req.params);
    const body = z
      .object({
        email: z.string().email(),
        password: z.string().min(8),
        name: z.string().min(1).max(64),
        gender: z.enum(['male', 'female', 'unspecified']).default('unspecified'),
      })
      .parse(req.body);

    const result = await lookupInvite(params.token);
    if (result.kind !== 'ok') {
      return reply.code(result.kind === 'not_found' ? 404 : 410).send({ error: result.kind });
    }

    const existing = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, body.email))
      .limit(1);
    if (existing.length > 0) {
      return reply.code(409).send({ error: 'email_taken' });
    }

    // Free-tier parent cap. The invite link still goes out, but if the
    // family slipped onto free since it was issued (cancellation, lapse)
    // we 402 here so the joiner sees an upgrade prompt rather than a
    // silently-fragile second-parent seat.
    const ent = await getEntitlements(result.invite.familyId);
    if (ent.remaining.parents <= 0) {
      return reply.code(402).send({
        error: 'plan_upgrade_required',
        blockedBy: 'parents_max',
        currentPlan: ent.plan,
        limits: ent.limits,
      });
    }

    const passwordHash = await hashPassword(body.password);
    let accepted: { newUser: typeof users.$inferSelect };
    try {
      accepted = await db.transaction(async (tx) => {
        const now = new Date();
        const [claimedInvite] = await tx
          .update(familyInvites)
          .set({ consumedAt: now })
          .where(
            and(
              eq(familyInvites.id, result.invite.id),
              isNull(familyInvites.consumedAt),
              isNull(familyInvites.revokedAt),
              gt(familyInvites.expiresAt, now),
            ),
          )
          .returning();
        if (!claimedInvite) {
          throw new InviteAcceptError(410, 'invite_consumed');
        }

        const [newUser] = await tx
          .insert(users)
          .values({
            familyId: claimedInvite.familyId,
            email: body.email,
            passwordHash,
            name: body.name,
            role: 'parent',
            gender: body.gender,
          })
          .returning();

        await tx
          .update(familyInvites)
          .set({ consumedByUserId: newUser!.id })
          .where(eq(familyInvites.id, claimedInvite.id));

        // Backfill notification prefs (PR 6). Inherits the family's tz at
        // create — the new co-parent can change `quiet_tz` later if they
        // travel.
        const [fam] = await tx
          .select({ tz: families.timezone })
          .from(families)
          .where(eq(families.id, claimedInvite.familyId))
          .limit(1);
        await tx
          .insert(notificationPrefs)
          .values({ userId: newUser!.id, quietTz: fam?.tz ?? 'Australia/Sydney' })
          .onConflictDoNothing({ target: notificationPrefs.userId });

        return { newUser: newUser! };
      });
    } catch (e) {
      if (e instanceof InviteAcceptError) {
        return reply.code(e.status).send({ error: e.code });
      }
      throw e;
    }

    const session = await startParentSession(
      reply,
      accepted.newUser.id,
      accepted.newUser.familyId,
      pickTransport(req),
    );
    bus.publish(accepted.newUser.familyId, { type: 'family.updated' });

    return {
      user: publicUser(accepted.newUser),
      family: { id: result.invite.familyId, name: result.familyName },
      session,
    };
  });

  // ----- Owner: delete entire family --------------------------------------
  // Both the App Store and Play Store require an in-app account deletion
  // path. For an owner, "delete my account" semantically means "delete the
  // family" because the family can't keep running without one — there is no
  // ownership-transfer flow in v1.
  //
  // This deletes the family row, which cascades to users, kids, chores,
  // chore_instances, ledger_entries, weeks, goals, badges_awarded, streaks,
  // xp_log, sessions, push_subscriptions (via users), device_tokens (via
  // users), subscriptions, and scheduled_jobs. (See schema.ts for the
  // ON DELETE CASCADE relationships.)
  //
  // The owner's own login is invalidated when their session row is wiped by
  // the cascade through `users → families`.
  app.delete('/auth/family', async (req, reply) => {
    const p = req.requireParent();
    if (p.role !== 'owner') {
      return reply.code(403).send({ error: 'owner_only' });
    }
    const body = z
      .object({
        // Defence-in-depth: require the owner to type their family name to
        // confirm. Mirrors the GitHub "delete this repo" UX.
        confirmFamilyName: z.string().min(1).max(64),
      })
      .parse(req.body);

    const [fam] = await db
      .select({ id: families.id, name: families.name })
      .from(families)
      .where(eq(families.id, p.familyId))
      .limit(1);
    if (!fam) return reply.code(404).send({ error: 'not_found' });
    if (body.confirmFamilyName !== fam.name) {
      return reply.code(400).send({ error: 'confirmation_mismatch' });
    }

    bus.publish(p.familyId, { type: 'family.updated' });
    await db.delete(families).where(eq(families.id, fam.id));
    reply.clearSessionCookie();
    return { ok: true };
  });
}

function publicUser(u: typeof users.$inferSelect) {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    role: u.role,
    familyId: u.familyId,
    color: u.color,
    gender: u.gender,
  };
}

class InviteAcceptError extends Error {
  constructor(
    public status: number,
    public code: string,
  ) {
    super(code);
  }
}

// Resolve an invite token to the family + inviter context, or a typed
// reason it isn't usable. Centralised so GET and POST share one code path.
type InviteLookup =
  | {
      kind: 'ok';
      invite: typeof familyInvites.$inferSelect;
      familyName: string;
      invitedByName: string | null;
    }
  | { kind: 'not_found' }
  | { kind: 'invite_consumed' }
  | { kind: 'invite_revoked' }
  | { kind: 'invite_expired' };

async function lookupInvite(token: string): Promise<InviteLookup> {
  const [row] = await db
    .select()
    .from(familyInvites)
    .where(eq(familyInvites.token, token))
    .limit(1);
  if (!row) return { kind: 'not_found' };
  if (row.consumedAt) return { kind: 'invite_consumed' };
  if (row.revokedAt) return { kind: 'invite_revoked' };
  if (row.expiresAt.getTime() <= Date.now()) return { kind: 'invite_expired' };

  const [fam] = await db
    .select({ id: families.id, name: families.name })
    .from(families)
    .where(eq(families.id, row.familyId))
    .limit(1);
  if (!fam) return { kind: 'not_found' };

  let invitedByName: string | null = null;
  if (row.createdByUserId) {
    const [u] = await db
      .select({ name: users.name })
      .from(users)
      .where(eq(users.id, row.createdByUserId))
      .limit(1);
    invitedByName = u?.name ?? null;
  }

  return { kind: 'ok', invite: row, familyName: fam.name, invitedByName };
}
