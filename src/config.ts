import 'dotenv/config';

function required(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`Missing required env var: ${key}`);
  return v;
}

function optional(key: string, fallback: string): string {
  return process.env[key] ?? fallback;
}

export const config = {
  nodeEnv: optional('NODE_ENV', 'development'),
  port: Number(optional('PORT', '4000')),
  host: optional('HOST', '0.0.0.0'),
  databaseUrl: required('DATABASE_URL'),
  sessionSecret: optional('SESSION_SECRET', 'dev-secret-change-me'),
  sessionCookieName: optional('SESSION_COOKIE_NAME', 'cb_session'),
  sessionTtlDays: Number(optional('SESSION_TTL_DAYS', '30')),
  webOrigin: optional('WEB_ORIGIN', 'http://localhost:5173'),
  webDistDir: process.env.WEB_DIST_DIR,
};

export const isProd = config.nodeEnv === 'production';
