/**
 * Age-banded chore catalog.
 *
 * Each entry encodes the recommended age range, a difficulty tier (used by
 * the pricing engine), and a default cadence template. Entries are sourced
 * from the major paediatric / parenting bodies; citations live next to each
 * tier so the suggestion API stays defensible:
 *
 *   - American Academy of Child and Adolescent Psychiatry (AACAP),
 *     "Chores and Children" Facts for Families #125.
 *     https://www.aacap.org/AACAP/Families_and_Youth/Facts_for_Families/FFF-Guide/Chores_and_Children_125.aspx
 *   - American Academy of Pediatrics, HealthyChildren.org —
 *     "Age-Appropriate Chores for Children" and "Household Chores for
 *     Adolescents".
 *     https://www.healthychildren.org/English/family-life/family-dynamics/communication-discipline/Pages/Chores-and-Responsibility.aspx
 *     https://www.healthychildren.org/English/family-life/family-dynamics/Pages/Household-Chores-for-Adolescents.aspx
 *   - Children's Hospital of Philadelphia (CHOP), "Chores and Kids: How
 *     Much Should You Expect?".
 *     https://www.chop.edu/news/chores-and-kids-how-much-should-you-expect
 *   - University Hospitals Rainbow Babies & Children's, "Ages & Stages 6-8".
 *     https://www.uhhospitals.org/rainbow/health-information/health-and-wellness-library/ages-and-stages/6-8-years
 *   - Pediatric occupational therapy: Carolina Therapy Connection, Playright,
 *     LaDifference Pediatrics — pulled together as "the OT view" for the
 *     9-10 band where motor-skill specifics matter.
 *
 * The catalog is intentionally conservative: every chore here has at least
 * one paediatric / OT source recommending it for the listed age range. The
 * `pricing` engine in `chorePricing.ts` is the only thing that turns these
 * into a per-fire dollar amount — that way price tweaks (per-country, per
 * difficulty, etc.) don't require touching the catalog.
 */

import type { Cadence } from './cadence.js';

export type ChoreDifficulty = 'easy' | 'medium' | 'hard';

export type ChoreCategory =
  | 'self-care'
  | 'kitchen'
  | 'cleaning'
  | 'laundry'
  | 'pets'
  | 'yard'
  | 'meals'
  | 'family';

export type CatalogChore = {
  /** Stable slug used as a catalog identifier. Not exposed externally yet. */
  slug: string;
  /** Display name shown in the UI. */
  name: string;
  /** One-sentence description shown in suggestion cards. */
  description: string;
  /** Inclusive minimum recommended age. */
  minAge: number;
  /** Inclusive maximum recommended age — chores fade out as kids grow. */
  maxAge: number;
  difficulty: ChoreDifficulty;
  category: ChoreCategory;
  /** Default cadence template; pricing engine maps cadence → per-fire factor. */
  cadence: Cadence;
  /**
   * Free-form citation tag. Kept in code so reviewers can verify the source
   * without leaving the file. Format: `"<org-short>: <topic>"`.
   */
  source: string;
};

const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];
const SCHOOL_DAYS = [1, 2, 3, 4, 5];
const WEEKEND = [6];

