import { runAuthFlow } from "../../auth/oauth.js";
import { resolvePaths } from "../../config/paths.js";
import { VitalsError } from "../../types.js";

export interface AuthOptions {
  clientId?: string;
  clientSecret?: string;
}

const SETUP_HINT = [
  "vitals needs your own Google OAuth client, because the Health API grants",
  "access per application. One-time setup:",
  "",
  "  1. Create a project at https://console.cloud.google.com/",
  "  2. Enable the Health API for it",
  '  3. Create an OAuth 2.0 Client ID of type "Desktop app"',
  "  4. Re-run:",
  "       vitals auth --client-id <id> --client-secret <secret>",
  "",
  "Or set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in your environment.",
].join("\n");

/**
 * Connect vitals to a Google account.
 *
 * Credentials come from flags or the environment. There is no bundled client
 * id: an OAuth client embedded in a public repository would be shared by every
 * user of the tool and could be revoked for all of them at once.
 */
export async function runAuth(opts: AuthOptions): Promise<string> {
  const clientId = opts.clientId ?? process.env.GOOGLE_CLIENT_ID;
  const clientSecret = opts.clientSecret ?? process.env.GOOGLE_CLIENT_SECRET;

  if (!(clientId && clientSecret)) {
    throw new VitalsError("USAGE", "Missing Google OAuth client credentials.", {
      hint: SETUP_HINT,
    });
  }

  const paths = resolvePaths();
  const creds = await runAuthFlow(paths, clientId, clientSecret);

  return [
    `Connected. Credentials saved to ${paths.credentialsFile}`,
    `Granted ${creds.scopes.length} read-only scopes.`,
    "",
    "Next: vitals pull --since 30d",
  ].join("\n");
}
