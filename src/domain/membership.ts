import { and, eq } from 'drizzle-orm';
import { db, type DB } from '../db/client.js';
import { kids, users } from '../db/schema.js';

type Txn = DB | Parameters<Parameters<DB['transaction']>[0]>[0];

/**
 * True iff (memberType, memberId) maps to a user or kid in this family.
 * Use this anywhere a route accepts a `memberType` + `memberId` from the
 * client to ensure parents can't write rows pointing at strangers.
 */
export async function memberBelongsToFamily(
  member: { type: 'user' | 'kid'; id: string },
  familyId: string,
  exec: Txn = db,
): Promise<boolean> {
  if (member.type === 'kid') {
    const [k] = await exec
      .select({ id: kids.id })
      .from(kids)
      .where(and(eq(kids.id, member.id), eq(kids.familyId, familyId)))
      .limit(1);
    return !!k;
  }
  const [u] = await exec
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.id, member.id), eq(users.familyId, familyId)))
    .limit(1);
  return !!u;
}