// ----------------------------------------------------------------------------
// 5-6 yo — foundational habits. AACAP and HealthyChildren both anchor the
// list at "make the bed (imperfectly)", "feed pets with help", "help clear
// the table", and "put toys away". CHOP adds "empty wastebaskets" and
// "clean up spills with a dust pan + brush".
// ----------------------------------------------------------------------------
const ECE: CatalogChore[] = [
  {
    slug: 'make-bed',
    name: 'Make your bed',
    description: 'Pull up sheets and tuck the doona. Doesn’t have to be perfect.',
    minAge: 5,
    maxAge: 12,
    difficulty: 'easy',
    category: 'self-care',
    cadence: { kind: 'daily', times: ['09:00'] },
    source: 'AACAP / CHOP — 4-7 yo bed-making',
  },
  {
    slug: 'tidy-toys',
    name: 'Tidy your toys',
    description: 'Pack toys into the toy box before bath time.',
    minAge: 5,
    maxAge: 10,
    difficulty: 'easy',
    category: 'self-care',
    cadence: { kind: 'daily', times: ['17:30'] },
    source: 'HealthyChildren — 4-6 yo "put away toys"',
  },
  {
    slug: 'feed-pets',
    name: 'Feed the pets',
    description: 'Scoop food into pet bowls (with a little help if needed).',
    minAge: 5,
    maxAge: 17,
    difficulty: 'easy',
    category: 'pets',
    cadence: { kind: 'daily', times: ['07:00', '17:00'] },
    source: 'AACAP — 4-5 yo pets, scales up',
  },
  {
    slug: 'clear-own-dishes',
    name: 'Clear your dishes',
    description: 'Take your plate, cup and cutlery to the sink after meals.',
    minAge: 5,
    maxAge: 12,
    difficulty: 'easy',
    category: 'kitchen',
    cadence: { kind: 'daily', times: ['19:00'] },
    source: 'CHOP / HealthyChildren — 5-6 yo clearing',
  },
  {
    slug: 'put-clothes-in-hamper',
    name: 'Put dirty clothes in the hamper',
    description: 'Drop today’s clothes into the laundry basket.',
    minAge: 5,
    maxAge: 12,
    difficulty: 'easy',
    category: 'laundry',
    cadence: { kind: 'daily', times: ['19:30'] },
    source: 'HealthyChildren — 5-6 yo "put dirty clothes in hamper"',
  },
  {
    slug: 'empty-wastebaskets',
    name: 'Empty the small bins',
    description: 'Tip bedroom and bathroom wastebaskets into the kitchen bin.',
    minAge: 6,
    maxAge: 14,
    difficulty: 'easy',
    category: 'cleaning',
    cadence: { kind: 'weekly', days: [6], time: '10:00' },
    source: 'CHOP — 5-6 yo wastebaskets',
  },
  {
    slug: 'wipe-table',
    name: 'Wipe the table',
    description: 'Wipe the dining table after dinner with a damp cloth.',
    minAge: 6,
    maxAge: 12,
    difficulty: 'easy',
    category: 'kitchen',
    cadence: { kind: 'daily', times: ['19:15'] },
    source: 'AACAP — 6-7 yo wipe tables/counters',
  },
  {
    slug: 'water-plants',
    name: 'Water the indoor plants',
    description: 'Give pot plants a small drink of water.',
    minAge: 6,
    maxAge: 17,
    difficulty: 'easy',
    category: 'cleaning',
    cadence: { kind: 'every_n_days', n: 3, time: '08:00' },
    source: 'HealthyChildren — 6-7 yo water flowers',
  },
  {
    slug: 'sweep-floor',
    name: 'Sweep the kitchen floor',
    description: 'Sweep crumbs into a dustpan after dinner.',
    minAge: 6,
    maxAge: 14,
    difficulty: 'easy',
    category: 'cleaning',
    cadence: { kind: 'weekly', days: [3, 6], time: '19:30' },
    source: 'AACAP — 6-7 yo sweep floors',
  },
  {
    slug: 'bring-in-mail',
    name: 'Bring in the mail',
    description: 'Check the letterbox after school and put mail on the bench.',
    minAge: 6,
    maxAge: 14,
    difficulty: 'easy',
    category: 'family',
    cadence: { kind: 'weekly', days: SCHOOL_DAYS, time: '15:30' },
    source: 'HealthyChildren — 6-7 yo bring in mail',
  },
];

