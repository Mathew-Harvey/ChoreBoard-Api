/**
 * Cadence representations and "next renewal" math.
 *
 * Times are expressed in local clock terms ("HH:MM"); we translate to UTC
 * using the family's IANA timezone via Intl APIs. This keeps the surface
 * small enough that we don't pull in a date library.
 */

export type Cadence =
  | { kind: 'daily'; times: string[] } // each time of day spawns its own instance
  | { kind: 'weekly'; days: number[]; time: string } // days: 0=Sun … 6=Sat
  | { kind: 'every_n_days'; n: number; time: string }
  | { kind: 'every_n_weeks'; n: number; days: number[]; time: string }
  | { kind: 'monthly_dom'; day: number; time: string }
  | { kind: 'monthly_nth'; nth: number; weekday: number; time: string };

// ----------------------------------------------------------------------------
// Timezone helpers
// ----------------------------------------------------------------------------

/** Parts of a wall-clock moment in a given IANA timezone. */
type Parts = {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  weekday: number; // 0=Sun … 6=Sat
};

function partsInZone(d: Date, timezone: string): Parts {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    weekday: 'short',
  });
  const map: Record<string, string> = {};
  for (const p of fmt.formatToParts(d)) {
    if (p.type !== 'literal') map[p.type] = p.value;
  }
  const weekdayMap: Record<string, number> = {
    Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
  };
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: Number(map.hour === '24' ? '00' : map.hour),
    minute: Number(map.minute),
    weekday: weekdayMap[map.weekday!] ?? 0,
  };
}

/**
 * Build a UTC Date that, when viewed in `timezone`, reads as
 * (year, month, day, hour, minute). Two-pass search handles DST.
 */
export function zonedDateToUtc(
  year: number,
  month: number, // 1-12
  day: number,
  hour: number,
  minute: number,
  timezone: string,
): Date {
  // First guess: treat the components as UTC and then back-correct.
  let guess = new Date(Date.UTC(year, month - 1, day, hour, minute, 0));
  for (let i = 0; i < 3; i++) {
    const p = partsInZone(guess, timezone);
    const desiredTotal = year * 12 * 31 * 24 * 60 + (month - 1) * 31 * 24 * 60 + (day - 1) * 24 * 60 + hour * 60 + minute;
    const actualTotal = p.year * 12 * 31 * 24 * 60 + (p.month - 1) * 31 * 24 * 60 + (p.day - 1) * 24 * 60 + p.hour * 60 + p.minute;
    const deltaMin = desiredTotal - actualTotal;
    if (deltaMin === 0) return guess;
    guess = new Date(guess.getTime() + deltaMin * 60_000);
  }
  return guess;
}

function parseTime(hhmm: string): { h: number; m: number } {
  const [hStr, mStr] = hhmm.split(':');
  return { h: Number(hStr), m: Number(mStr) };
}

function addDaysZoned(parts: Parts, days: number, timezone: string): Parts {
  const utc = zonedDateToUtc(parts.year, parts.month, parts.day, 12, 0, timezone);
  const shifted = new Date(utc.getTime() + days * 24 * 60 * 60 * 1000);
  const p = partsInZone(shifted, timezone);
  return { ...p, hour: parts.hour, minute: parts.minute };
}

// ----------------------------------------------------------------------------
// Public: nextOccurrence
// ----------------------------------------------------------------------------

/**
 * Return all renewal datetimes (UTC) in (after, after + horizonDays] for this
 * cadence in the given timezone. Used to materialize upcoming instances.
 */
export function occurrencesBetween(
  cadence: Cadence,
  after: Date,
  horizonDays: number,
  timezone: string,
): Date[] {
  const out: Date[] = [];
  const horizonEnd = new Date(after.getTime() + horizonDays * 24 * 60 * 60 * 1000);

  // Walk day by day from `after`'s date in zone, generating candidate times.
  const startParts = partsInZone(after, timezone);
  let cursor: Parts = { ...startParts, hour: 0, minute: 0 };

  // Include cadences with a clear "day-of" rule. Walk up to horizonDays+1 days.
  for (let i = 0; i <= horizonDays + 1; i++) {
    const candidates = candidatesForDay(cadence, cursor, timezone);
    for (const c of candidates) {
      if (c.getTime() > after.getTime() && c.getTime() <= horizonEnd.getTime()) {
        out.push(c);
      }
    }
    cursor = addDaysZoned(cursor, 1, timezone);
  }

  return out.sort((a, b) => a.getTime() - b.getTime());
}

