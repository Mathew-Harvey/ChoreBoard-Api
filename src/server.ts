import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
import { ledgerRoutes } from './routes/ledger.js';
import { goalsRoutes } from './routes/goals.js';
import { sseRoutes } from './routes/sse.js';
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
    origin: config.webOrigin === '*' ? true : config.webOrigin.split(','),
    credentials: true,
  });

  await app.register(authPlugin);

  app.get('/health', async () => ({ ok: true, time: new Date().toISOString() }));

  await app.register(async (api) => {
    await api.register(authRoutes);
    await api.register(familyRoutes);
    await api.register(choreRoutes);
    await api.register(boardRoutes);
    await api.register(statsRoutes);
    await api.register(ledgerRoutes);
    await api.register(goalsRoutes);
    await api.register(sseRoutes);
  }, { prefix: '/api' });

  // Serve the built SPA in production (single origin = single deploy).
  if (config.webDistDir) {
    const dir = path.resolve(config.webDistDir);
    await app.register(fstatic, {
      root: dir,
      prefix: '/',
      wildcard: false,
    });
    app.setNotFoundHandler(async (req, reply) => {
      if (req.url.startsWith('/api/')) return reply.code(404).send({ error: 'not_found' });
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