// ----------------------------------------------------------------------------
// 7-8 yo — elementary helpers. CHOP, AACAP and Cleveland UH/Rainbow all
// converge on "load/unload the dishwasher", "set + clear table",
// "vacuum or sweep", "help with simple meal prep", "pack own school lunch".
// CHOP recommends 10-20 min/day at this age.
// ----------------------------------------------------------------------------
const PRIMARY: CatalogChore[] = [
  {
    slug: 'unload-dishwasher',
    name: 'Unload the dishwasher',
    description: 'Put clean dishes back in their cupboards.',
    minAge: 7,
    maxAge: 17,
    difficulty: 'medium',
    category: 'kitchen',
    cadence: { kind: 'daily', times: ['07:30'] },
    source: 'CHOP — 7-8 yo dishwasher',
  },
  {
    slug: 'load-dishwasher',
    name: 'Load the dishwasher',
    description: 'Stack rinsed dishes into the dishwasher after dinner.',
    minAge: 7,
    maxAge: 17,
    difficulty: 'medium',
    category: 'kitchen',
    cadence: { kind: 'daily', times: ['19:30'] },
    source: 'CHOP — 7-8 yo dishwasher',
  },
  {
    slug: 'set-table',
    name: 'Set the table',
    description: 'Lay out plates, cutlery and water glasses for dinner.',
    minAge: 7,
    maxAge: 14,
    difficulty: 'easy',
    category: 'meals',
    cadence: { kind: 'daily', times: ['18:00'] },
    source: 'HealthyChildren — 7-8 yo set/clear table',
  },
  {
    slug: 'pack-own-lunch',
    name: 'Pack your school lunch',
    description: 'Make a sandwich, pack snacks and a water bottle for tomorrow.',
    minAge: 7,
    maxAge: 17,
    difficulty: 'medium',
    category: 'meals',
    cadence: { kind: 'weekly', days: [0, 1, 2, 3, 4], time: '19:30' },
    source: 'AAP / CHOP — 7-8 yo pack own lunch',
  },
  {
    slug: 'wipe-counters',
    name: 'Wipe the kitchen counters',
    description: 'Wipe down counters and the stovetop after dinner.',
    minAge: 7,
    maxAge: 17,
    difficulty: 'easy',
    category: 'kitchen',
    cadence: { kind: 'daily', times: ['19:30'] },
    source: 'CHOP — 7-8 yo wipe counters',
  },
  {
    slug: 'dust-furniture',
    name: 'Dust the living room',
    description: 'Wipe down shelves, side tables and TV unit with a duster.',
    minAge: 7,
    maxAge: 17,
    difficulty: 'easy',
    category: 'cleaning',
    cadence: { kind: 'weekly', days: [6], time: '10:00' },
    source: 'HealthyChildren — 7-8 yo dust furniture',
  },
  {
    slug: 'tidy-living-room',
    name: 'Tidy the living room',
    description: 'Plump cushions, fold blankets and clear shoes.',
    minAge: 7,
    maxAge: 17,
    difficulty: 'easy',
    category: 'cleaning',
    cadence: { kind: 'daily', times: ['17:00'] },
    source: 'HealthyChildren — 7-8 yo tidy shared spaces',
  },
  {
    slug: 'fill-pet-bowl',
    name: 'Fill the pet’s water bowl',
    description: 'Top up the pet’s water bowl morning and night.',
    minAge: 7,
    maxAge: 17,
    difficulty: 'easy',
    category: 'pets',
    cadence: { kind: 'daily', times: ['07:30', '18:00'] },
    source: 'HealthyChildren — 7-8 yo pet care',
  },
  {
    slug: 'rake-leaves',
    name: 'Rake leaves',
    description: 'Rake fallen leaves into a pile on the lawn.',
    minAge: 8,
    maxAge: 17,
    difficulty: 'medium',
    category: 'yard',
    cadence: { kind: 'every_n_weeks', n: 2, days: WEEKEND, time: '10:00' },
    source: 'HealthyChildren — 7-8 yo weed and rake',
  },
  {
    slug: 'wash-plastic-dishes',
    name: 'Wash plastic dishes by hand',
    description: 'Hand-wash water bottles, lunchboxes and plastic containers.',
    minAge: 8,
    maxAge: 14,
    difficulty: 'medium',
    category: 'kitchen',
    cadence: { kind: 'weekly', days: [0, 5], time: '17:00' },
    source: 'HealthyChildren — 7-8 yo wash plastic dishes',
  },
];

