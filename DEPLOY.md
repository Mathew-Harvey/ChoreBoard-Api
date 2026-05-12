# ChoreBoard production deployment checklist

Single source of truth for taking ChoreBoard from "compiles locally" to
"running at choreboard.io with iOS / Android apps in the stores."

---

## 1. Cloudflare DNS records

Add **Cloudflare** as the nameserver for `choreboard.io` (registrar
nameserver swap), then add these records in the Cloudflare DNS panel.

| Type    | Name      | Target                                 | Proxy   | Notes                                                                 |
|---------|-----------|----------------------------------------|---------|-----------------------------------------------------------------------|
| `CNAME` | `@`       | `choreboard-landing.pages.dev`         | Proxied | Marketing site on Cloudflare Pages. Use the actual `*.pages.dev` URL Cloudflare gives you when you create the Pages project. |
| `CNAME` | `www`     | `choreboard.io`                        | Proxied | Polite redirect target.                                               |
| `CNAME` | `app`     | `choreboard-api.onrender.com`          | DNS only| The SPA. Same Render service as `api.`; Render binds both hostnames. |
| `CNAME` | `api`     | `choreboard-api.onrender.com`          | DNS only| Same Render service. JSON API + SSE + .well-known.                   |
| `CNAME` | `assets`  | `<your-r2-bucket-id>.r2.cloudflarestorage.com` | Proxied | Optional. Lets us serve chore photos from `assets.choreboard.io` instead of the raw R2 URL. |

Notes on the Proxy / DNS-only column:

- **Proxied (orange cloud)** for the marketing site: Cloudflare's CDN is
  free and fast, and the site is fully static.
- **DNS-only (grey cloud)** for `app.` and `api.`: Render handles its own
  TLS via Let's Encrypt, and proxying through Cloudflare on top adds a
  layer of complexity (custom origin certs, header rewriting, SSE
  buffering quirks). Keep it simple for v1; flip to proxied later if you
  want WAF or DDoS protection.

