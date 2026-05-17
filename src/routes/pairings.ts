import type { FastifyInstance } from 'fastify';
import { randomInt } from 'node:crypto';
import { and, desc, eq, gt, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/client.js';
import { devicePairings, families, sessions } from '../db/schema.js';
import { hashPairingCode, verifyPairingCode } from '../auth/password.js';
import { createSession } from '../auth/sessions.js';
import { config } from '../config.js';
import { bus } from '../realtime/bus.js';

/**
 * Device-pairing routes (PR 4).
 *
 * The kitchen-tablet flow:
 *   1. A parent calls POST /api/family/pairings → server mints a 6-digit code,
 *      hashes it with argon2id, stores the hash, and returns the plaintext
 *      ONCE in the response body.
 *   2. The parent reads the code aloud / shows it on their phone.
 *   3. On the tablet (KidPinScreen with no cb_family_id), POST /api/auth/pair
 *      with `{ code }`. Server scans active pairings, verifies the hash,
 *      mints a long-lived "device session" (transport='pairing', no userId
 *      and no kidId), records the consume, and returns the family + the new
 *      session token. The SPA caches both `cb_family_id` and the device
 *      session token in localStorage.
 *   4. The kid then PINs in via the existing POST /api/auth/kid-login, which
 *      mints a SEPARATE kid session that the SPA uses for normal API calls.
 *      The device session sits underneath; on kid sign-out the SPA goes back
 *      to the avatar grid without re-pairing.
 *   5. Revoking a pairing (DELETE /api/family/pairings/:id) deletes the
 *      device session, which forces the device back to the unpaired
 *      KidPinScreen the next time it tries to do anything.
 */
export async function pairingsRoutes(app: FastifyInstance): Promise<void> {
  // ----- List pairings (any parent) ----------------------------------------
  app.get('/family/pairings', async (req) => {
    const p = req.requireParent();
    const rows = await db
      .select()
      .from(devicePairings)
      .where(eq(devicePairings.familyId, p.familyId))
      .orderBy(desc(devicePairings.issuedAt));
    const now = Date.now();
    return {
      pairings: rows.map((r) => ({
        id: r.id,
        deviceLabel: r.consumedDeviceLabel,
        issuedByUserId: r.issuedByUserId,
        issuedAt: r.issuedAt.toISOString(),
        expiresAt: r.expiresAt.toISOString(),
        consumedAt: r.consumedAt?.toISOString() ?? null,
        revokedAt: r.revokedAt?.toISOString() ?? null,
        lastSeenAt: r.lastSeenAt?.toISOString() ?? null,
        status: pairingStatus(r, now),
      })),
    };
  });

  // ----- Issue a fresh code (any parent) -----------------------------------
  app.post('/family/pairings', async (req, reply) => {
    const p = req.requireParent();
    const code = gen6Digit();
    const codeHash = await hashPairingCode(code);
    const expiresAt = new Date(Date.now() + config.pairingCodeTtlMin * 60 * 1000);
    const [row] = await db
      .insert(devicePairings)
      .values({
        familyId: p.familyId,
        codeHash,
        issuedByUserId: p.userId,
        expiresAt,
      })
      .returning();
    reply.code(201);
    return {
      pairing: {
        id: row!.id,
        issuedAt: row!.issuedAt.toISOString(),
        expiresAt: row!.expiresAt.toISOString(),
      },
      // Plaintext is returned exactly once. The SPA must not log it.
      code,
    };
  });

  // ----- Update a pairing's label (any parent) -----------------------------
  app.patch('/family/pairings/:id', async (req, reply) => {
    const p = req.requireParent();
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z
      .object({ deviceLabel: z.string().min(1).max(64) })
      .parse(req.body);
    const [row] = await db
      .update(devicePairings)
      .set({ consumedDeviceLabel: body.deviceLabel })
      .where(
        and(
          eq(devicePairings.id, params.id),
          eq(devicePairings.familyId, p.familyId),
        ),
      )
      .returning();
    if (!row) return reply.code(404).send({ error: 'not_found' });
    return { ok: true };
  });

  // ----- Revoke a pairing (any parent) -------------------------------------
  app.delete('/family/pairings/:id', async (req, reply) => {
    const p = req.requireParent();
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const [row] = await db
      .update(devicePairings)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(devicePairings.id, params.id),
          eq(devicePairings.familyId, p.familyId),
          isNull(devicePairings.revokedAt),
        ),
      )
      .returning();
    if (!row) return reply.code(404).send({ error: 'not_found' });
    // Kill the device session if we minted one. The kitchen tablet falls
    // back to the unpaired KidPinScreen on its next API call.
    if (row.consumedSessionId) {
      await db.delete(sessions).where(eq(sessions.id, row.consumedSessionId));
    }
    bus.publish(p.familyId, { type: 'family.updated' });
    return { ok: true };
  });

  // ----- Consume a code (UNAUTHENTICATED — bearer of the code is the principal)
  //
  // Returns 410 'pairing_code_invalid' for every failure mode (unknown,
  // expired, already-consumed, revoked, race-loss). Deliberately uniform so
  // we don't leak which codes are real vs which are stale on the client.
  app.post('/auth/pair', async (req, reply) => {
    const body = z
      .object({
        code: z.string().regex(/^\d{6}$/),
        deviceLabel: z.string().max(64).optional(),
      })
      .parse(req.body);
    const now = new Date();

    const candidates = await db
      .select()
      .from(devicePairings)
      .where(
        and(
          isNull(devicePairings.consumedAt),
          isNull(devicePairings.revokedAt),
          gt(devicePairings.expiresAt, now),
        ),
      );

    let matched: (typeof candidates)[number] | null = null;
    for (const row of candidates) {
      if (await verifyPairingCode(row.codeHash, body.code)) {
        matched = row;
        break;
      }
    }
    if (!matched) {
      return reply.code(410).send({ error: 'pairing_code_invalid' });
    }

    const userAgent = (req.headers['user-agent'] as string | undefined) ?? '';
    const label = body.deviceLabel ?? inferDeviceLabel(userAgent);

    const session = await createSession({
      familyId: matched.familyId,
      transport: 'pairing',
    });

    // Atomically claim the pairing — if another concurrent request just
    // consumed it, undo the session we created and report the same uniform
    // 410 the rest of the failure modes use.
    const [claimed] = await db
      .update(devicePairings)
      .set({
        consumedAt: now,
        consumedDeviceLabel: label,
        consumedSessionId: session.id,
        lastSeenAt: now,
      })
      .where(
        and(
          eq(devicePairings.id, matched.id),
          isNull(devicePairings.consumedAt),
          isNull(devicePairings.revokedAt),
        ),
      )
      .returning();
    if (!claimed) {
      await db.delete(sessions).where(eq(sessions.id, session.id));
      return reply.code(410).send({ error: 'pairing_code_invalid' });
    }

    const [fam] = await db
      .select({ id: families.id, name: families.name })
      .from(families)
      .where(eq(families.id, matched.familyId))
      .limit(1);
    bus.publish(matched.familyId, { type: 'family.updated' });

    // We deliberately return `device` rather than `session` at the top
    // level so the SPA's api.ts auto-save (which homes in on
    // `session.token` to persist a fresh login) does NOT swap the active
    // session out from under a kid or parent who's already signed in. The
    // device session is bookkeeping for revoke and last-seen; the SPA
    // stores its token in a separate localStorage slot.
    return {
      family: fam ?? { id: matched.familyId, name: 'Family' },
      device: {
        id: claimed.id,
        label,
        token: session.id,
        expiresAt: session.expiresAt.toISOString(),
      },
    };
  });
}

function pairingStatus(
  row: typeof devicePairings.$inferSelect,
  nowMs: number,
): 'pending' | 'active' | 'revoked' | 'expired' {
  if (row.revokedAt) return 'revoked';
  if (row.consumedAt) return 'active';
  if (row.expiresAt.getTime() < nowMs) return 'expired';
  return 'pending';
}

function gen6Digit(): string {
  // Six digits, leading zeros allowed. Uses crypto.randomInt for unbiased
  // sampling over the full keyspace (0…999999).
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

function inferDeviceLabel(userAgent: string): string {
  if (!userAgent) return 'Tablet';
  if (/iPad/i.test(userAgent)) return 'Apple iPad';
  if (/iPhone/i.test(userAgent)) return 'iPhone';
  if (/Android.*(Tablet|SM-T|Pixel.*Tablet)/i.test(userAgent)) return 'Android tablet';
  if (/Android/i.test(userAgent)) return 'Android phone';
  if (/Macintosh|Mac OS X/i.test(userAgent)) return 'Mac';
  if (/Windows/i.test(userAgent)) return 'Windows device';
  if (/Linux/i.test(userAgent)) return 'Linux device';
  return 'Tablet';
}
