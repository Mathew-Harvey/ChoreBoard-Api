import { and, eq, ilike, or } from 'drizzle-orm';
import { db } from '../db/client.js';
import { productCache } from '../db/schema.js';

/**
 * Thin proxy for the Woolworths Products API on RapidAPI.
 *
 * Why proxy rather than letting the SPA call RapidAPI directly?
 *  1. Keeps the API key server-side (the key is rate-limited per RapidAPI
 *     account; bundling it in JS would let any visitor mint requests).
 *  2. Lets us cache responses in `product_cache` so the kitchen iPad doesn't
 *     burn through quota every time someone scrolls a list.
 *  3. Lets us normalise responses into a single `ProductCard` shape that
 *     /lists items can attach without each client reimplementing the shape.
 *
 * The upstream API surface fluctuates (RapidAPI listings often add/remove
 * fields). We deliberately read every field defensively — anything we can't
 * find returns null instead of throwing — so a mid-quarter upstream tweak
 * doesn't take the whole list editor down.
 */

export type ProductCard = {
  source: 'woolworths';
  externalId: string;
  name: string;
  brand: string | null;
  image: string | null;
  packageSize: string | null;
  priceCents: number | null;
  wasPriceCents: number | null;
  onSpecial: boolean;
};

const RAPIDAPI_HOST = 'woolworths-products-api.p.rapidapi.com';
// Refresh cached entries when they're older than this. An hour is a sweet
// spot: long enough that ten people scrolling the same list don't fan out
// to ten upstream fetches, short enough that "$8.50, on special" doesn't
// linger after the special ends at midnight.
const CACHE_TTL_MS = 60 * 60 * 1000;

function rapidApiKey(): string | null {
  const key = process.env.RAPIDAPI_WOOLWORTHS_KEY ?? process.env.RAPIDAPI_KEY ?? '';
  return key ? key : null;
}

export function isSupermarketConfigured(): boolean {
  return rapidApiKey() != null;
}

async function rapidFetch(path: string, query: Record<string, string | number | undefined>) {
  const key = rapidApiKey();
  if (!key) throw new Error('rapidapi_not_configured');
  const url = new URL(`https://${RAPIDAPI_HOST}${path}`);
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }
  const res = await fetch(url.toString(), {
    method: 'GET',
    headers: {
      'x-rapidapi-key': key,
      'x-rapidapi-host': RAPIDAPI_HOST,
      Accept: 'application/json',
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`rapidapi_${res.status}:${body.slice(0, 200)}`);
  }
  return res.json();
}

// ----------------------------------------------------------------------------
// Normalisation
// ----------------------------------------------------------------------------

function pickString(o: Record<string, unknown>, ...keys: string[]): string | null {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}

function pickNumber(o: Record<string, unknown>, ...keys: string[]): number | null {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string') {
      const cleaned = v.replace(/[^\d.\-]/g, '');
      if (cleaned) {
        const n = Number(cleaned);
        if (Number.isFinite(n)) return n;
      }
    }
  }
  return null;
}

function toCents(dollars: number | null): number | null {
  if (dollars == null) return null;
  return Math.round(dollars * 100);
}

function normaliseImageUrl(raw: string | null, externalId: string): string | null {
  if (raw) {
    const value = raw.trim();
    const lower = value.toLowerCase();
    // The RapidAPI response includes a Woolworths product page `URL`; that is
    // not an image and breaks <img>. Only accept actual image-like URLs here.
    if (/\.(png|jpe?g|webp)(\?|$)/i.test(value) || lower.includes('wowproductimages')) {
      if (value.startsWith('//')) return `https:${value}`;
      if (value.startsWith('/')) return `https://www.woolworths.com.au${value}`;
      return value.replace(/^http:\/\//i, 'https://');
    }
  }

  // Woolworths product images are keyed by stockcode on their CDN. Search
  // results usually include Stockcode, even when no image field is returned.
  if (/^\d{3,8}$/.test(externalId)) {
    return `https://cdn0.woolworths.media/content/wowproductimages/large/${externalId}.jpg`;
  }
  return null;
}

/**
 * Map a single upstream product (whichever shape RapidAPI hands us) onto our
 * normalised `ProductCard`. We look at every plausible alias for each field,
 * so future RapidAPI rev tweaks don't break us silently.
 */
export function normaliseProduct(raw: unknown): ProductCard | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;

  const externalId =
    pickString(o, 'Stockcode', 'StockCode', 'stockcode', 'productId', 'id', 'sku') ??
    pickString(o, 'Barcode', 'barcode', 'Product Barcode', 'product_barcode') ??
    pickString(o, 'URL', 'url');
  const name = pickString(
    o,
    'Name',
    'name',
    'DisplayName',
    'product_name',
    'productName',
    'Product Name',
  );
  if (!externalId || !name) return null;

  const brand = pickString(o, 'Brand', 'brand', 'Product Brand', 'manufacturer');
  const rawImage = pickString(
    o,
    'LargeImageFile',
    'MediumImageFile',
    'SmallImageFile',
    'Image',
    'image',
    'imageUrl',
    'thumbnail',
    'URL',
    'url',
    'Product Image',
    'Image URL',
  );
  const image = normaliseImageUrl(rawImage, externalId);
  const packageSize = pickString(
    o,
    'PackageSize',
    'packageSize',
    'product_size',
    'size',
    'Product Size',
  );

  const price =
    pickNumber(o, 'CurrentPrice', 'currentPrice', 'price', 'Price', 'Current Price') ??
    pickNumber(o, 'instorePrice', 'InstorePrice');
  const was = pickNumber(o, 'WasPrice', 'wasPrice', 'Was Price', 'savingsAmount');

  const priceCents = toCents(price);
  const wasPriceCents = toCents(was);
  const onSpecial =
    Boolean(o.IsOnSpecial ?? o.isOnSpecial ?? o.onSpecial) ||
    (wasPriceCents != null && priceCents != null && wasPriceCents > priceCents);

  return {
    source: 'woolworths',
    externalId,
    name,
    brand,
    image,
    packageSize,
    priceCents,
    wasPriceCents,
    onSpecial,
  };
}