// ----------------------------------------------------------------------------
// 9-10 yo — motor-skills + responsibility. Pediatric OT consensus on
// "vacuum a designated area", "fold laundry", "take out the trash",
// "help prep dinner", "walk the pet", "make own snack". HealthyChildren
// agrees on these and adds "put away groceries".
// ----------------------------------------------------------------------------
const TWEEN: CatalogChore[] = [
  {
    slug: 'vacuum-room',
    name: 'Vacuum a room',
    description: 'Vacuum your bedroom or the living room.',
    minAge: 9,
    maxAge: 17,
    difficulty: 'medium',
    category: 'cleaning',
    cadence: { kind: 'weekly', days: WEEKEND, time: '10:00' },
    source: 'OT consensus / HealthyChildren — 8-10 yo vacuum',
  },
  {
    slug: 'fold-laundry',
    name: 'Fold a load of laundry',
    description: 'Fold and stack a basket of clean clothes.',
    minAge: 9,
    maxAge: 17,
    difficulty: 'medium',
    category: 'laundry',
    cadence: { kind: 'weekly', days: [3, 6], time: '16:00' },
    source: 'OT (Carolina Therapy Connection) — 8-10 yo fold laundry',
  },
  {
    slug: 'take-out-trash',
    name: 'Take out the kitchen bin',
    description: 'Tie the kitchen bin bag and put it in the outdoor bin.',
    minAge: 9,
    maxAge: 17,
    difficulty: 'easy',
    category: 'cleaning',
    cadence: { kind: 'daily', times: ['19:45'] },
    source: 'OT — 9-10 yo take out trash',
  },
  {
    slug: 'walk-the-dog',
    name: 'Walk the dog',
    description: 'Take the dog around the block on the lead.',
    minAge: 9,
    maxAge: 17,
    difficulty: 'medium',
    category: 'pets',
    cadence: { kind: 'daily', times: ['16:30'] },
    source: 'HealthyChildren — 9-10 yo dog walking',
  },
  {
    slug: 'put-away-groceries',
    name: 'Put away the groceries',
    description: 'Unpack shopping bags and put items in the pantry/fridge.',
    minAge: 9,
    maxAge: 17,
    difficulty: 'medium',
    category: 'kitchen',
    cadence: { kind: 'weekly', days: WEEKEND, time: '11:00' },
    source: 'HealthyChildren — 9-10 yo groceries',
  },
  {
    slug: 'help-make-dinner',
    name: 'Help cook dinner',
    description: 'Chop veg, stir a pot, and plate up alongside a parent.',
    minAge: 9,
    maxAge: 17,
    difficulty: 'medium',
    category: 'meals',
    cadence: { kind: 'weekly', days: [2, 4], time: '17:30' },
    source: 'HealthyChildren / OT — 9-10 yo simple meal prep',
  },
  {
    slug: 'sort-start-laundry',
    name: 'Sort and start a load of laundry',
    description: 'Sort by colour, load the washer and start the cycle.',
    minAge: 10,
    maxAge: 17,
    difficulty: 'medium',
    category: 'laundry',
    cadence: { kind: 'weekly', days: [1, 3, 5], time: '08:00' },
    source: 'CHOP — 7-8 yo with parent sorting; full job 10+',
  },
  {
    slug: 'put-away-own-laundry',
    name: 'Put your own laundry away',
    description: 'Put folded clothes into your drawers and wardrobe.',
    minAge: 9,
    maxAge: 17,
    difficulty: 'easy',
    category: 'laundry',
    cadence: { kind: 'weekly', days: [3, 6], time: '17:00' },
    source: 'HealthyChildren — 9-10 yo put own laundry away',
  },
];

// ----------------------------------------------------------------------------
// 11-12 yo — bigger ticket items. HealthyChildren is the canonical list:
// clean the kitchen, scrub the bathroom/toilet, vacuum, dust, change bed
// sheets, do and fold laundry end-to-end, cook a simple meal supervised,
// wash the car. MedicineNet's "12-year-old chores" article aligns.
// ----------------------------------------------------------------------------
const PRETEEN: CatalogChore[] = [
  {
    slug: 'clean-kitchen',
    name: 'Clean the kitchen',
    description: 'Counters, sink, stovetop and floor — full kitchen reset.',
    minAge: 11,
    maxAge: 17,
    difficulty: 'hard',
    category: 'kitchen',
    cadence: { kind: 'weekly', days: WEEKEND, time: '10:00' },
    source: 'HealthyChildren — 11-12 yo clean kitchen',
  },
  {
    slug: 'wash-dishes',
    name: 'Wash the dishes by hand',
    description: 'Hand-wash, rinse and dry a sink full of dishes.',
    minAge: 11,
    maxAge: 17,
    difficulty: 'medium',
    category: 'kitchen',
    cadence: { kind: 'weekly', days: [0, 3], time: '19:30' },
    source: 'HealthyChildren — 11-12 yo wash dishes',
  },
  {
    slug: 'clean-bathroom',
    name: 'Clean the bathroom',
    description: 'Wipe basin, mirror, scrub the bath and the floor.',
    minAge: 11,
    maxAge: 17,
    difficulty: 'hard',
    category: 'cleaning',
    cadence: { kind: 'weekly', days: WEEKEND, time: '10:00' },
    source: 'HealthyChildren — 11-12 yo clean bathroom',
  },
  {
    slug: 'scrub-toilet',
    name: 'Scrub the toilet',
    description: 'Brush the bowl and wipe the seat with bathroom spray.',
    minAge: 11,
    maxAge: 17,
    difficulty: 'medium',
    category: 'cleaning',
    cadence: { kind: 'weekly', days: WEEKEND, time: '10:30' },
    source: 'HealthyChildren — 11-12 yo scrub toilets',
  },
  {
    slug: 'vacuum-house',
    name: 'Vacuum the whole house',
    description: 'Vacuum every carpeted room and the rugs.',
    minAge: 11,
    maxAge: 17,
    difficulty: 'hard',
    category: 'cleaning',
    cadence: { kind: 'weekly', days: WEEKEND, time: '11:00' },
    source: 'HealthyChildren — 11-12 yo vacuum',
  },
  {
    slug: 'change-bed-sheets',
    name: 'Change your bed sheets',
    description: 'Strip the bed, put sheets in the wash, make it up fresh.',
    minAge: 11,
    maxAge: 17,
    difficulty: 'medium',
    category: 'laundry',
    cadence: { kind: 'weekly', days: [0], time: '10:00' },
    source: 'HealthyChildren — 11-12 yo change bedsheets',
  },
  {
    slug: 'wash-car',
    name: 'Wash the car',
    description: 'Hose, soap, sponge and rinse the family car.',
    minAge: 11,
    maxAge: 17,
    difficulty: 'hard',
    category: 'yard',
    cadence: { kind: 'every_n_weeks', n: 2, days: WEEKEND, time: '10:00' },
    source: 'HealthyChildren — 11-12 yo wash the car',
  },
  {
    slug: 'cook-simple-meal',
    name: 'Cook a simple meal',
    description: 'Cook pasta or stir-fry for the family with a parent nearby.',
    minAge: 11,
    maxAge: 17,
    difficulty: 'hard',
    category: 'meals',
    cadence: { kind: 'weekly', days: [2], time: '17:30' },
    source: 'HealthyChildren — 11-12 yo cook simple meal supervised',
  },
];

