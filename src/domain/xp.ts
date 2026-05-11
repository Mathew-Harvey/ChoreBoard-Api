/**
 * XP curve from spec §7: Level 1: 0, 2: 500, 3: 1500, 4: 3500, 5: 7500,
 * then ×2 each. Returns 1-based level for total XP.
 */
const LEVELS = [0, 500, 1500, 3500, 7500];
function levelThreshold(level: number): number {
  if (level <= LEVELS.length) return LEVELS[level - 1]!;
  let prev = LEVELS[LEVELS.length - 1]!;
  for (let l = LEVELS.length + 1; l <= level; l++) {
    prev = prev * 2;
  }
  return prev;
}

export function levelForXp(xp: number): { level: number; intoLevel: number; nextAt: number } {
  let level = 1;
  while (xp >= levelThreshold(level + 1)) level++;
  const base = levelThreshold(level);
  const next = levelThreshold(level + 1);
  return { level, intoLevel: xp - base, nextAt: next - base };
}

export const LEVEL_NAMES = [
  'Apprentice',
  'Helper',
  'Champion',
  'Hero',
  'Legend',
  'Mythic',
  'Titan',
  'Ascended',
];
export function levelName(level: number): string {
  return LEVEL_NAMES[Math.min(level - 1, LEVEL_NAMES.length - 1)] ?? 'Apprentice';
}
