import fp from 'fastify-plugin';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { kids, users } from '../db/schema.js';
import { config, isProd } from '../config.js';
import { createSession, deleteSession, getSession, type SessionRow } from './sessions.js';

export type ParentPrincipal = {
  kind: 'parent';
  userId: string;
  familyId: string;
  role: 'owner' | 'parent';
  name: string;
  email: string;
};

export type KidPrincipal = {
  kind: 'kid';
  kidId: string;
  familyId: string;
  name: string;
  color: string;
};

export type Principal = ParentPrincipal | KidPrincipal;

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

export const authPlugin = fp(async (app) => {
  app.decorateReply('setSessionCookie', function (this: FastifyReply, sessionId: string) {
    this.setCookie(config.sessionCookieName, sessionId, {
      httpOnly: true,
      sameSite: 'lax',
      secure: isProd,
      path: '/',
      maxAge: config.sessionTtlDays * 24 * 60 * 60,
    });
    return this;
  });

  app.decorateReply('clearSessionCookie', function (this: FastifyReply) {
    this.clearCookie(config.sessionCookieName, { path: '/' });
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

  // Resolve the principal from the session cookie for every request.
  app.addHook('onRequest', async (req) => {
    const cookieValue = req.cookies[config.sessionCookieName];
    if (!cookieValue) return;

    const session = await getSession(cookieValue);
    if (!session) return;

    req.session = session;

    if (session.userId) {
      const [u] = await db.select().from(users).where(eq(users.id, session.userId)).limit(1);
      if (u) {
        req.principal = {
          kind: 'parent',
          userId: u.id,
          familyId: u.familyId,
          role: u.role,
          name: u.name,
          email: u.email,
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
        };
      }
    }
  });
});

export async function startParentSession(reply: FastifyReply, userId: string, familyId: string) {
  const s = await createSession({ familyId, userId });
  reply.setSessionCookie(s.id);
  return s;
}

export async function startKidSession(reply: FastifyReply, kidId: string, familyId: string) {
  const s = await createSession({ familyId, kidId });
  reply.setSessionCookie(s.id);
  return s;
}

export async function endSession(req: FastifyRequest, reply: FastifyReply) {
  if (req.session) {
    await deleteSession(req.session.id);
  }
  reply.clearSessionCookie();
}