// ----------------------------------------------------------------------------
// 13+ yo teens. HealthyChildren "Household Chores for Adolescents" is
// explicit that teens can run any household task. We surface the ones with
// the most pay leverage: lawn mowing, full bathroom clean, end-to-end
// laundry, cooking dinner for the family, taking trash + recycling out,
// babysitting younger siblings (with an adult home).
// ----------------------------------------------------------------------------
const TEEN: CatalogChore[] = [
  {
    slug: 'mow-lawn',
    name: 'Mow the lawn',
    description: 'Mow the front and back lawn with the petrol or push mower.',
    minAge: 13,
    maxAge: 17,
    difficulty: 'hard',
    category: 'yard',
    cadence: { kind: 'every_n_weeks', n: 2, days: WEEKEND, time: '10:00' },
    source: 'HealthyChildren — adolescent yard work',
  },
  {
    slug: 'weed-garden',
    name: 'Weed the garden',
    description: 'Pull weeds from garden beds and edge the lawn.',
    minAge: 13,
    maxAge: 17,
    difficulty: 'medium',
    category: 'yard',
    cadence: { kind: 'every_n_weeks', n: 2, days: WEEKEND, time: '11:00' },
    source: 'HealthyChildren — adolescent yard work',
  },
  {
    slug: 'cook-family-dinner',
    name: 'Cook dinner for the family',
    description: 'Plan, cook and plate a full dinner for everyone.',
    minAge: 13,
    maxAge: 17,
    difficulty: 'hard',
    category: 'meals',
    cadence: { kind: 'weekly', days: [3], time: '17:30' },
    source: 'HealthyChildren — adolescents prepare meals',
  },
  {
    slug: 'manage-own-laundry',
    name: 'Run your own laundry',
    description: 'Wash, dry, fold and put away your own clothes for the week.',
    minAge: 13,
    maxAge: 17,
    difficulty: 'medium',
    category: 'laundry',
    cadence: { kind: 'weekly', days: [0], time: '10:00' },
    source: 'HealthyChildren — adolescents own laundry',
  },
  {
    slug: 'take-bins-to-curb',
    name: 'Take the bins to the curb',
    description: 'Wheel the rubbish and recycling bins out the night before pickup.',
    minAge: 13,
    maxAge: 17,
    difficulty: 'easy',
    category: 'cleaning',
    cadence: { kind: 'weekly', days: [2], time: '19:00' },
    source: 'HealthyChildren — adolescents trash + recycling',
  },
  {
    slug: 'babysit-sibling',
    name: 'Babysit a younger sibling',
    description: 'Mind a younger sibling while a parent is at home.',
    minAge: 13,
    maxAge: 17,
    difficulty: 'hard',
    category: 'family',
    cadence: { kind: 'weekly', days: [5], time: '18:00' },
    source: 'HealthyChildren — adolescents babysit with adult home',
  },
  {
    slug: 'clean-windows',
    name: 'Clean the windows',
    description: 'Spray and squeegee the inside of the ground-floor windows.',
    minAge: 13,
    maxAge: 17,
    difficulty: 'medium',
    category: 'cleaning',
    cadence: { kind: 'monthly_nth', nth: 1, weekday: 6, time: '10:00' },
    source: 'HealthyChildren — adolescents household tasks',
  },
];

