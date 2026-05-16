import path from 'node:path';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import fstatic from '@fastify/static';
import { config, isProd } from './config.js';
import { authPlugin } from './auth/plugin.js';
import { authRoutes } from './routes/auth.js';
import { familyRoutes } from './routes/family.js';
import { choreRoutes } from './routes/chores.js';
import { boardRoutes } from './routes/board.js';
import { statsRoutes } from './routes/stats.js';
import { historyStatsRoutes } from './routes/historyStats.js';
import { ledgerRoutes } from './routes/ledger.js';
import { goalsRoutes } from './routes/goals.js';
import { milestonesRoutes } from './routes/milestones.js';
import { sseRoutes } from './routes/sse.js';
import { devicesRoutes } from './routes/devices.js';
import { billingRoutes } from './routes/billing.js';
import { whiteboardRoutes } from './routes/whiteboards.js';
import { listsRoutes } from './routes/lists.js';
import { productsRoutes } from './routes/products.js';
import { wellKnownRoutes } from './routes/wellKnown.js';
import { adminDashStatsRoutes } from './routes/adminDashStats.js';
import { scheduler } from './scheduler/runner.js';
import { ensureBadgeCatalogSeeded } from './domain/gamification.js';

async function main() {
  const app = Fastify({
    logger: {
      transport: isProd ? undefined : { target: 'pino-pretty', options: { colorize: true } },
    },
    trustProxy: true,
  });

  await app.register(cookie, { secret: config.sessionSecret });
  await app.register(cors, {
    // WEB_ORIGIN is a comma-separated allowlist. In prod it must include
    // both the web SPA host (https://app.choreboard.io) AND Capacitor's
    // schemes (capacitor://localhost on iOS, https://localhost on Android)
    // so the native shells can hit api.choreboard.io.
    origin: config.webOrigin === '*' ? true : config.webOrigin.split(',').map((s) => s.trim()),
    credentials: true,
    // Native sends `Authorization: Bearer ...` and `X-Client: native`.
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Client', 'Stripe-Signature'],
  });

  await app.register(authPlugin);

  app.get('/health', async () => ({ ok: true, time: new Date().toISOString() }));

  // .well-known files for Apple Universal Links + Android App Links.
  // Mounted at the root, NOT under /api, because the OS expects exactly
  // /.well-known/apple-app-site-association on app.choreboard.io.
  await app.register(wellKnownRoutes);

  await app.register(
    async (api) => {
      await api.register(authRoutes);
      await api.register(familyRoutes);
      await api.register(choreRoutes);
      await api.register(boardRoutes);
      await api.register(statsRoutes);
      await api.register(historyStatsRoutes);
      await api.register(ledgerRoutes);
      await api.register(goalsRoutes);
      await api.register(milestonesRoutes);
      await api.register(sseRoutes);
      await api.register(devicesRoutes);
      await api.register(billingRoutes);
      await api.register(whiteboardRoutes);
      await api.register(listsRoutes);
      await api.register(productsRoutes);
      await api.register(adminDashStatsRoutes);
    },
    { prefix: '/api' },
  );

  // Serve the built SPA in production (single origin = single deploy).
  if (config.webDistDir) {
    const dir = path.resolve(config.webDistDir);
    await app.register(fstatic, {
      root: dir,
      prefix: '/',
      wildcard: false,
    });
    // Client-side React routes (e.g. /desktop/3, /admin/chores, /privacy)
    // must all serve the SPA shell on direct refresh. We register an
    // explicit catch-all instead of relying only on setNotFoundHandler because
    // static middleware/host adapters can otherwise turn deep links into a
    // platform 404 before the SPA gets a chance to boot.
    app.get('/*', async (req, reply) => {
      if (req.url.startsWith('/api/') || req.url.startsWith('/.well-known/')) {
        return reply.code(404).send({ error: 'not_found' });
      }
      return reply.sendFile('index.html');
    });
    app.setNotFoundHandler(async (req, reply) => {
      // Don't fallthrough to index.html for /api/* or /.well-known/* —
      // those should 404 cleanly so misconfigured clients see a real error.
      if (req.url.startsWith('/api/') || req.url.startsWith('/.well-known/')) {
        return reply.code(404).send({ error: 'not_found' });
      }
      return reply.sendFile('index.html');
    });
  }

  app.setErrorHandler((err, _req, reply) => {
    const status = (err as any).statusCode ?? 500;
    if (status >= 500) app.log.error(err);
    reply.code(status).send({ error: err.message ?? 'server_error' });
  });

  await ensureBadgeCatalogSeeded();
  await scheduler.start();

  await app.listen({ host: config.host, port: config.port });
  app.log.info(`ChoreBoard API listening on ${config.host}:${config.port}`);
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
