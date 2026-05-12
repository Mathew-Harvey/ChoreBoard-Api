import type { FastifyInstance } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/client.js';
import { families, kids, users, chores, sessions } from '../db/schema.js';
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
      .select({ id: kids.id, name: kids.name, color: kids.color, avatar: kids.avatar })
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
      kid: { id: k.id, name: k.name, color: k.color, avatar: k.avatar },
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
  return { id: u.id, email: u.email, name: u.name, role: u.role, familyId: u.familyId };
}
