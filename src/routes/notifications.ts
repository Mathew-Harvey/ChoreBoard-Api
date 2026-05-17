import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/client.js';
import { notificationPrefs, users } from '../db/schema.js';

/**
 * Per-parent notification preferences (PR 6).
 *
 *   GET   /api/notifications/prefs       → caller's row (auto-creates with defaults)
 *   GET   /api/notifications/prefs/all   → matrix of every parent's prefs (sans quiet hours)
 *   PATCH /api/notifications/prefs       → upsert caller's row
 *
 * The push fan-out in `integrations/push.ts` consults these via the
 * `shouldPush(userId, kind)` gate; quiet hours are evaluated in the parent's
 * own `quiet_tz`, so a travelling parent isn't pinged at 2am their local
 * time just because the family clock is in Sydney.
 */
export async function notificationsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/notifications/prefs', async (req) => {
    const p = req.requireParent();
    const row = await ensurePrefsRow(p.userId, p.familyId);
    return { prefs: serialize(row) };
  });

  app.get('/notifications/prefs/all', async (req) => {
    const p = req.requireParent();
    // Co-parent transparency view: each parent's per-event toggles, but we
    // strip quiet hours so the panel doesn't read as surveillance.
    const rows = await db
      .select({
        userId: notificationPrefs.userId,
        userName: users.name,
        pushApprovalsRequested: notificationPrefs.pushApprovalsRequested,
        emailApprovalsRequested: notificationPrefs.emailApprovalsRequested,
        pushGoalHit: notificationPrefs.pushGoalHit,
        emailGoalHit: notificationPrefs.emailGoalHit,
        pushChampion: notificationPrefs.pushChampion,
        emailChampion: notificationPrefs.emailChampion,
        pushWeeklySummary: notificationPrefs.pushWeeklySummary,
        emailWeeklySummary: notificationPrefs.emailWeeklySummary,
      })
      .from(notificationPrefs)
      .innerJoin(users, eq(users.id, notificationPrefs.userId))
      .where(eq(users.familyId, p.familyId));
    return { prefs: rows };
  });

  app.patch('/notifications/prefs', async (req, reply) => {
    const p = req.requireParent();
    const body = z
      .object({
        pushApprovalsRequested: z.boolean().optional(),
        emailApprovalsRequested: z.boolean().optional(),
        pushGoalHit: z.boolean().optional(),
        emailGoalHit: z.boolean().optional(),
        pushChampion: z.boolean().optional(),
        emailChampion: z.boolean().optional(),
        pushWeeklySummary: z.boolean().optional(),
        emailWeeklySummary: z.boolean().optional(),
        // Quiet hours are HH:MM strings in `quietTz`. Pass null to clear
        // either side; passing one without the other clears both (we only
        // honour quiet hours when both ends are set).
        quietStart: z.string().regex(/^\d{2}:\d{2}$/).nullable().optional(),
        quietEnd: z.string().regex(/^\d{2}:\d{2}$/).nullable().optional(),
        quietTz: z.string().min(1).max(64).optional(),
      })
      .parse(req.body);
    if (Object.keys(body).length === 0) {
      return reply.code(400).send({ error: 'no_fields' });
    }
    await ensurePrefsRow(p.userId, p.familyId);
    const [row] = await db
      .update(notificationPrefs)
      .set({ ...body, updatedAt: new Date() })
      .where(eq(notificationPrefs.userId, p.userId))
      .returning();
    return { prefs: serialize(row!) };
  });
}

/**
 * Materialise a `notification_prefs` row on first read for a parent that
 * pre-dates the migration (or whose row was somehow lost). The signup +
 * invite-accept paths already insert one explicitly, so this is the safety
 * net rather than the primary writer. `quiet_tz` defaults to the family's
 * timezone so quiet hours match the user's expected local time on day one.
 */
export async function ensurePrefsRow(
  userId: string,
  familyId: string,
): Promise<typeof notificationPrefs.$inferSelect> {
  const [existing] = await db
    .select()
    .from(notificationPrefs)
    .where(eq(notificationPrefs.userId, userId))
    .limit(1);
  if (existing) return existing;

  const { db: _db } = await import('../db/client.js');
  void _db;
  const { families } = await import('../db/schema.js');
  const [fam] = await db
    .select({ tz: families.timezone })
    .from(families)
    .where(eq(families.id, familyId))
    .limit(1);
  const [row] = await db
    .insert(notificationPrefs)
    .values({
      userId,
      quietTz: fam?.tz ?? 'Australia/Sydney',
    })
    .returning();
  return row!;
}

function serialize(row: typeof notificationPrefs.$inferSelect) {
  return {
    pushApprovalsRequested: row.pushApprovalsRequested,
    emailApprovalsRequested: row.emailApprovalsRequested,
    pushGoalHit: row.pushGoalHit,
    emailGoalHit: row.emailGoalHit,
    pushChampion: row.pushChampion,
    emailChampion: row.emailChampion,
    pushWeeklySummary: row.pushWeeklySummary,
    emailWeeklySummary: row.emailWeeklySummary,
    quietStart: row.quietStart,
    quietEnd: row.quietEnd,
    quietTz: row.quietTz,
    updatedAt: row.updatedAt.toISOString(),
  };
}
