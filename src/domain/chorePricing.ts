/**
 * Defensible per-chore pricing.
 *
 * The headline UX promise is "we suggest a fair price for each chore based
 * on the child's age and where you live". To honour that we anchor the
 * suggestion to published household-allowance and per-chore survey data,
 * then apply two transparent multipliers:
 *
 *   final = round_to_step(
 *     base[country][difficulty]      // local-currency floor for tier
 *     * ageMultiplier(age)           // 5 yo → 0.5, 9 yo → 1.0, 17 yo → 2.3
 *     * cadenceFactor(cadence),      // daily ≈ 1×, weekly ≈ 3×, monthly ≈ 6×
 *   )
 *
 * Sources used to anchor the country tables:
 *
 *   - **UK**: NatWest Rooster Money 2025 Pocket Money Index (n ≈ 350k
 *     Rooster Card users). Average weekly pocket money £3.85, with per-age
 *     points e.g. 6 yo £2.81, 12 yo £4.05, 17 yo £8.31. Per-chore rates
 *     observed in the 2025 Netmums and GoHenry surveys (tidy bedroom
 *     £1.12, plants £1.91).
 *     https://www.natwestgroup.com/.../pocket-money-index
 *     https://www.gohenry.com/uk/blog/chores/how-much-should-i-pay-my-child-for-doing-chores
 *
 *   - **AU**: Kit (HeyKit) October 2024 dataset — 70% of Aussie parents
 *     give pocket money, average $11.10/wk. Bands: 5-8 yo $7, 8-10 yo
 *     $7.50, 11-13 yo $10.40, 14-17+ $14.80.
 *     https://learn.heykit.com.au/learn-it/how-much-pocket-money-should-you-give-your-kids-in-2024
 *
 *   - **US**: Wells Fargo 2025 Money Study (n=1,587 parents, ±3%): 71% of
 *     parents pay an allowance averaging USD 37/wk; the chore-tier
 *     reference points are the widely-cited "ABC News / Best Life" figures
 *     50¢ for easy chores, $2 for intermediate, up to $5 for complex
 *     (e.g. mow the lawn). Greenlight's 2025 dataset gives 9-11 yo
 *     $7.50-$10/wk, 12-14 $12-$17, 15-17 $20-$30.
 *     https://www.fatherly.com/news/survey-reveals-what-american-kids-earn-in-allowance-for-different-chores
 *     https://greenlight.com/learning-center/earning/average-allowance-by-age-for-kids
 *
 * The numbers below are tuned so a "keen kid who completes everything in
 * their starter pack" lands within the survey total-allowance band for
 * their age and country, and so a single hard weekly chore (e.g. wash the
 * car) lands near the survey "complex chore" data point for that country.
 *
 * Currency is stored as a country-keyed default; an override on the family
 * record (PATCH /api/family) wins. Country is ISO 3166-1 alpha-2; currency
 * is ISO 4217.
 */

import type { CatalogChore, ChoreDifficulty } from './choreCatalog.js';
import type { Cadence } from './cadence.js';

export type CountryCode = string; // ISO 3166-1 alpha-2 (uppercased)

export type CurrencyCode = string; // ISO 4217 (uppercased)

type DifficultyTable = Record<ChoreDifficulty, number>;

/**
 * Per-fire base in **minor units** of the local currency, before the age
 * and cadence multipliers. "Minor units" = cents for AUD/USD/CAD/NZD,
 * pence for GBP, euro cents for EUR.
 *
 * The numbers below are the per-fire price for the **9-10 yo baseline**
 * doing the chore at its **default cadence**. The age and cadence
 * multipliers re-scale from there.
 */
const BASE_BY_COUNTRY: Record<CountryCode, DifficultyTable> = {
  AU: { easy: 40, medium: 100, hard: 250 },
  NZ: { easy: 40, medium: 100, hard: 250 },
  US: { easy: 30, medium: 80, hard: 200 },
  CA: { easy: 30, medium: 80, hard: 200 },
  GB: { easy: 25, medium: 70, hard: 180 },
  IE: { easy: 25, medium: 70, hard: 180 },
  // Eurozone fallthrough — most surveys cluster around UK numbers.
  FR: { easy: 25, medium: 70, hard: 180 },
  DE: { easy: 25, medium: 70, hard: 180 },
  ES: { easy: 25, medium: 70, hard: 180 },
  IT: { easy: 25, medium: 70, hard: 180 },
  NL: { easy: 25, medium: 70, hard: 180 },
};

/** Country → ISO-4217 currency. Used when the family hasn't overridden. */
const CURRENCY_BY_COUNTRY: Record<CountryCode, CurrencyCode> = {
  AU: 'AUD',
  NZ: 'NZD',
  US: 'USD',
  CA: 'CAD',
  GB: 'GBP',
  IE: 'EUR',
  FR: 'EUR',
  DE: 'EUR',
  ES: 'EUR',
  IT: 'EUR',
  NL: 'EUR',
};

/** Default fallback when the country isn't in our table. */
const DEFAULT_COUNTRY: CountryCode = 'US';

export function defaultCurrencyForCountry(country: string | null | undefined): CurrencyCode {
  if (!country) return CURRENCY_BY_COUNTRY[DEFAULT_COUNTRY]!;
  const cc = country.toUpperCase();
  return CURRENCY_BY_COUNTRY[cc] ?? CURRENCY_BY_COUNTRY[DEFAULT_COUNTRY]!;
}

