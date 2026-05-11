import type { FastifyInstance } from 'fastify';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/client.js';
import { choreInstances, chores, ledgerEntries, weeks } from '../db/schema.js';
import { bus } from '../realtime/bus.js';

export async function ledgerRoutes(app: FastifyInstance): Promise<void> {
  // List ledger entries with filters.
  app.get('/ledger', async (req) => {
    const p = req.requireParent();
    const q = z
      .object({
        status: z.enum(['unpaid', 'paid']).optional(),
        memberType: z.enum(['user', 'kid']).optional(),
        memberId: z.string().uuid().optional(),
        weekId: z.string().uuid().optional(),
        limit: z.coerce.number().int().min(1).max(500).default(100),
      })
      .parse(req.query);

    const conds = [eq(ledgerEntries.familyId, p.familyId)];
    if (q.status) conds.push(eq(ledgerEntries.status, q.status));
    if (q.memberType) conds.push(eq(ledgerEntries.memberType, q.memberType));
    if (q.memberId) conds.push(eq(ledgerEntries.memberId, q.memberId));
    if (q.weekId) conds.push(eq(ledgerEntries.weekId, q.weekId));

    const rows = await db
      .select({
        id: ledgerEntries.id,
        amountCents: ledgerEntries.amountCents,
        memberType: ledgerEntries.memberType,
        memberId: ledgerEntries.memberId,
        status: ledgerEntries.status,
        earnedAt: ledgerEntries.earnedAt,
        paidAt: ledgerEntries.paidAt,
        weekId: ledgerEntries.weekId,
        choreName: chores.name,
      })
      .from(ledgerEntries)
      .innerJoin(choreInstances, eq(choreInstances.id, ledgerEntries.instanceId))
      .innerJoin(chores, eq(chores.id, choreInstances.choreId))
      .where(and(...conds))
      .orderBy(desc(ledgerEntries.earnedAt))
      .limit(q.limit);
    return { entries: rows };
  });

  // Per-week summary table with per-member totals — used by the payout
  // history view in /admin/ledger.
  app.get('/ledger/weeks', async (req) => {
    const p = req.requireParent();
    const ws = await db
      .select()
      .from(weeks)
      .where(eq(weeks.familyId, p.familyId))
      .orderBy(desc(weeks.startsAt))
      .limit(20);
    if (ws.length === 0) return { weeks: [] };

    const ids = ws.map((w) => w.id);
    const totals = await db.execute<{
      week_id: string;
      member_type: 'user' | 'kid';
      member_id: string;
      total: string;
      count: string;
      unpaid: string;
    }>(sql`
      select week_id,
             member_type,
             member_id,
             sum(amount_cents)::text as total,
             count(*)::text as count,
             sum(case when status = 'unpaid' then amount_cents else 0 end)::text as unpaid
      from ledger_entries
      where family_id = ${p.familyId}
        and week_id = any(${ids})
      group by week_id, member_type, member_id
      order by week_id, total desc
    `);

    const byWeek = new Map<string, Array<{
      memberType: 'user' | 'kid';
      memberId: string;
      totalCents: number;
      unpaidCents: number;
      count: number;
    }>>();
    for (const r of totals.rows) {
      const arr = byWeek.get(r.week_id) ?? [];
      arr.push({
        memberType: r.member_type,
        memberId: r.member_id,
        totalCents: Number(r.total),
        unpaidCents: Number(r.unpaid),
        count: Number(r.count),
      });
      byWeek.set(r.week_id, arr);
    }

    return {
      weeks: ws.map((w) => ({
        ...w,
        totals: byWeek.get(w.id) ?? [],
      })),
    };
  });

  // Mark entries paid: per-entry IDs, or "all unpaid for member", or
  // "all unpaid in a week".
  app.post('/ledger/pay', async (req, reply) => {
    const p = req.requireParent();
    const body = z
      .object({
        entryIds: z.array(z.string().uuid()).optional(),
        memberType: z.enum(['user', 'kid']).optional(),
        memberId: z.string().uuid().optional(),
        weekId: z.string().uuid().optional(),
      })
      .parse(req.body);

    if (
      (!body.entryIds || body.entryIds.length === 0) &&
      !(body.memberType && body.memberId) &&
      !body.weekId
    ) {
      return reply.code(400).send({ error: 'no_target' });
    }

    const now = new Date();
    const conds = [
      eq(ledgerEntries.familyId, p.familyId),
      eq(ledgerEntries.status, 'unpaid'),
    ];
    if (body.entryIds && body.entryIds.length > 0) {
      conds.push(inArray(ledgerEntries.id, body.entryIds));
    }
    if (body.memberType && body.memberId) {
      conds.push(eq(ledgerEntries.memberType, body.memberType));
      conds.push(eq(ledgerEntries.memberId, body.memberId));
    }
    if (body.weekId) {
      conds.push(eq(ledgerEntries.weekId, body.weekId));
    }

    const updated = await db
      .update(ledgerEntries)
      .set({ status: 'paid', paidAt: now, paidByUserId: p.userId })
      .where(and(...conds))
      .returning({ id: ledgerEntries.id });

    if (updated.length > 0) {
      bus.publish(p.familyId, {
        type: 'ledger.paid',
        memberType: body.memberType,
        memberId: body.memberId,
        count: updated.length,
      });
    }
    return { paidCount: updated.length };
  });

  // CSV export (basic).
  app.get('/ledger.csv', async (req, reply) => {
    const p = req.requireParent();
    const rows = await db
      .select({
        id: ledgerEntries.id,
        amountCents: ledgerEntries.amountCents,
        memberType: ledgerEntries.memberType,
        memberId: ledgerEntries.memberId,
        status: ledgerEntries.status,
        earnedAt: ledgerEntries.earnedAt,
        paidAt: ledgerEntries.paidAt,
        choreName: chores.name,
      })
      .from(ledgerEntries)
      .innerJoin(choreInstances, eq(choreInstances.id, ledgerEntries.instanceId))
      .innerJoin(chores, eq(chores.id, choreInstances.choreId))
      .where(eq(ledgerEntries.familyId, p.familyId))
      .orderBy(desc(ledgerEntries.earnedAt));

    const csv = [
      'id,earned_at,paid_at,member_type,member_id,chore,amount_cents,status',
      ...rows.map((r) =>
        [
          r.id,
          r.earnedAt.toISOString(),
          r.paidAt?.toISOString() ?? '',
          r.memberType,
          r.memberId,
          JSON.stringify(r.choreName),
          r.amountCents,
          r.status,
        ].join(','),
      ),
    ].join('\n');
    reply.header('Content-Type', 'text/csv; charset=utf-8');
    reply.header('Content-Disposition', 'attachment; filename="choreboard-ledger.csv"');
    return csv;
  });
}
