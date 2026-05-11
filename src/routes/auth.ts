import type { FastifyInstance } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/client.js';
import { families, kids, users, chores } from '../db/schema.js';
import { hashPassword, verifyPassword, verifyPin } from '../auth/password.js';
import { endSession, startKidSession, startParentSession } from '../auth/plugin.js';
import { DEFAULT_CATALOG } from '../domain/defaultCatalog.js';
import { scheduler } from '../scheduler/runner.js';

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

    await startParentSession(reply, user!.id, family!.id);
    return { user: publicUser(user!), family: { id: family!.id, name: family!.name } };
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

    await startParentSession(reply, u.id, u.familyId);
    return { user: publicUser(u) };
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
    await startKidSession(reply, k.id, k.familyId);
    return { kid: { id: k.id, name: k.name, color: k.color, avatar: k.avatar } };
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
}

function publicUser(u: typeof users.$inferSelect) {
  return { id: u.id, email: u.email, name: u.name, role: u.role, familyId: u.familyId };
}
