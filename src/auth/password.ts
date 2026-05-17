import argon2 from 'argon2';

const opts: argon2.Options = {
  type: argon2.argon2id,
  memoryCost: 19_456, // 19 MB
  timeCost: 2,
  parallelism: 1,
};

export function hashPassword(plain: string): Promise<string> {
  return argon2.hash(plain, opts);
}

export function verifyPassword(hash: string, plain: string): Promise<boolean> {
  return argon2.verify(hash, plain);
}

export function hashPin(pin: string): Promise<string> {
  if (!/^\d{4}$/.test(pin)) throw new Error('PIN must be 4 digits');
  return argon2.hash(pin, opts);
}

export function verifyPin(hash: string, pin: string): Promise<boolean> {
  return argon2.verify(hash, pin);
}

// Pairing codes are 6 digits. Same argon2id parameters — argon2's deliberate
// slowness is what bounds brute-force on the 1M-code keyspace; we additionally
// only ever scan the (small) set of active pairings system-wide on consume.
export function hashPairingCode(code: string): Promise<string> {
  if (!/^\d{6}$/.test(code)) throw new Error('Pairing code must be 6 digits');
  return argon2.hash(code, opts);
}

export function verifyPairingCode(hash: string, code: string): Promise<boolean> {
  return argon2.verify(hash, code);
}
