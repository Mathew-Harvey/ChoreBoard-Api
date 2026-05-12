import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';

/**
 * Apple Universal Links + Android App Links well-known files.
 *
 * Both must be served from the **app** hostname (app.choreboard.io), not
 * the marketing site. They are public — no auth — and must respond
 * `application/json` (Apple specifically rejects responses with the wrong
 * content type and refuses to deep-link the app).
 *
 * Both files are gated on env config: until the relevant team id / cert
 * fingerprint is available, the endpoint returns 404 so the OS knows there
 * is nothing to associate.
 */
export async function wellKnownRoutes(app: FastifyInstance): Promise<void> {
  // Apple Universal Links --------------------------------------------------
  //
  // Apple verifies AASA on app first launch and periodically thereafter.
  // The file MUST be served over HTTPS at exactly /.well-known/apple-app-site-association
  // with no redirect, content-type application/json, and no extension.
  //
  // `appID` format is "<TEAM_ID>.<bundle_id>", e.g. "ABCDE12345.io.choreboard.app".
  // We accept this whole value via the APPLE_APP_ID env var so the caller
  // doesn't have to think about formatting.
  app.get('/.well-known/apple-app-site-association', async (_req, reply) => {
    if (!config.appleAppId) return reply.code(404).send();
    reply.type('application/json');
    return {
      applinks: {
        apps: [],
        details: [
          {
            appID: config.appleAppId,
            // Match every path. Apple resolves the URL inside the app via
            // our `appUrlOpen` listener in the SPA.
            paths: ['*'],
          },
        ],
      },
      // The webcredentials key is what enables iOS Password AutoFill from
      // Keychain to flow into the native app's web view login. Costs
      // nothing to declare; helps a lot with returning users on a fresh
      // device.
      webcredentials: {
        apps: [config.appleAppId],
      },
    };
  });

  // Android App Links ------------------------------------------------------
  //
  // Android verifies assetlinks.json on app first launch. Multiple cert
  // fingerprints can be listed (e.g. debug + Play upload key) — comma
  // separate them in `ANDROID_CERT_SHA256`.
  app.get('/.well-known/assetlinks.json', async (_req, reply) => {
    if (!config.androidPackageName || !config.androidCertSha256) {
      return reply.code(404).send();
    }
    reply.type('application/json');
    const fingerprints = config.androidCertSha256
      .split(',')
      .map((f) => f.trim())
      .filter(Boolean);
    return [
      {
        relation: ['delegate_permission/common.handle_all_urls'],
        target: {
          namespace: 'android_app',
          package_name: config.androidPackageName,
          sha256_cert_fingerprints: fingerprints,
        },
      },
    ];
  });
}