/**
 * Find the product list inside an upstream response. RapidAPI listings tend
 * to wrap results under different keys ("Products", "results", "data") so we
 * scan a known set and fall back to any array we can find.
 */
function extractProductArray(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  const o = payload as Record<string, unknown>;
  for (const key of ['Products', 'products', 'Results', 'results', 'data', 'items', 'Items']) {
    const v = o[key];
    if (Array.isArray(v)) return v;
  }
  for (const key of ['Product', 'product', 'result', 'item']) {
    const v = o[key];
    if (v && typeof v === 'object') return [v];
  }
  // Sometimes the products live one level deeper: { Bundles: [{ Products:[…] }] }
  if (Array.isArray(o.Bundles)) {
    const flat: unknown[] = [];
    for (const b of o.Bundles as unknown[]) {
      if (b && typeof b === 'object' && Array.isArray((b as Record<string, unknown>).Products)) {
        flat.push(...((b as Record<string, unknown>).Products as unknown[]));
      }
    }
    if (flat.length) return flat;
  }
  return [];
}

// ----------------------------------------------------------------------------
// Cache helpers
// ----------------------------------------------------------------------------

async function writeToCache(card: ProductCard, payload: unknown): Promise<void> {
  await db
    .insert(productCache)
    .values({
      source: card.source,
      externalId: card.externalId,
      name: card.name,
      brand: card.brand,
      image: card.image,
      packageSize: card.packageSize,
      priceCents: card.priceCents,
      wasPriceCents: card.wasPriceCents,
      onSpecial: card.onSpecial,
      payloadJson: payload as Record<string, unknown> | null,
    })
    .onConflictDoUpdate({
      target: [productCache.source, productCache.externalId],
      set: {
        name: card.name,
        brand: card.brand,
        image: card.image,
        packageSize: card.packageSize,
        priceCents: card.priceCents,
        wasPriceCents: card.wasPriceCents,
        onSpecial: card.onSpecial,
        payloadJson: payload as Record<string, unknown> | null,
        cachedAt: new Date(),
      },
    });
}

async function readFromCache(source: 'woolworths', externalId: string): Promise<ProductCard | null> {
  const [row] = await db
    .select()
    .from(productCache)
    .where(and(eq(productCache.source, source), eq(productCache.externalId, externalId)))
    .limit(1);
  if (!row) return null;
  return {
    source: 'woolworths',
    externalId: row.externalId,
    name: row.name,
    brand: row.brand,
    image: row.image,
    packageSize: row.packageSize,
    priceCents: row.priceCents,
    wasPriceCents: row.wasPriceCents,
    onSpecial: row.onSpecial,
  };
}

function isCacheFresh(ts: Date | null | undefined): boolean {
  if (!ts) return false;
  return Date.now() - ts.getTime() < CACHE_TTL_MS;
}

// ----------------------------------------------------------------------------
// Public surface
// ----------------------------------------------------------------------------

