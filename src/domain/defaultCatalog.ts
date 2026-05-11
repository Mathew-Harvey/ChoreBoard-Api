import type { Cadence } from './cadence.js';

export type SeedChore = {
  name: string;
  description?: string;
  amountCents: number;
  cadence: Cadence;
};

/**
 * Seeded catalog from spec §5. Some "per kid" / "per bed" cases collapse to
 * one chore at the family level here; Parents can split them later in the
 * catalog editor.
 */
export const DEFAULT_CATALOG: SeedChore[] = [
  { name: 'Pack the dishwasher', amountCents: 100, cadence: { kind: 'daily', times: ['12:00'] } },
  { name: 'Empty the dishwasher', amountCents: 100, cadence: { kind: 'daily', times: ['07:00'] } },
  { name: 'Vacuum high-traffic areas', amountCents: 200, cadence: { kind: 'daily', times: ['14:00'] } },
  { name: 'Tidy the living room', amountCents: 150, cadence: { kind: 'daily', times: ['17:00'] } },
  { name: 'Wipe kitchen benches', amountCents: 100, cadence: { kind: 'daily', times: ['19:30'] } },
  { name: 'Take out kitchen bin', amountCents: 50, cadence: { kind: 'daily', times: ['19:00'] } },
  { name: 'Feed pets', amountCents: 50, cadence: { kind: 'daily', times: ['07:00', '17:00'] } },
  { name: 'Make your bed', amountCents: 50, cadence: { kind: 'daily', times: ['09:00'] } },
  {
    name: 'Sort & start a load of laundry',
    amountCents: 200,
    cadence: { kind: 'weekly', days: [1, 3, 5], time: '08:00' },
  },
  {
    name: 'Hang or fold a load',
    amountCents: 200,
    cadence: { kind: 'weekly', days: [1, 3, 5], time: '16:00' },
  },
  {
    name: 'Mop kitchen + bathroom',
    amountCents: 300,
    cadence: { kind: 'weekly', days: [2, 6], time: '09:00' },
  },
  { name: 'Vacuum the whole house', amountCents: 700, cadence: { kind: 'weekly', days: [6], time: '09:00' } },
  { name: 'Mop the whole house', amountCents: 500, cadence: { kind: 'weekly', days: [6], time: '11:00' } },
  {
    name: 'Clean bathrooms (toilet/shower/basin)',
    amountCents: 800,
    cadence: { kind: 'weekly', days: [6], time: '09:00' },
  },
  { name: 'Change bed sheets', amountCents: 300, cadence: { kind: 'weekly', days: [0], time: '10:00' } },
  { name: 'Bins out to curb', amountCents: 100, cadence: { kind: 'weekly', days: [2], time: '18:00' } },
  {
    name: 'Wipe down skirting boards',
    amountCents: 500,
    cadence: { kind: 'every_n_weeks', n: 2, days: [6], time: '10:00' },
  },
  {
    name: 'Vacuum couches',
    amountCents: 300,
    cadence: { kind: 'every_n_weeks', n: 2, days: [6], time: '10:00' },
  },
  {
    name: 'Wash the car',
    amountCents: 1000,
    cadence: { kind: 'every_n_weeks', n: 2, days: [0], time: '09:00' },
  },
  {
    name: 'Clean inside the fridge',
    amountCents: 800,
    cadence: { kind: 'monthly_nth', nth: 1, weekday: 6, time: '10:00' },
  },
  {
    name: 'Clean inside the oven',
    amountCents: 1000,
    cadence: { kind: 'monthly_nth', nth: 1, weekday: 6, time: '10:00' },
  },
  {
    name: 'Clean ceiling fans / light fittings',
    amountCents: 500,
    cadence: { kind: 'monthly_nth', nth: 1, weekday: 6, time: '10:00' },
  },
  {
    name: 'Tidy the garage',
    amountCents: 1000,
    cadence: { kind: 'monthly_nth', nth: 1, weekday: 0, time: '10:00' },
  },
  {
    name: 'Wash exterior windows',
    amountCents: 800,
    cadence: { kind: 'monthly_nth', nth: 1, weekday: 0, time: '10:00' },
  },
];
