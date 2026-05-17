/**
 * Push dispatchers — APNs (iOS), FCM (Android), Web Push (browser).
 *
 * Each transport is gated on the relevant env config. If keys aren't set we
 * log "would have sent" and return. The intent is that this file is correct
 * to call from anywhere in the codebase from day one — `await sendApprovalRequest(parentUserId, ...)`
 * just works, whether or not the underlying credentials exist yet.
 *
 * When you're ready to wire up the real transports:
 *   - APNs:    write a small HTTP/2 client using node:http2 + JWT signed with the .p8 key
 *   - FCM:     `npm i firebase-admin` and replace the stub with `messaging().sendEachForMulticast(...)`
 *   - WebPush: `npm i web-push` and replace the stub with `webpush.sendNotification(sub, JSON.stringify(payload))`
 */

import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { deviceTokens, notificationPrefs, pushSubscriptions } from '../db/schema.js';
import {
  config,
  isApnsConfigured,
  isFcmConfigured,
  isWebPushConfigured,
} from '../config.js';

/**
 * The four push events the app can fire today. Every callsite passes one of
 * these to `sendToUser` so the per-parent prefs gate (PR 6) can suppress
 * delivery the parent has opted out of, or the parent's quiet hours window
 * silences (evaluated in the parent's `quiet_tz`).
 */
export type PushKind = 'approval_request' | 'goal_hit' | 'champion' | 'weekly_summary';

export type PushPayload = {
  title: string;
  body: string;
  // Deep-link path relative to app.choreboard.io. The native app intercepts
  // these via Universal Links / App Links and routes inside the SPA without
  // bouncing through Safari / Chrome.
  url?: string;
  // Free-form data the client can use to update its state immediately.
  data?: Record<string, string | number | boolean | null>;
  // iOS / Android collapse key — multiple pushes with the same key replace
  // each other in the notification tray.
  collapseKey?: string;
};

type TransportResult = { sent: number; failed: number };

const noop: TransportResult = { sent: 0, failed: 0 };

/**
 * Send a push to all of a parent's devices (iOS, Android, browser). Returns
 * a per-transport tally. Failures are logged but don't throw — push is best
 * effort by definition.
 *
 * Honours the per-parent `notification_prefs` matrix and quiet hours (PR 6)
 * unless `kind` is omitted, in which case we deliver as before — older
 * callers without a `kind` are still supported during the migration window.
 */
export async function sendToUser(
  userId: string,
  payload: PushPayload,
  kind?: PushKind,
): Promise<{
  apns: TransportResult;
  fcm: TransportResult;
  web: TransportResult;
  suppressed?: 'pref' | 'quiet_hours';
}> {
  if (kind) {
    const reason = await suppressedReason(userId, kind, new Date());
    if (reason) {
      console.info(`[push] suppressed kind=${kind} user=${userId} reason=${reason}`);
      return { apns: noop, fcm: noop, web: noop, suppressed: reason };
    }
  }
  const tokens = await db
    .select()
    .from(deviceTokens)
    .where(eq(deviceTokens.userId, userId));
  const webSubs = await db
    .select()
    .from(pushSubscriptions)
    .where(eq(pushSubscriptions.userId, userId));

  const iosTokens = tokens.filter((t) => t.platform === 'ios').map((t) => t.token);
  const androidTokens = tokens.filter((t) => t.platform === 'android').map((t) => t.token);

  const [apns, fcm, web] = await Promise.all([
    sendApns(iosTokens, payload),
    sendFcm(androidTokens, payload),
    sendWebPush(
      webSubs.map((s) => ({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } })),
      payload,
    ),
  ]);
  return { apns, fcm, web };
}

// ---------------------------------------------------------------------------
// Per-parent prefs gate
// ---------------------------------------------------------------------------
//
// Returns null when the push should proceed, otherwise a tag describing
// which suppressor fired. Missing prefs rows fall through to the row's
// default values (everything ON, no quiet hours), which match the
// backfill-on-signup behaviour. Quiet hours are evaluated in the parent's
// own `quiet_tz`, with wrap-around (e.g. 22:00 → 06:00) honoured.

