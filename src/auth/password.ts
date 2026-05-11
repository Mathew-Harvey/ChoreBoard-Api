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
