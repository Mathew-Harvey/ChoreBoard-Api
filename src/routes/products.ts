import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  isSupermarketConfigured,
  lookupWoolworthsBarcode,
  refreshProductPrice,
  searchWoolworthsProducts,
  type ProductCard,
} from '../integrations/supermarket.js';

/**
 * /products — read-only proxy in front of our supermarket integration.
 *
 * The list editor calls this when the user types into the "find a product"
 * search; it returns a normalised `ProductCard[]` regardless of which
 * upstream we eventually plug in. v1 only knows Woolworths.
 *
 * All endpoints require an authenticated family member so we don't become a
 * free RapidAPI gateway for the internet.
 */

export async function productsRoutes(app: FastifyInstance): Promise<void> {
  // GET /products/status — used by the editor to decide whether to even show
  // the search box. Cheap and unauthenticated-safe (still requires a session).
  app.get('/products/status', async (req) => {
    req.requireAnyMember();
    return {
      sources: {
        woolworths: { available: isSupermarketConfigured() },
      },
    };
  });

  // GET /products/search?q=apples
  app.get('/products/search', async (req, reply) => {
    req.requireAnyMember();
    const q = z
      .object({
        q: z.string().min(1).max(120),
        page: z.coerce.number().int().min(1).max(20).optional(),
        pageSize: z.coerce.number().int().min(1).max(40).optional(),
        source: z.enum(['woolworths']).optional(),
      })
      .parse(req.query);
    try {
      const products: ProductCard[] = await searchWoolworthsProducts(q.q, {
        page: q.page,
        pageSize: q.pageSize,
      });
      return { products };
    } catch (e) {
      app.log.warn({ err: e }, 'product search failed');
      // Surface a soft 200 with empty results so the editor degrades to a
      // plain text input without scaring the user with a hard error.
      return reply.code(200).send({ products: [], error: 'upstream_unavailable' });
    }
  });

  // GET /products/lookup?barcode=9300605008237
  app.get('/products/lookup', async (req, reply) => {
    req.requireAnyMember();
    const q = z
      .object({
        barcode: z.string().min(4).max(64),
      })
      .parse(req.query);
    try {
      const product = await lookupWoolworthsBarcode(q.barcode);
      return { product };
    } catch (e) {
      app.log.warn({ err: e }, 'barcode lookup failed');
      return reply.code(200).send({ product: null, error: 'upstream_unavailable' });
    }
  });

  // POST /products/refresh — refresh a single cached product card. Used when
  // a list opens and we want fresh prices on the headline rows.
  app.post('/products/refresh', async (req, reply) => {
    req.requireAnyMember();
    const body = z
      .object({ externalId: z.string().min(1).max(64) })
      .parse(req.body);
    try {
      const product = await refreshProductPrice(body.externalId);
      return { product };
    } catch (e) {
      app.log.warn({ err: e }, 'product refresh failed');
      return reply.code(200).send({ product: null, error: 'upstream_unavailable' });
    }
  });
}