// Single flat list — order is age-ascending so age-mixed selectors get a
// natural progression when they take the first N items.
export const CHORE_CATALOG: CatalogChore[] = [...ECE, ...PRIMARY, ...TWEEN, ...PRETEEN, ...TEEN];

// ----------------------------------------------------------------------------
// Selection helpers
// ----------------------------------------------------------------------------

/** Chores recommended for `age` (inclusive on both ends of each entry). */
export function choresForAge(age: number): CatalogChore[] {
  return CHORE_CATALOG.filter((c) => age >= c.minAge && age <= c.maxAge);
}

/**
 * Pick a balanced suggestion set for one or more children.
 *
 * Goals:
 *  - Every child gets at least `perChildMin` chores from their own age range,
 *    so a 5-year-old never sees "mow the lawn" as their starter pack.
 *  - Across the whole family the list is capped at `total` so the wizard
 *    doesn't drop a parent on a screen with 40 toggles.
 *  - For multi-child families we round-robin by age band so the result
 *    visually mixes "easy bedroom" jobs with "weekly bathroom" jobs.
 *  - Diversity: avoid two chores with the same `category` until each
 *    category has been represented once.
 *  - Stable: for the same input we return the same output (no Math.random).
 */
export function suggestForAges(
  ages: number[],
  opts: { total?: number; perChildMin?: number } = {},
): CatalogChore[] {
  const total = opts.total ?? 8;
  const perChildMin = opts.perChildMin ?? 3;
  if (ages.length === 0) return [];

  // Per-age priority list. Within an age band we rank by difficulty
  // (easy → medium → hard) then by minAge ascending — so a 9-year-old's
  // suggestions lean toward 9-yo-appropriate tasks rather than the 7-8 yo
  // tasks they've outgrown.
  const ranked = (age: number): CatalogChore[] => {
    const inBand = choresForAge(age);
    const distance = (c: CatalogChore) => {
      // Chores whose midpoint sits at this age get distance 0; chores
      // further out (e.g. minAge=5 for a 12-year-old) get bigger numbers.
      const mid = (c.minAge + c.maxAge) / 2;
      return Math.abs(mid - age);
    };
    return [...inBand].sort((a, b) => {
      const da = distance(a);
      const db = distance(b);
      if (da !== db) return da - db;
      const order: Record<ChoreDifficulty, number> = { easy: 0, medium: 1, hard: 2 };
      const oa = order[a.difficulty];
      const ob = order[b.difficulty];
      if (oa !== ob) return oa - ob;
      return a.minAge - b.minAge;
    });
  };

  const queues = ages.map(ranked);
  const seen = new Set<string>();
  const usedCategoryFirstPass = new Set<ChoreCategory>();
  const out: CatalogChore[] = [];

  // Phase 1 — round-robin first picks per child until each child has at
  // least `perChildMin` entries (or runs out). Prefer fresh categories so
  // the list feels diverse rather than "five kitchen chores".
  let madeProgress = true;
  const perChildPicked = ages.map(() => 0);
  while (madeProgress && out.length < total) {
    madeProgress = false;
    for (let i = 0; i < queues.length; i++) {
      if (perChildPicked[i]! >= perChildMin) continue;
      const q = queues[i]!;
      const next = q.find(
        (c) => !seen.has(c.slug) && !usedCategoryFirstPass.has(c.category),
      ) ?? q.find((c) => !seen.has(c.slug));
      if (!next) continue;
      seen.add(next.slug);
      usedCategoryFirstPass.add(next.category);
      out.push(next);
      perChildPicked[i]!++;
      madeProgress = true;
      if (out.length >= total) break;
    }
  }

  // Phase 2 — fill remaining slots from any child's queue, still
  // round-robin so a one-kid family doesn't out-rank a two-kid family's
  // older sibling.
  if (out.length < total) {
    let added = true;
    while (added && out.length < total) {
      added = false;
      for (let i = 0; i < queues.length; i++) {
        const q = queues[i]!;
        const next = q.find((c) => !seen.has(c.slug));
        if (!next) continue;
        seen.add(next.slug);
        out.push(next);
        added = true;
        if (out.length >= total) break;
      }
    }
  }

  return out;
}