async function suppressedReason(
  userId: string,
  kind: PushKind,
  now: Date,
): Promise<'pref' | 'quiet_hours' | null> {
  const [p] = await db
    .select()
    .from(notificationPrefs)
    .where(eq(notificationPrefs.userId, userId))
    .limit(1);
  if (!p) return null;

  const enabled = pickPushFlag(p, kind);
  if (!enabled) return 'pref';

  if (p.quietStart && p.quietEnd) {
    const hhmm = new Intl.DateTimeFormat('en-GB', {
      timeZone: p.quietTz,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(now);
    const inQuiet =
      p.quietStart <= p.quietEnd
        ? hhmm >= p.quietStart && hhmm < p.quietEnd
        : hhmm >= p.quietStart || hhmm < p.quietEnd;
    if (inQuiet) return 'quiet_hours';
  }
  return null;
}

function pickPushFlag(
  p: typeof notificationPrefs.$inferSelect,
  kind: PushKind,
): boolean {
  switch (kind) {
    case 'approval_request':
      return p.pushApprovalsRequested;
    case 'goal_hit':
      return p.pushGoalHit;
    case 'champion':
      return p.pushChampion;
    case 'weekly_summary':
      return p.pushWeeklySummary;
  }
}

// ---------------------------------------------------------------------------
// APNs (iOS native)
// ---------------------------------------------------------------------------

async function sendApns(tokens: string[], payload: PushPayload): Promise<TransportResult> {
  if (tokens.length === 0) return noop;
  if (!isApnsConfigured()) {
    console.info(
      `[push:apns] skip — not configured. Would send to ${tokens.length} device(s):`,
      payload.title,
    );
    return noop;
  }

  // TODO(v1.x): real APNs HTTP/2 dispatcher.
  //
  // Modern Apple recommendation is HTTP/2 + JWT signed with your .p8 key, no
  // SDK needed. Sketch:
  //
  //   import http2 from 'node:http2';
  //   import jwt from 'jsonwebtoken';   // npm i jsonwebtoken
  //   const token = jwt.sign({ iss: config.apnsTeamId, iat: Math.floor(Date.now()/1000) }, config.apnsKeyP8, {
  //     algorithm: 'ES256', header: { alg: 'ES256', kid: config.apnsKeyId },
  //   });
  //   const host = config.apnsProduction ? 'api.push.apple.com' : 'api.sandbox.push.apple.com';
  //   const client = http2.connect(`https://${host}`);
  //   for (const t of tokens) {
  //     const req = client.request({ ':path': `/3/device/${t}`, ':method': 'POST',
  //       authorization: `bearer ${token}`, 'apns-topic': config.apnsBundleId });
  //     req.write(JSON.stringify({ aps: { alert: { title: payload.title, body: payload.body }, sound: 'default' }, ...payload.data }));
  //     req.end();
  //   }
  console.info(`[push:apns] (stub) ${tokens.length} → ${payload.title}`);
  return { sent: tokens.length, failed: 0 };
}

// ---------------------------------------------------------------------------
// FCM (Android native)
// ---------------------------------------------------------------------------

async function sendFcm(tokens: string[], payload: PushPayload): Promise<TransportResult> {
  if (tokens.length === 0) return noop;
  if (!isFcmConfigured()) {
    console.info(
      `[push:fcm] skip — not configured. Would send to ${tokens.length} device(s):`,
      payload.title,
    );
    return noop;
  }

  // TODO(v1.x): real FCM dispatcher via firebase-admin.
  //
  //   import admin from 'firebase-admin';   // npm i firebase-admin
  //   if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.cert(JSON.parse(config.fcmServiceAccountJson)) });
  //   const res = await admin.messaging().sendEachForMulticast({
  //     tokens,
  //     notification: { title: payload.title, body: payload.body },
  //     data: { url: payload.url ?? '/' , ...flattenData(payload.data) },
  //     android: { collapseKey: payload.collapseKey },
  //   });
  //   return { sent: res.successCount, failed: res.failureCount };
  console.info(`[push:fcm] (stub) ${tokens.length} → ${payload.title}`);
  return { sent: tokens.length, failed: 0 };
}

// ---------------------------------------------------------------------------
// Web Push (browser, when a parent enabled it on app.choreboard.io)
// ---------------------------------------------------------------------------

type WebSub = { endpoint: string; keys: { p256dh: string; auth: string } };

async function sendWebPush(subs: WebSub[], payload: PushPayload): Promise<TransportResult> {
  if (subs.length === 0) return noop;
  if (!isWebPushConfigured()) {
    console.info(
      `[push:web] skip — VAPID not configured. Would send to ${subs.length} subscriber(s):`,
      payload.title,
    );
    return noop;
  }

  // TODO(v1.x): real Web Push dispatcher.
  //
  //   import webpush from 'web-push';   // npm i web-push
  //   webpush.setVapidDetails(config.vapidSubject, config.vapidPublicKey, config.vapidPrivateKey);
  //   let sent = 0, failed = 0;
  //   for (const sub of subs) {
  //     try {
  //       await webpush.sendNotification(sub, JSON.stringify(payload), { TTL: 60 * 60 * 24 });
  //       sent++;
  //     } catch (e: any) {
  //       failed++;
  //       if (e?.statusCode === 404 || e?.statusCode === 410) {
  //         // Subscription is gone; clean it up.
  //         await db.delete(pushSubscriptions).where(eq(pushSubscriptions.endpoint, sub.endpoint));
  //       }
  //     }
  //   }
  //   return { sent, failed };
  console.info(`[push:web] (stub) ${subs.length} → ${payload.title}`);
  return { sent: subs.length, failed: 0 };
}

// ---------------------------------------------------------------------------
// Convenience: typed payload builders for the events we actually push on
// ---------------------------------------------------------------------------

export function approvalRequestPayload(args: {
  kidName: string;
  choreName: string;
  amountCents: number;
  instanceId: string;
}): PushPayload {
  const dollars = (args.amountCents / 100).toFixed(2);
  return {
    title: `${args.kidName} finished a chore`,
    body: `${args.choreName} — $${dollars}. Tap to approve.`,
    url: `${config.appUrl}/admin/approvals/${args.instanceId}`,
    data: { instanceId: args.instanceId, kind: 'approval_request' },
    collapseKey: `approval:${args.instanceId}`,
  };
}

export function goalHitPayload(args: { kidName: string; goalName: string }): PushPayload {
  return {
    title: `${args.kidName} hit a goal!`,
    body: `${args.goalName} — celebrate when you get home.`,
    url: `${config.appUrl}/`,
    data: { kind: 'goal_hit' },
  };
}

export function championPayload(args: {
  championName: string | null;
  amountCents: number | null;
}): PushPayload {
  if (!args.championName) {
    return {
      title: 'Sunday payout ready',
      body: 'Open ChoreBoard to see this week’s ledger.',
      url: `${config.appUrl}/admin/ledger`,
      data: { kind: 'week_closed' },
    };
  }
  const dollars = ((args.amountCents ?? 0) / 100).toFixed(2);
  return {
    title: `Champion of the week: ${args.championName}`,
    body: `$${dollars} this week. Sunday payout time.`,
    url: `${config.appUrl}/admin/ledger`,
    data: { kind: 'week_closed' },
  };
}
