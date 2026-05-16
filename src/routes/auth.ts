import type { FastifyInstance } from 'fastify';
import { and, eq, gt, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/client.js';
import { familyInvites, families, kids, users, chores, sessions } from '../db/schema.js';
import { hashPassword, verifyPassword, verifyPin } from '../auth/password.js';
import {
  endSession,
  pickTransport,
  startKidSession,
  startParentSession,
} from '../auth/plugin.js';
import { DEFAULT_CATALOG } from '../domain/defaultCatalog.js';
import { scheduler } from '../scheduler/runner.js';
import { bus } from '../realtime/bus.js';

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
      })
      .parse(req.body);

    const existing = await db.select().from(users).where(eq(users.email, body.email)).limit(1);
    if (existing.length > 0) {
      return reply.code(409).send({ error: 'email_taken' });
    }

    const [family] = await db
      .insert(families)
      .values({ name: body.familyName, timezone: body.timezone })
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

    // Seed default catalog.
    for (const c of DEFAULT_CATALOG) {
      await db.insert(chores).values({
        familyId: family!.id,
        name: c.name,
        amountCents: c.amountCents,
        cadenceJson: c.cadence,
      });
    }
    await scheduler.materializeFamily(family!.id);
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

  // List families by name (so a kid on a fresh device can find their household).
  // For simplicity v1 has a single-tenant search; you'd want to scope this by code in prod.
  app.get('/auth/families', async (req, _reply) => {
    const q = z.object({ q: z.string().min(1).max(64) }).parse(req.query);
    const list = await db
      .select({ id: families.id, name: families.name })
      .from(families)
      .where(eq(families.name, q.q))
      .limit(10);
    return { families: list };
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
    if (!req.principal) return { principal: null };
    return { principal: req.principal };
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
