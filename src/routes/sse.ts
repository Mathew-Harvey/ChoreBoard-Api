import type { FastifyInstance } from 'fastify';
import { bus, type FamilyEvent } from '../realtime/bus.js';

export async function sseRoutes(app: FastifyInstance): Promise<void> {
  app.get('/events', async (req, reply) => {
    const p = req.requireAnyMember();
    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    // Initial hello so the client knows we're connected.
    reply.raw.write(`event: hello\ndata: {"familyId":"${p.familyId}"}\n\n`);

    const send = (event: FamilyEvent) => {
      reply.raw.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    };

    const unsub = bus.subscribe(p.familyId, send);

    const heartbeat = setInterval(() => {
      reply.raw.write(`: ping\n\n`);
    }, 25_000);

    req.raw.on('close', () => {
      clearInterval(heartbeat);
      unsub();
      try {
        reply.raw.end();
      } catch {
        /* socket already closed */
      }
    });

    // We've hijacked the reply; this handler resolves but the socket stays open.
  });
}