function candidatesForDay(cadence: Cadence, day: Parts, timezone: string): Date[] {
  switch (cadence.kind) {
    case 'daily': {
      return cadence.times.map((t) => {
        const { h, m } = parseTime(t);
        return zonedDateToUtc(day.year, day.month, day.day, h, m, timezone);
      });
    }
    case 'weekly': {
      if (!cadence.days.includes(day.weekday)) return [];
      const { h, m } = parseTime(cadence.time);
      return [zonedDateToUtc(day.year, day.month, day.day, h, m, timezone)];
    }
    case 'every_n_days': {
      // Anchor: epoch day in family TZ. Days where (epochDay % n === 0) fire.
      const epochDay = Math.floor(
        zonedDateToUtc(day.year, day.month, day.day, 12, 0, timezone).getTime() /
          (24 * 60 * 60 * 1000),
      );
      if (epochDay % cadence.n !== 0) return [];
      const { h, m } = parseTime(cadence.time);
      return [zonedDateToUtc(day.year, day.month, day.day, h, m, timezone)];
    }
    case 'every_n_weeks': {
      if (!cadence.days.includes(day.weekday)) return [];
      const epochDay = Math.floor(
        zonedDateToUtc(day.year, day.month, day.day, 12, 0, timezone).getTime() /
          (24 * 60 * 60 * 1000),
      );
      const epochWeek = Math.floor(epochDay / 7);
      if (epochWeek % cadence.n !== 0) return [];
      const { h, m } = parseTime(cadence.time);
      return [zonedDateToUtc(day.year, day.month, day.day, h, m, timezone)];
    }
    case 'monthly_dom': {
      if (day.day !== cadence.day) return [];
      const { h, m } = parseTime(cadence.time);
      return [zonedDateToUtc(day.year, day.month, day.day, h, m, timezone)];
    }
    case 'monthly_nth': {
      if (day.weekday !== cadence.weekday) return [];
      // Which occurrence of this weekday in the month is `day`?
      const ord = Math.floor((day.day - 1) / 7) + 1;
      if (ord !== cadence.nth) return [];
      const { h, m } = parseTime(cadence.time);
      return [zonedDateToUtc(day.year, day.month, day.day, h, m, timezone)];
    }
  }
}

// ----------------------------------------------------------------------------
// Payout (Sunday) helpers
// ----------------------------------------------------------------------------

/**
 * Return the first renewal at or after `after`, or `null` if no occurrence
 * falls within a generous look-ahead. Useful for stamping `due_at` on
 * a freshly-materialized instance.
 */
export function nextOccurrenceAfter(
  cadence: Cadence,
  after: Date,
  timezone: string,
  lookAheadDays = 35,
): Date | null {
  const out: Date[] = [];
  const horizonEnd = new Date(after.getTime() + lookAheadDays * 24 * 60 * 60 * 1000);
  const startParts = partsInZone(after, timezone);
  let cursor: Parts = { ...startParts, hour: 0, minute: 0 };
  for (let i = 0; i <= lookAheadDays + 1; i++) {
    for (const c of candidatesForDay(cadence, cursor, timezone)) {
      if (c.getTime() > after.getTime() && c.getTime() <= horizonEnd.getTime()) {
        out.push(c);
      }
    }
    cursor = addDaysZoned(cursor, 1, timezone);
  }
  out.sort((a, b) => a.getTime() - b.getTime());
  return out[0] ?? null;
}

/**
 * Most recent payout moment at or before `now`. The leaderboard "current
 * week" begins at the previous payout instant — so an earning made between
 * Sunday 7pm payout and Monday midnight counts toward the *new* week
 * (spec §3, §9).
 */
export function lastPayoutMoment(
  now: Date,
  timezone: string,
  payoutDay: number,
  payoutTime: string,
): Date {
  const { h, m } = parseTime(payoutTime);
  const p = partsInZone(now, timezone);
  let cursor: Parts = { ...p };
  for (let i = 0; i < 8; i++) {
    if (cursor.weekday === payoutDay) {
      const at = zonedDateToUtc(cursor.year, cursor.month, cursor.day, h, m, timezone);
      if (at.getTime() <= now.getTime()) return at;
    }
    cursor = addDaysZoned(cursor, -1, timezone);
  }
  // Fallback: 7 days ago.
  return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
}

export function nextWeekClose(
  after: Date,
  timezone: string,
  payoutDay: number, // 0=Sun … 6=Sat
  payoutTime: string,
): Date {
  const { h, m } = parseTime(payoutTime);
  const startParts = partsInZone(after, timezone);
  let cursor: Parts = { ...startParts };
  for (let i = 0; i < 8; i++) {
    if (cursor.weekday === payoutDay) {
      const at = zonedDateToUtc(cursor.year, cursor.month, cursor.day, h, m, timezone);
      if (at.getTime() > after.getTime()) return at;
    }
    cursor = addDaysZoned(cursor, 1, timezone);
  }
  // Fallback shouldn't happen
  return new Date(after.getTime() + 7 * 24 * 60 * 60 * 1000);
}

/** Start of the current week (in family TZ) given an instant. */
export function currentWeekStart(now: Date, timezone: string, payoutDay: number): Date {
  // Week starts the day *after* payout day, at 00:00 local.
  const weekStartDow = (payoutDay + 1) % 7;
  const p = partsInZone(now, timezone);
  let cursor: Parts = { ...p, hour: 0, minute: 0 };
  for (let i = 0; i < 8; i++) {
    if (cursor.weekday === weekStartDow) {
      return zonedDateToUtc(cursor.year, cursor.month, cursor.day, 0, 0, timezone);
    }
    cursor = addDaysZoned(cursor, -1, timezone);
  }
  return now;
}

export function localDayKey(d: Date, timezone: string): string {
  const p = partsInZone(d, timezone);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

export function startOfLocalDay(d: Date, timezone: string): Date {
  const p = partsInZone(d, timezone);
  return zonedDateToUtc(p.year, p.month, p.day, 0, 0, timezone);
}

/** Midnight on the 1st of `d`'s local month, in the given IANA timezone. */
export function startOfLocalMonth(d: Date, timezone: string): Date {
  const p = partsInZone(d, timezone);
  return zonedDateToUtc(p.year, p.month, 1, 0, 0, timezone);
}
