import fp from 'fastify-plugin';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { families, kids, sessions, users } from '../db/schema.js';
import { config, isProd } from '../config.js';
import { createSession, deleteSession, getSession, type SessionRow } from './sessions.js';

export type Gender = 'male' | 'female' | 'unspecified';

export type ParentPrincipal = {
  kind: 'parent';
  userId: string;
  familyId: string;
  role: 'owner' | 'parent';
  name: string;
  email: string;
  color: string;
  gender: Gender;
  /**
   * When the OnboardWizard at /onboard completed for this family. The SPA
   * uses it to gate App.tsx's signed-in routes — until this is non-null
   * every parent login lands on /onboard rather than the Kanban.
   */
  familyOnboardingCompletedAt: string | null;
};

export type KidPrincipal = {
  kind: 'kid';
  kidId: string;
  familyId: string;
  name: string;
  color: string;
  gender: Gender;
};

export type Principal = ParentPrincipal | KidPrincipal;

export type SessionTransport = 'cookie' | 'bearer' | 'pairing';

// Narrow set of transports a fresh login can pick. `pairing` is reserved for
// the device session minted by POST /api/auth/pair and is never inferred from
// a request — it's set explicitly by that route.
export type LoginTransport = 'cookie' | 'bearer';

declare module 'fastify' {
  interface FastifyRequest {
    session?: SessionRow;
    principal?: Principal;
    requireParent(): ParentPrincipal;
    requireAnyMember(): Principal;
  }
  interface FastifyReply {
    setSessionCookie(sessionId: string): FastifyReply;
    clearSessionCookie(): FastifyReply;
  }
}

/**
 * Resolve the session token from one of three transports, in priority order:
 *  1. `Authorization: Bearer <token>` header — used by the Capacitor native
 *     app, which can't reliably round-trip cross-origin cookies on iOS WKWebView.
 *  2. `?session=<token>` query string — used by EventSource on native, since
 *     EventSource doesn't allow custom headers. Only honoured for the SSE
 *     route to keep the surface area small (see SSE handler).
 *  3. The session cookie — used by the browser SPA at app.choreboard.io.
 *
 * Returns the token plus the transport that supplied it (so we can stamp it
 * onto fresh sessions and revoke by transport later).
 */
function readSessionToken(req: FastifyRequest): { token: string; transport: SessionTransport } | null {
  const auth = req.headers.authorization;
  if (auth && auth.startsWith('Bearer ')) {
    const token = auth.slice('Bearer '.length).trim();
    if (token) return { token, transport: 'bearer' };
  }

  const query = req.query as Record<string, string | undefined> | undefined;
  if (query?.session && req.url.startsWith('/api/events')) {
    return { token: query.session, transport: 'bearer' };
  }

  const cookieValue = req.cookies[config.sessionCookieName];
  if (cookieValue) return { token: cookieValue, transport: 'cookie' };

  return null;
}

