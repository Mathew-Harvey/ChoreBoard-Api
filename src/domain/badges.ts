/**
 * Seed badge catalog. Rule evaluation is intentionally simple — most badges
 * are awarded by checking counters at approval time.
 */
export type BadgeRule =
  | { kind: 'first_chore' }
  | { kind: 'lifetime_chores'; n: number }
  | { kind: 'lifetime_cents'; n: number }
  | { kind: 'approved_before'; hour: number } // approved hour < this
  | { kind: 'approved_after'; hour: number } // approved hour >= this
  | { kind: 'speed'; seconds: number };

export type SeedBadge = {
  code: string;
  name: string;
  description: string;
  icon: string;
  rule: BadgeRule;
};

export const SEED_BADGES: SeedBadge[] = [
  { code: 'first_steps', name: 'First Steps', description: 'First chore ever.', icon: '🐣', rule: { kind: 'first_chore' } },
  { code: 'bronze_helper', name: 'Bronze Helper', description: '10 lifetime chores.', icon: '🥉', rule: { kind: 'lifetime_chores', n: 10 } },
  { code: 'silver_helper', name: 'Silver Helper', description: '50 lifetime chores.', icon: '🥈', rule: { kind: 'lifetime_chores', n: 50 } },
  { code: 'gold_helper', name: 'Gold Helper', description: '200 lifetime chores.', icon: '🥇', rule: { kind: 'lifetime_chores', n: 200 } },
  { code: 'platinum_helper', name: 'Platinum Helper', description: '500 lifetime chores.', icon: '🏅', rule: { kind: 'lifetime_chores', n: 500 } },
  { code: 'diamond_helper', name: 'Diamond Helper', description: '1000 lifetime chores.', icon: '💎', rule: { kind: 'lifetime_chores', n: 1000 } },
  { code: 'centurion', name: 'Centurion', description: '$100 lifetime earned.', icon: '💰', rule: { kind: 'lifetime_cents', n: 10_000 } },
  { code: 'millionaire', name: 'Millionaire', description: '$1000 lifetime earned.', icon: '🤑', rule: { kind: 'lifetime_cents', n: 100_000 } },
  { code: 'early_bird', name: 'Early Bird', description: 'Chore approved before 8am.', icon: '🌅', rule: { kind: 'approved_before', hour: 8 } },
  { code: 'night_owl', name: 'Night Owl', description: 'Chore approved after 9pm.', icon: '🌙', rule: { kind: 'approved_after', hour: 21 } },
  { code: 'speed_demon', name: 'Speed Demon', description: 'Claim-to-complete under 5 minutes.', icon: '⚡️', rule: { kind: 'speed', seconds: 300 } },
];
