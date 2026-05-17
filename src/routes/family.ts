import type { FastifyInstance } from 'fastify';
import { and, desc, eq, gt, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { nanoid } from 'nanoid';
import { db } from '../db/client.js';
import { familyInvites, families, kids, sessions, users } from '../db/schema.js';
import { hashPin } from '../auth/password.js';
import { bus } from '../realtime/bus.js';
import { scheduler } from '../scheduler/runner.js';
import { config } from '../config.js';
import { getEntitlements } from '../domain/entitlements.js';

function buildInviteUrl(token: string): string {
  return `${config.appUrl.replace(/\/$/, '')}/join/${token}`;
}

function publicInvite(row: typeof familyInvites.$inferSelect) {
  return {
    id: row.id,
    token: row.token,
    url: buildInviteUrl(row.token),
    expiresAt: row.expiresAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    createdByUserId: row.createdByUserId,
  };
}

export async function familyRoutes(app: FastifyInstance): Promise<void> {
  // Family info ------------------------------------------------------------
  app.get('/family', async (req) => {
    const p = req.requireAnyMember();
    const [fam] = await db.select().from(families).where(eq(families.id, p.familyId)).limit(1);
    const us = await db
      .select({
        id: users.id,
        name: users.name,
        role: users.role,
        avatar: users.avatar,
        color: users.color,
        gender: users.gender,
      })
      .from(users)
      .where(eq(users.familyId, p.familyId));
    const ks = await db
      .select({
        id: kids.id,
        name: kids.name,
        color: kids.color,
        avatar: kids.avatar,
        gender: kids.gender,
      })
      .from(kids)
      .where(eq(kids.familyId, p.familyId));
    return { family: fam, parents: us, kids: ks };
  });

  app.patch('/family', async (req, reply) => {
    const p = req.requireParent();
    const body = z
      .object({
        name: z.string().min(1).max(64).optional(),
        payoutDay: z.number().int().min(0).max(6).optional(),
        payoutTime: z.string().regex(/^\d{2}:\d{2}$/).optional(),
        timezone: z.string().optional(),
        // PR 11 toggle for the TV-mode champion-of-the-week chime.
        tvCelebrationSound: z.boolean().optional(),
        // Sentinel from AdminFamily → Paired devices "Hide reminder" link
        // (PR 9). Server stamps the column with `now()`; passing `false`
        // clears the dismissal so the banner can come back.
        pairingReminderDismissed: z.boolean().optional(),
      })
      .parse(req.body);
    if (Object.keys(body).length === 0) {
      return reply.code(400).send({ error: 'no_fields' });
    }
    const payoutChanged =
      body.payoutDay !== undefined ||
      body.payoutTime !== undefined ||
      body.timezone !== undefined;

    // Translate the dismiss sentinel into a column write; everything else
    // passes through verbatim. Drop the sentinel field from the patch body
    // so drizzle doesn't complain about an unknown column.
    const { pairingReminderDismissed, ...rest } = body;
    const patch: Record<string, unknown> = { ...rest };
    if (pairingReminderDismissed !== undefined) {
      patch.pairingReminderDismissedAt = pairingReminderDismissed ? new Date() : null;
    }

    const [updated] = await db
      .update(families)
      .set(patch)
      .where(eq(families.id, p.familyId))
      .returning();
    if (payoutChanged) {
      await scheduler.rescheduleWeekClose(p.familyId);
    }
    bus.publish(p.familyId, { type: 'family.updated' });
    return { family: updated };
  });

  // Kids -------------------------------------------------------------------
  app.post('/family/kids', async (req, reply) => {
    const p = req.requireParent();
    const body = z
      .object({
        name: z.string().min(1).max(64),
        pin: z.string().regex(/^\d{4}$/),
        color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).default('#3B82F6'),
        avatar: z.string().optional(),
        gender: z.enum(['male', 'female', 'unspecified']).default('unspecified'),
      })
      .parse(req.body);
    // Free-tier kid cap. The SPA pre-checks via useEntitlements so a parent
    // at the cap never fills a 30-second form they can't submit; this is
    // the server-side fallback for stale caches and direct API callers.
    const ent = await getEntitlements(p.familyId);
    if (ent.remaining.kids <= 0) {
      return reply.code(402).send({
        error: 'plan_upgrade_required',
        blockedBy: 'kids_max',
        currentPlan: ent.plan,
        limits: ent.limits,
      });
    }
    const [k] = await db
      .insert(kids)
      .values({
        familyId: p.familyId,
        name: body.name,
        pinHash: await hashPin(body.pin),
        color: body.color,
        avatar: body.avatar,
        gender: body.gender,
      })
      .returning();
    bus.publish(p.familyId, { type: 'family.updated' });
    reply.code(201);
    return {
      kid: {
        id: k!.id,
        name: k!.name,
        color: k!.color,
        avatar: k!.avatar,
        gender: k!.gender,
      },
    };
  });

  app.patch('/family/kids/:id', async (req, reply) => {
    const p = req.requireParent();
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z
      .object({
        name: z.string().min(1).max(64).optional(),
        pin: z.string().regex(/^\d{4}$/).optional(),
        color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
        avatar: z.string().optional(),
        gender: z.enum(['male', 'female', 'unspecified']).optional(),
      })
      .parse(req.body);
    const patch: Record<string, unknown> = {};
    if (body.name !== undefined) patch.name = body.name;
    if (body.color !== undefined) patch.color = body.color;
    if (body.avatar !== undefined) patch.avatar = body.avatar;
    if (body.gender !== undefined) patch.gender = body.gender;
    if (body.pin !== undefined) patch.pinHash = await hashPin(body.pin);
    if (Object.keys(patch).length === 0) {
      return reply.code(400).send({ error: 'no_fields' });
    }
    const [k] = await db
      .update(kids)
      .set(patch)
      .where(and(eq(kids.id, params.id), eq(kids.familyId, p.familyId)))
      .returning();
    if (!k) return reply.code(404).send({ error: 'not_found' });
    bus.publish(p.familyId, { type: 'family.updated' });
    return {
      kid: {
        id: k.id,
        name: k.name,
        color: k.color,
        avatar: k.avatar,
        gender: k.gender,
      },
    };
  });

  app.delete('/family/kids/:id', async (req) => {
    const p = req.requireParent();
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    await db.delete(kids).where(and(eq(kids.id, params.id), eq(kids.familyId, p.familyId)));
    bus.publish(p.familyId, { type: 'family.updated' });
    return { ok: true };
  });

  // Co-parent invites --------------------------------------------------------
  //
  // The owner generates a single-use, time-boxed invite. The token is the
  // secret embedded in the join URL — anyone who knows it can claim a parent
  // seat in this family, so we never log it and we never echo it back outside
  // of authenticated parent calls. The owner shares the URL out-of-band (SMS,
  // chat, etc.) — there's no email channel from the API yet.
  //
  // Only one *active* invite per family. If the owner generates a second one
  // we revoke the previous active row so the partner can't accidentally
  // claim with a stale link.

  app.get('/family/invites', async (req) => {
    const p = req.requireParent();
    const now = new Date();
    const rows = await db
      .select()
      .from(familyInvites)
      .where(
        and(
          eq(familyInvites.familyId, p.familyId),
          isNull(familyInvites.consumedAt),
          isNull(familyInvites.revokedAt),
          gt(familyInvites.expiresAt, now),
        ),
      )
      .orderBy(desc(familyInvites.createdAt))
      .limit(1);
    return { invite: rows[0] ? publicInvite(rows[0]) : null };
  });

  app.post('/family/invites', async (req, reply) => {
    const p = req.requireParent();
    if (p.role !== 'owner') {
      return reply.code(403).send({ error: 'owner_only' });
    }

    // Revoke any active invite for this family before issuing a new one so
    // the owner can't accidentally have two valid join URLs floating around.
    const now = new Date();
    await db
      .update(familyInvites)
      .set({ revokedAt: now })
      .where(
        and(
          eq(familyInvites.familyId, p.familyId),
          isNull(familyInvites.consumedAt),
          isNull(familyInvites.revokedAt),
        ),
      );

    const token = nanoid(32);
    const expiresAt = new Date(now.getTime() + config.inviteTtlDays * 24 * 60 * 60 * 1000);
    const [row] = await db
      .insert(familyInvites)
      .values({
        familyId: p.familyId,
        token,
        createdByUserId: p.userId,
        expiresAt,
      })
      .returning();

    reply.code(201);
    return { invite: publicInvite(row!) };
  });

  app.delete('/family/invites/:id', async (req, reply) => {
    const p = req.requireParent();
    if (p.role !== 'owner') {
      return reply.code(403).send({ error: 'owner_only' });
    }
    const params = z.object({ id: z.string().uuid() }).parse(req.params);

    const [row] = await db
      .update(familyInvites)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(familyInvites.id, params.id),
          eq(familyInvites.familyId, p.familyId),
          isNull(familyInvites.consumedAt),
        ),
      )
      .returning();
    if (!row) return reply.code(404).send({ error: 'not_found' });
    return { ok: true };
  });

  // Parents ----------------------------------------------------------------
  //
  // Any parent can edit their own profile (name, color). Editing another
  // parent's profile is also allowed for any parent — the family-admin model
  // is "all parents trust each other"; same as how any parent can edit any
  // kid. Role changes / removal stay owner-only via the dedicated endpoints
  // below.
  app.patch('/family/parents/:userId', async (req, reply) => {
    const p = req.requireParent();
    const params = z.object({ userId: z.string().uuid() }).parse(req.params);
    const body = z
      .object({
        name: z.string().min(1).max(64).optional(),
        color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
        avatar: z.string().optional(),
        gender: z.enum(['male', 'female', 'unspecified']).optional(),
      })
      .parse(req.body);
    if (Object.keys(body).length === 0) {
      return reply.code(400).send({ error: 'no_fields' });
    }

    const [target] = await db
      .select({ id: users.id, familyId: users.familyId })
      .from(users)
      .where(eq(users.id, params.userId))
      .limit(1);
    if (!target || target.familyId !== p.familyId) {
      return reply.code(404).send({ error: 'not_found' });
    }

    const [updated] = await db
      .update(users)
      .set(body)
      .where(eq(users.id, target.id))
      .returning({
        id: users.id,
        name: users.name,
        role: users.role,
        avatar: users.avatar,
        color: users.color,
        gender: users.gender,
      });
    bus.publish(p.familyId, { type: 'family.updated' });
    return { parent: updated };
  });

  // Owner can promote a co-parent to co-owner. Multiple owners per family is
  // supported — every owner-gated route just checks `role === 'owner'`, so
  // granting the role gives the target full admin rights (billing, invites,
  // parent removal, delete-family). There's no "demote" inverse in v1 — if
  // you need to step a co-owner back down, you have to remove and re-invite.
  app.post('/family/parents/:userId/promote', async (req, reply) => {
    const p = req.requireParent();
    if (p.role !== 'owner') {
      return reply.code(403).send({ error: 'owner_only' });
    }
    const params = z.object({ userId: z.string().uuid() }).parse(req.params);
    if (params.userId === p.userId) {
      return reply.code(409).send({ error: 'already_owner' });
    }

    const [target] = await db
      .select({ id: users.id, familyId: users.familyId, role: users.role })
      .from(users)
      .where(eq(users.id, params.userId))
      .limit(1);
    if (!target || target.familyId !== p.familyId) {
      return reply.code(404).send({ error: 'not_found' });
    }
    if (target.role === 'owner') {
      return reply.code(409).send({ error: 'already_owner' });
    }

    await db.update(users).set({ role: 'owner' }).where(eq(users.id, target.id));
    bus.publish(p.familyId, { type: 'family.updated' });
    return { ok: true };
  });

  // Owner can remove a co-parent. This deletes the user row (cascading
  // their sessions, push subs, device tokens) but leaves their historical
  // chore approvals / ledger writes intact — those columns aren't FKs.
  //
  // We refuse to delete the owner (use DELETE /auth/family for that), the
  // caller themselves (use DELETE /auth/me), or a user from a different
  // family.
  app.delete('/family/parents/:userId', async (req, reply) => {
    const p = req.requireParent();
    if (p.role !== 'owner') {
      return reply.code(403).send({ error: 'owner_only' });
    }
    const params = z.object({ userId: z.string().uuid() }).parse(req.params);
    if (params.userId === p.userId) {
      return reply.code(409).send({ error: 'cannot_remove_self' });
    }

    const [target] = await db
      .select({ id: users.id, familyId: users.familyId, role: users.role })
      .from(users)
      .where(eq(users.id, params.userId))
      .limit(1);
    if (!target || target.familyId !== p.familyId) {
      return reply.code(404).send({ error: 'not_found' });
    }
    if (target.role === 'owner') {
      return reply.code(409).send({ error: 'cannot_remove_owner' });
    }

    // Drop sessions explicitly: the column has no FK so cascade won't catch them.
    await db.delete(sessions).where(eq(sessions.userId, target.id));
    await db.delete(users).where(eq(users.id, target.id));
    bus.publish(p.familyId, { type: 'family.updated' });
    return { ok: true };
  });
}