export const authPlugin = fp(async (app) => {
  app.decorateReply('setSessionCookie', function (this: FastifyReply, sessionId: string) {
    this.setCookie(config.sessionCookieName, sessionId, {
      httpOnly: true,
      sameSite: 'lax',
      secure: isProd,
      path: '/',
      maxAge: config.sessionTtlDays * 24 * 60 * 60,
      domain: config.cookieDomain || undefined,
    });
    return this;
  });

  app.decorateReply('clearSessionCookie', function (this: FastifyReply) {
    this.clearCookie(config.sessionCookieName, {
      path: '/',
      domain: config.cookieDomain || undefined,
    });
    return this;
  });

  app.decorateRequest('session', undefined);
  app.decorateRequest('principal', undefined);

  app.decorateRequest('requireParent', function (this: FastifyRequest): ParentPrincipal {
    const p = this.principal;
    if (!p || p.kind !== 'parent') {
      const err = new Error('Parent authentication required');
      (err as any).statusCode = 401;
      throw err;
    }
    return p;
  });

  app.decorateRequest('requireAnyMember', function (this: FastifyRequest): Principal {
    const p = this.principal;
    if (!p) {
      const err = new Error('Authentication required');
      (err as any).statusCode = 401;
      throw err;
    }
    return p;
  });

  // Resolve the principal from whichever transport supplied the session token
  // for every request.
  app.addHook('onRequest', async (req) => {
    const supplied = readSessionToken(req);
    if (!supplied) return;

    const session = await getSession(supplied.token);
    if (!session) return;

    // Elevated parent sessions on the kitchen tablet auto-expire after
    // config.parentTabletIdleMin idle minutes. If the elevation timer has
    // run out, drop the session row and treat the request as
    // unauthenticated. The next write the SPA attempts will get a clean
    // 401 and the kid principal can take back over.
    if (session.elevationExpiresAt && session.elevationExpiresAt.getTime() < Date.now()) {
      await db.delete(sessions).where(eq(sessions.id, session.id));
      return;
    }

    req.session = session;

    if (session.userId) {
      const [u] = await db.select().from(users).where(eq(users.id, session.userId)).limit(1);
      if (u) {
        // Pull the family's onboarding flag in the same hop so we can gate
        // route-level redirects without a second round trip on the SPA.
        const fam = await db
          .select({ onboardingCompletedAt: families.onboardingCompletedAt })
          .from(families)
          .where(eq(families.id, u.familyId))
          .limit(1);
        req.principal = {
          kind: 'parent',
          userId: u.id,
          familyId: u.familyId,
          role: u.role,
          name: u.name,
          email: u.email,
          color: u.color,
          gender: u.gender,
          familyOnboardingCompletedAt:
            fam[0]?.onboardingCompletedAt?.toISOString() ?? null,
        };
      }
    } else if (session.kidId) {
      const [k] = await db.select().from(kids).where(eq(kids.id, session.kidId)).limit(1);
      if (k) {
        req.principal = {
          kind: 'kid',
          kidId: k.id,
          familyId: k.familyId,
          name: k.name,
          color: k.color,
          gender: k.gender,
        };
      }
    }
  });

  // Refresh the elevation timer on writes (POST/PATCH/PUT/DELETE) — reads do
  // NOT extend it, so a tablet left on the Kanban indefinitely will idle
  // out. We do this onResponse so a write that ultimately failed (e.g. a
  // 4xx) still counts as activity — the parent is clearly here, working.
  app.addHook('onResponse', async (req) => {
    const session = req.session;
    if (!session?.elevationExpiresAt) return;
    const method = req.method.toUpperCase();
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return;
    const next = new Date(Date.now() + config.parentTabletIdleMin * 60 * 1000);
    await db
      .update(sessions)
      .set({ elevationExpiresAt: next })
      .where(eq(sessions.id, session.id));
  });
});

/**
 * Bag returned by every login/signup. Web clients ignore `token` and rely on
 * the cookie that `setSessionCookie` planted; native (Capacitor) clients store
 * the token in `Capacitor.Preferences` and send it as `Authorization: Bearer`.
 */
export type SessionBag = {
  token: string;
  expiresAt: string; // ISO
};

export async function startParentSession(
  reply: FastifyReply,
  userId: string,
  familyId: string,
  transport: LoginTransport = 'cookie',
): Promise<SessionBag> {
  const s = await createSession({ familyId, userId, transport });
  if (transport === 'cookie') reply.setSessionCookie(s.id);
  return { token: s.id, expiresAt: s.expiresAt.toISOString() };
}

export async function startKidSession(
  reply: FastifyReply,
  kidId: string,
  familyId: string,
  transport: LoginTransport = 'cookie',
): Promise<SessionBag> {
  const s = await createSession({ familyId, kidId, transport });
  if (transport === 'cookie') reply.setSessionCookie(s.id);
  return { token: s.id, expiresAt: s.expiresAt.toISOString() };
}

export async function endSession(req: FastifyRequest, reply: FastifyReply) {
  if (req.session) {
    await deleteSession(req.session.id);
  }
  reply.clearSessionCookie();
}

/**
 * Decide which transport a fresh login should use, based on the request that
 * triggered the login. Native clients are expected to send a header on every
 * request (including the login itself) so we sniff `X-Client: native`.
 *
 * Falls back to cookie for everything else, which keeps existing browser
 * behaviour byte-identical.
 */
export function pickTransport(req: FastifyRequest): LoginTransport {
  const hint = req.headers['x-client'];
  if (typeof hint === 'string' && hint.toLowerCase() === 'native') return 'bearer';
  return 'cookie';
}
