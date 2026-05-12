import type { FastifyInstance } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/client.js';
import { deviceTokens } from '../db/schema.js';

/**
 * Native push token CRUD for the Capacitor iOS / Android app.
 *
 * Web push subscriptions go through a different endpoint (TBD: /api/push)
 * because the payload shape is different (endpoint + p256dh + auth, not just
 * an opaque APNs/FCM token).
 *
 * Only parents register tokens — kids don't receive push.
 */
export async function devicesRoutes(app: FastifyInstance): Promise<void> {
  // Register or refresh a token for the calling parent's current device.
  // Idempotent on (user_id, token): re-posting just updates last_seen_at.
  app.post('/devices', async (req, reply) => {
    const p = req.requireParent();
    const body = z
      .object({
        platform: z.enum(['ios', 'android']),
        token: z.string().min(1).max(4096),
        appVersion: z.string().max(32).optional(),
      })
      .parse(req.body);

    // Upsert keyed on (user_id, token). Drizzle's onConflictDoUpdate avoids
    // a separate select-then-insert race.
    const [row] = await db
      .insert(deviceTokens)
      .values({
        userId: p.userId,
        platform: body.platform,
        token: body.token,
        appVersion: body.appVersion ?? null,
        lastSeenAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [deviceTokens.userId, deviceTokens.token],
        set: {
          platform: body.platform,
          appVersion: body.appVersion ?? null,
          lastSeenAt: new Date(),
        },
      })
      .returning();

    reply.code(201);
    return {
      device: {
        id: row!.id,
        platform: row!.platform,
        appVersion: row!.appVersion,
        createdAt: row!.createdAt,
        lastSeenAt: row!.lastSeenAt,
      },
    };
  });

  // List the calling parent's registered devices (for a settings screen).
  app.get('/devices', async (req) => {
    const p = req.requireParent();
    const rows = await db
      .select({
        id: deviceTokens.id,
        platform: deviceTokens.platform,
        appVersion: deviceTokens.appVersion,
        createdAt: deviceTokens.createdAt,
        lastSeenAt: deviceTokens.lastSeenAt,
      })
      .from(deviceTokens)
      .where(eq(deviceTokens.userId, p.userId));
    return { devices: rows };
  });

  // Unregister a device (e.g. on logout from the native app, or from the
  // settings screen on another device). The id is opaque — we never expose
  // the raw APNs/FCM token back to the client.
  app.delete('/devices/:id', async (req, reply) => {
    const p = req.requireParent();
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const result = await db
      .delete(deviceTokens)
      .where(and(eq(deviceTokens.id, params.id), eq(deviceTokens.userId, p.userId)))
      .returning({ id: deviceTokens.id });
    if (result.length === 0) return reply.code(404).send({ error: 'not_found' });
    return { ok: true };
  });

  // Convenience: native logout flow can call this to drop the *current*
  // device's token by sending the token in the body. Avoids the client
  // needing to remember its own row id.
  app.post('/devices/unregister', async (req) => {
    const p = req.requireParent();
    const body = z.object({ token: z.string().min(1).max(4096) }).parse(req.body);
    await db
      .delete(deviceTokens)
      .where(and(eq(deviceTokens.userId, p.userId), eq(deviceTokens.token, body.token)));
    return { ok: true };
  });
}