Then in Cloudflare → SSL/TLS → set encryption mode to **Full (strict)**
and turn on **Always Use HTTPS**. Submit `choreboard.io` to the
[HSTS preload list](https://hstspreload.org/) once HTTPS is verified.

---

## 2. Render configuration

The ChoreBoard-Api repo deploys as a **single Render web service** that
serves both `api.choreboard.io` and `app.choreboard.io`. Save yourself
two services' worth of plan cost.

### Render service settings

- **Build command:**
  ```
  cd ../ChoreBoard-Web && npm ci && npm run build && \
  cd ../ChoreBoard-Api && npm ci && npm run build && npm run db:migrate
  ```
  (or split the web/API builds across two CI steps if you want a
  monorepo-flavoured setup; Render also supports cross-service builds.)
- **Start command:** `npm start`
- **Health check:** `/health` (returns `{ ok: true, time: ... }`)

### Custom domains

Add both `app.choreboard.io` and `api.choreboard.io` as custom domains on
the same Render service. Render will issue separate TLS certs for each.

### Environment variables

Beyond the obvious `DATABASE_URL` from Render Postgres, set these:

```bash
NODE_ENV=production
SESSION_SECRET=<generate: openssl rand -hex 32>
WEB_DIST_DIR=../ChoreBoard-Web/dist
WEB_ORIGIN=https://app.choreboard.io,https://choreboard.io,capacitor://localhost,https://localhost
COOKIE_DOMAIN=.choreboard.io

# Universal Links / App Links — fill in once you have them
APPLE_APP_ID=ABCDE12345.io.choreboard.app
ANDROID_PACKAGE_NAME=io.choreboard.app
ANDROID_CERT_SHA256=AB:CD:EF:...   # comma-separated for multiple keys

# Push (turn on once VAPID / APNs / FCM are set up)
# VAPID_PUBLIC_KEY=
# VAPID_PRIVATE_KEY=
# VAPID_SUBJECT=mailto:support@choreboard.io
# APNS_TEAM_ID=
# APNS_KEY_ID=
# APNS_KEY_P8=
# APNS_PRODUCTION=true
# FCM_SERVICE_ACCOUNT_JSON='{...full JSON...}'

# Billing (turn on once accounts are created)
# STRIPE_SECRET_KEY=sk_live_...
# STRIPE_WEBHOOK_SECRET=whsec_...
# STRIPE_PRICE_FAMILY=price_...
# APPLE_SHARED_SECRET=...
# GOOGLE_PLAY_SERVICE_ACCOUNT_JSON='{...full JSON...}'

APP_URL=https://app.choreboard.io
```

---

## 3. Cloudflare Pages (marketing site)

`ChoreBoard-Landing` is a static site (just `index.html`, `terms.html`,
`privacy.html`). Wire it to Cloudflare Pages:

1. Cloudflare dashboard → Pages → Create a project → Connect to Git.
2. Pick the `ChoreBoard-Landing` repo.
3. Build command: *(none — this site has no build step.)*
4. Output directory: `/`.
5. Custom domain: `choreboard.io` and `www.choreboard.io`.

---

## 4. Apple App Store prep

1. Apple Developer Program enrollment (~AUD $149/yr).
2. App Store Connect → Apps → New App.
   - **Bundle ID:** `io.choreboard.app`
   - **Primary language:** English (Australia)
   - **Category:** Productivity (NOT Kids — see `spec.md` §16.3)
3. Capabilities to enable in Xcode for the iOS shell:
   - Push Notifications
   - Associated Domains: `applinks:app.choreboard.io` and
     `webcredentials:app.choreboard.io`
   - In-App Purchase
4. Create the IAP product in App Store Connect:
   - **Product ID:** `family_monthly`
   - **Type:** Auto-renewable subscription
   - **Price tier:** match the Stripe `price_monthly` headline
5. Create an APNs auth key (`.p8` file) under Certificates, Identifiers
   & Profiles → Keys. Save its Key ID and your Team ID; both go into
   the Render env (`APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_KEY_P8`).
6. App Privacy nutrition labels — see `spec.md` §16.3.
7. Set up an App Store Connect reviewer test account:
   - `reviewer+ios@choreboard.io` / strong-password
   - One pre-seeded family with one kid (note the PIN in App Review notes)
8. After first build to TestFlight: enable Universal Links on the
   reviewer's device and verify
   `https://app.choreboard.io/admin/family` opens the app.

---

## 5. Google Play Store prep

1. Play Console developer account (~USD $25 once).
2. Create the app:
   - **Package name:** `io.choreboard.app`
   - **Default language:** English (Australia)
   - **Category:** Productivity
3. Get your Play upload key SHA-256:
   ```bash
   keytool -list -v -keystore ~/.android/upload.keystore -alias upload \
     | grep "SHA256:"
   ```
   Add this value to Render env as `ANDROID_CERT_SHA256`.
4. Set up Firebase project for FCM:
   - Add an Android app, download `google-services.json` into
     `ChoreBoard-Web/android/app/` (don't commit — it's gitignored).
   - Generate a service-account JSON for the Cloud Messaging API.
     Paste the *single-line* JSON into `FCM_SERVICE_ACCOUNT_JSON`.
5. Create the IAP product:
   - **Product ID:** `family_monthly`
   - **Type:** Auto-renewing subscription
   - Configure base plan + offer at the same headline price as Stripe.
6. Set up Real-Time Developer Notifications:
   - In Play Console → Monetization → Subscription → Settings, set the
     RTDN topic to a Pub/Sub topic in your GCP project.
   - Create a push subscription on that topic delivering to
     `https://api.choreboard.io/api/billing/iap/webhook/google`.
7. Data safety form — same content as Apple's nutrition labels.
8. Closed Testing — recruit 12 testers, run for 14 days before
   promoting to Production (mandatory for new personal-developer-account
   apps).

---

## 6. Generate the native shells (one-time)

These two commands need the right local tooling and produce the
`ios/` and `android/` folders that get committed to `ChoreBoard-Web`.

```bash
# On macOS with Xcode 15+ + CocoaPods installed
cd ChoreBoard-Web
npm run build
npx cap add ios
npx cap sync ios

# On any OS with JDK 17+ and Android Studio
cd ChoreBoard-Web
npm run build
npx cap add android
npx cap sync android
```

Commit both folders (Capacitor convention; `.gitignore` already excludes
the build output, only the source folders are tracked).

---

## 7. CI release pipeline (recommended)

Two workflows, kept separate:

- **API + Web** — on push to `main`: typecheck, build, push to Render
  (Render auto-deploys on git push if you wire it that way).
- **Native release** — on git tag `v*.*.*`:
  - macOS runner: `cap sync ios && fastlane ios beta`
  - Ubuntu runner: `cap sync android && ./gradlew bundleRelease` and
    `fastlane android beta`

Both can use [Codemagic](https://codemagic.io/) or GitHub Actions
self-hosted runners. The macOS minutes are the expensive part — budget
~AUD $50/month for build infra.

---

## 8. The order to actually ship

1. ✅ Buy `choreboard.io`. (Done.)
2. Push these repos to GitHub.
3. Render: create the `choreboard-api` service, point at the API repo,
   add Postgres, set the env vars above. Confirm `/health` works.
4. Cloudflare: add DNS records as in §1.
5. Apple Developer enrollment + Play Console setup (both have multi-day
   verification windows — start them now, in parallel).
6. Cloudflare Pages: deploy `ChoreBoard-Landing`.
7. On a Mac: generate `ios/`, run on a real device, fix the inevitable
   safe-area issues, push to TestFlight.
8. Anywhere: generate `android/`, run on an Android device or emulator,
   push to Play Internal Testing.
9. Wire push (APNs + FCM keys → Render env).
10. Wire billing (Stripe + Apple IAP product + Google IAP product → Render env).
11. Submit to App Store Review and promote Play Closed → Production.

Total realistic timeline if working part-time: 3–6 weeks from "Render
service running" to "live in both stores."
