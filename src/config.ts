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
  // Comma-separated list of allowed CORS origins. Includes Capacitor's
  // schemes (capacitor://localhost, https://localhost) so the iOS / Android
  // shells can call api.choreboard.io.
  webOrigin: optional('WEB_ORIGIN', 'http://localhost:5173'),
  webDistDir: process.env.WEB_DIST_DIR,
  // Optional cookie domain. Set to ".choreboard.io" in prod so a session
  // issued on app.choreboard.io is sent on calls to api.choreboard.io.
  cookieDomain: process.env.COOKIE_DOMAIN ?? '',

  // App identifiers used by the .well-known deep-link files served from
  // app.choreboard.io. Both must be set in prod for Universal Links and
  // App Links to actually open the app instead of the browser.
  appleAppId: process.env.APPLE_APP_ID ?? '', // "TEAMID.io.choreboard.app"
  androidPackageName: process.env.ANDROID_PACKAGE_NAME ?? 'io.choreboard.app',
  androidCertSha256:
    process.env.ANDROID_CERT_SHA256 ?? '', // colon-separated hex from `keytool -list`

  // --- Push (filled in once VAPID / APNs / FCM keys exist) ---
  vapidPublicKey: process.env.VAPID_PUBLIC_KEY ?? '',
  vapidPrivateKey: process.env.VAPID_PRIVATE_KEY ?? '',
  vapidSubject: process.env.VAPID_SUBJECT ?? '',
  apnsTeamId: process.env.APNS_TEAM_ID ?? '',
  apnsKeyId: process.env.APNS_KEY_ID ?? '',
  apnsBundleId: process.env.APNS_BUNDLE_ID ?? 'io.choreboard.app',
  apnsKeyP8: process.env.APNS_KEY_P8 ?? '',
  apnsProduction: process.env.APNS_PRODUCTION === 'true',
  fcmServiceAccountJson: process.env.FCM_SERVICE_ACCOUNT_JSON ?? '',

  // --- Billing ---
  stripeSecretKey: process.env.STRIPE_SECRET_KEY ?? '',
  stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET ?? '',
  stripePriceFamily: process.env.STRIPE_PRICE_FAMILY ?? '',
  appleSharedSecret: process.env.APPLE_SHARED_SECRET ?? '',
  appleBundleId: process.env.APPLE_BUNDLE_ID ?? 'io.choreboard.app',
  appleNotificationsAudience:
    process.env.APPLE_NOTIFICATIONS_AUDIENCE === 'sandbox' ? 'sandbox' : 'production',
  googlePlayServiceAccountJson: process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON ?? '',
  googlePlayPackageName: process.env.GOOGLE_PLAY_PACKAGE_NAME ?? 'io.choreboard.app',

  // Public-facing app URL — used to build absolute links in emails / push
  // payloads and as the canonical "home" URL in App Store deep links.
  appUrl: process.env.APP_URL ?? 'https://app.choreboard.io',
};

export const isProd = config.nodeEnv === 'production';

export function isStripeConfigured(): boolean {
  return !!config.stripeSecretKey && !!config.stripeWebhookSecret && !!config.stripePriceFamily;
}

export function isAppleIapConfigured(): boolean {
  return !!config.appleSharedSecret;
}

export function isGooglePlayConfigured(): boolean {
  return !!config.googlePlayServiceAccountJson;
}

export function isWebPushConfigured(): boolean {
  return !!config.vapidPublicKey && !!config.vapidPrivateKey && !!config.vapidSubject;
}

export function isApnsConfigured(): boolean {
  return !!config.apnsTeamId && !!config.apnsKeyId && !!config.apnsKeyP8;
}

export function isFcmConfigured(): boolean {
  return !!config.fcmServiceAccountJson;
}