export async function searchWoolworthsProducts(
  query: string,
  opts: { page?: number; pageSize?: number } = {},
): Promise<ProductCard[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];

  // Try a fuzzy cache hit first — if we've fetched this term recently we
  // can answer entirely from local data.
  const cacheLike = `%${trimmed}%`;
  const cached = await db
    .select()
    .from(productCache)
    .where(
      and(
        eq(productCache.source, 'woolworths'),
        or(ilike(productCache.name, cacheLike), ilike(productCache.brand ?? '', cacheLike)),
      ),
    )
    .limit(opts.pageSize ?? 20);
  const fresh = cached.filter((r) => isCacheFresh(r.cachedAt));
  if (fresh.length >= 5 && !opts.page) {
    return fresh.map((row) => ({
      source: 'woolworths',
      externalId: row.externalId,
      name: row.name,
      brand: row.brand,
      image: row.image,
      packageSize: row.packageSize,
      priceCents: row.priceCents,
      wasPriceCents: row.wasPriceCents,
      onSpecial: row.onSpecial,
    }));
  }

  if (!isSupermarketConfigured()) {
    // No upstream key. Return whatever stale cache we have so the editor
    // still works for previously-seen products.
    return cached.map((row) => ({
      source: 'woolworths',
      externalId: row.externalId,
      name: row.name,
      brand: row.brand,
      image: row.image,
      packageSize: row.packageSize,
      priceCents: row.priceCents,
      wasPriceCents: row.wasPriceCents,
      onSpecial: row.onSpecial,
    }));
  }

  // Upstream call. RapidAPI documents this as:
  //   GET /woolworths/product-search/?query=Kraft%20Singles
  const payload = await tryFetchSearch(trimmed, opts.page ?? 1, opts.pageSize ?? 20);
  const items = extractProductArray(payload);
  const cards: ProductCard[] = [];
  for (const it of items) {
    const card = normaliseProduct(it);
    if (card) {
      cards.push(card);
      try {
        await writeToCache(card, it);
      } catch {
        // Cache write failure is non-fatal — log via Fastify in caller if needed.
      }
    }
  }
  return cards;
}

async function tryFetchSearch(query: string, page: number, pageSize: number): Promise<unknown> {
  const candidates: Array<{ path: string; q: Record<string, string | number> }> = [
    {
      path: '/woolworths/product-search/',
      q: { query },
    },
    // Keep paged variants as fallbacks for accounts/API revisions that accept them.
    { path: '/woolworths/product-search/', q: { query, page, page_size: pageSize } },
    { path: '/woolworths/products/search/', q: { query, page, size: pageSize } },
    { path: '/products/search', q: { q: query, page, page_size: pageSize } },
  ];
  let lastError: unknown = null;
  for (const c of candidates) {
    try {
      return await rapidFetch(c.path, c.q);
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError ?? new Error('upstream_unreachable');
}

export async function lookupWoolworthsBarcode(barcode: string): Promise<ProductCard | null> {
  const trimmed = barcode.trim();
  if (!trimmed) return null;

  const cached = await readFromCache('woolworths', trimmed);
  if (cached && isCacheFresh(await cachedAt('woolworths', trimmed))) return cached;

  if (!isSupermarketConfigured()) return cached;

  const payload = await tryFetchBarcode(trimmed);
  const items = extractProductArray(payload);
  const first = items.length ? normaliseProduct(items[0]) : normaliseProduct(payload);
  if (first) {
    try {
      await writeToCache(first, items[0] ?? payload);
    } catch {
      /* non-fatal */
    }
    return first;
  }
  return cached;
}

async function tryFetchBarcode(barcode: string): Promise<unknown> {
  const candidates: Array<{ path: string; q: Record<string, string | number> }> = [
    // RapidAPI documents `barcode` as a path param:
    //   GET /woolworths/barcode-search/9310199012717
    { path: `/woolworths/barcode-search/${encodeURIComponent(barcode)}`, q: {} },
    { path: '/woolworths/barcode-search/', q: { barcode } },
    { path: '/woolworths/products/barcode/', q: { barcode } },
    { path: `/woolworths/barcode/${encodeURIComponent(barcode)}`, q: {} },
  ];
  let lastError: unknown = null;
  for (const c of candidates) {
    try {
      return await rapidFetch(c.path, c.q);
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError ?? new Error('upstream_unreachable');
}

async function cachedAt(source: 'woolworths', externalId: string): Promise<Date | null> {
  const [row] = await db
    .select({ cachedAt: productCache.cachedAt })
    .from(productCache)
    .where(and(eq(productCache.source, source), eq(productCache.externalId, externalId)))
    .limit(1);
  return row?.cachedAt ?? null;
}

export async function refreshProductPrice(externalId: string): Promise<ProductCard | null> {
  if (!isSupermarketConfigured()) return readFromCache('woolworths', externalId);
  // The API doesn't expose a single-product fetch on every plan, so we lean
  // on the search endpoint with the stockcode as the query — usually returns
  // the exact product as the top result.
  const cards = await searchWoolworthsProducts(externalId, { pageSize: 5 });
  return cards.find((c) => c.externalId === externalId) ?? cards[0] ?? null;
}
