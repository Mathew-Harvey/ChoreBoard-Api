import { randomBytes } from 'node:crypto';
import { and, eq, lt } from 'drizzle-orm';
import { db } from '../db/client.js';
import { sessions } from '../db/schema.js';
import { config } from '../config.js';

export type SessionRow = typeof sessions.$inferSelect;

export function newSessionId(): string {
  return randomBytes(32).toString('base64url');
}

export async function createSession(input: {
  familyId: string;
  userId?: string | null;
  kidId?: string | null;
  transport?: 'cookie' | 'bearer';
}): Promise<SessionRow> {
  const id = newSessionId();
  const expiresAt = new Date(Date.now() + config.sessionTtlDays * 24 * 60 * 60 * 1000);
  const [row] = await db
    .insert(sessions)
    .values({
      id,
      familyId: input.familyId,
      userId: input.userId ?? null,
      kidId: input.kidId ?? null,
      transport: input.transport ?? 'cookie',
      expiresAt,
    })
    .returning();
  return row!;
}

export async function getSession(id: string): Promise<SessionRow | null> {
  const rows = await db.select().from(sessions).where(eq(sessions.id, id)).limit(1);
  const row = rows[0];
  if (!row) return null;
  if (row.expiresAt.getTime() < Date.now()) {
    await db.delete(sessions).where(eq(sessions.id, id));
    return null;
  }
  return row;
}

export async function deleteSession(id: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.id, id));
}

export async function purgeExpired(): Promise<void> {
  await db.delete(sessions).where(lt(sessions.expiresAt, new Date()));
}