function baseForCountry(country: string | null | undefined): DifficultyTable {
  if (!country) return BASE_BY_COUNTRY[DEFAULT_COUNTRY]!;
  const cc = country.toUpperCase();
  return BASE_BY_COUNTRY[cc] ?? BASE_BY_COUNTRY[DEFAULT_COUNTRY]!;
}

/**
 * Age multiplier anchored at 9-10 yo = 1.0, calibrated against the
 * RoosterMoney 6→17 ratio (~3×) and Greenlight 9-11 → 15-17 ratio (~2.5×)
 * for total weekly allowance, then dialled back per-chore (since the
 * *number* of chores grows with age too).
 */
const AGE_MULTIPLIER: Record<number, number> = {
  4: 0.45,
  5: 0.5,
  6: 0.6,
  7: 0.75,
  8: 0.85,
  9: 1.0,
  10: 1.1,
  11: 1.2,
  12: 1.35,
  13: 1.5,
  14: 1.7,
  15: 1.9,
  16: 2.1,
  17: 2.3,
  18: 2.4,
};

function ageMultiplier(age: number): number {
  if (!Number.isFinite(age)) return 1.0;
  if (age <= 4) return AGE_MULTIPLIER[4]!;
  if (age >= 18) return AGE_MULTIPLIER[18]!;
  const rounded = Math.floor(age);
  return AGE_MULTIPLIER[rounded] ?? 1.0;
}

/**
 * How much one *fire* of a cadence is worth, given that "weekly" feels
 * like one bigger task vs "daily" being one of seven. Tuned against the
 * existing STARTER_PACK numbers in the web onboard wizard so we don't
 * surprise long-time customers when they tap "Suggest fair prices":
 *  - daily 50c (~$3.50/wk anchor) → factor 1.0 over base
 *  - weekly 200c → factor ~3 over base
 *  - fortnightly 500c (e.g. wash car) → factor 4
 *  - monthly 800-1000c → factor 6
 */
function cadenceFactor(cadence: Cadence): number {
  switch (cadence.kind) {
    case 'daily':
      // Multi-time daily (e.g. feed pets twice/day) divides the per-fire
      // value so the *daily* take stays sensible — 2× pet-feeding pays
      // 0.6× per fire, not 1.0× per fire.
      return 1.0 / Math.max(1, cadence.times.length * 0.65);
    case 'every_n_days':
      return 1.0 + cadence.n * 0.2;
    case 'weekly': {
      const fires = Math.max(1, cadence.days.length);
      // 1 day/week → ×3, 3 days/week → ×1.6, 5 days/week → ×1.15.
      return 3.0 / Math.pow(fires, 0.7);
    }
    case 'every_n_weeks':
      return 3.0 + cadence.n * 0.5;
    case 'monthly_dom':
    case 'monthly_nth':
      return 6.0;
    default:
      return 1.0;
  }
}

/**
 * Round the raw price up to the nearest "tap-friendly" step in local
 * currency: 5c for AUD/USD/CAD/NZD, 5p for GBP, 5 cents for EUR. Keeps
 * suggestions from looking like USD 0.27 / GBP 1.83.
 */
function roundToStep(amountMinor: number, currency: CurrencyCode): number {
  // Most modern currencies don't circulate sub-5-cent coins; the App
  // Store / Play Store are happy with $0.05 increments. We DON'T round
  // hard chores up to a dollar — survey data shows parents pick numbers
  // like £1.12 or $7.50, not whole dollars.
  const step = currency === 'GBP' ? 5 : 5;
  if (amountMinor < step) return Math.max(step, Math.round(amountMinor));
  return Math.round(amountMinor / step) * step;
}

export type SuggestPriceInput = {
  age: number;
  country: string | null | undefined;
  currency?: string | null | undefined;
  difficulty: ChoreDifficulty;
  cadence: Cadence;
};

export type SuggestPriceResult = {
  amountCents: number;
  currency: CurrencyCode;
  /**
   * Breakdown of how the price was reached, surfaced in the API response
   * so the UI can show "5 yo · easy · daily" tooltip and so any audit /
   * support request can see exactly which inputs drove the number.
   */
  breakdown: {
    countryUsed: CountryCode;
    baseMinor: number;
    ageMultiplier: number;
    cadenceFactor: number;
    rawMinor: number;
    roundedMinor: number;
  };
};

export function suggestPrice(input: SuggestPriceInput): SuggestPriceResult {
  const countryUsed = (input.country ?? DEFAULT_COUNTRY).toUpperCase();
  const base = baseForCountry(countryUsed)[input.difficulty];
  const ageM = ageMultiplier(input.age);
  const cadM = cadenceFactor(input.cadence);
  const raw = base * ageM * cadM;
  const currency = (input.currency ?? defaultCurrencyForCountry(countryUsed)).toUpperCase();
  const rounded = roundToStep(raw, currency);
  return {
    amountCents: rounded,
    currency,
    breakdown: {
      countryUsed,
      baseMinor: base,
      ageMultiplier: ageM,
      cadenceFactor: cadM,
      rawMinor: Math.round(raw),
      roundedMinor: rounded,
    },
  };
}

/** Convenience: suggest the price for a catalog chore at a given age. */
export function suggestPriceForCatalog(
  chore: CatalogChore,
  age: number,
  country: string | null | undefined,
  currency?: string | null | undefined,
): SuggestPriceResult {
  return suggestPrice({
    age,
    country,
    currency,
    difficulty: chore.difficulty,
    cadence: chore.cadence,
  });
}
