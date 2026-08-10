import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname } from "node:path";

import { AUTH_ENDPOINT, SCOPES, TOKEN_ENDPOINT } from "../config/paths.js";
import type { Paths } from "../types.js";
import { VitalsError } from "../types.js";

const BASE64_PLUS_RE = /\+/g;
const BASE64_SLASH_RE = /\//g;
const BASE64_PADDING_RE = /[=]+$/;

/** Credentials vitals persists after a successful consent flow. */
export interface StoredCredentials {
  client_id: string;
  client_secret: string;
  obtained_at: string;
  refresh_token: string;
  scopes: string[];
}

function base64url(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(BASE64_PLUS_RE, "-")
    .replace(BASE64_SLASH_RE, "_")
    .replace(BASE64_PADDING_RE, "");
}

/** Open a URL in the platform browser. Best effort — the URL is printed too. */
function openBrowser(url: string): void {
  let cmd = "xdg-open";
  if (process.platform === "darwin") {
    cmd = "open";
  } else if (process.platform === "win32") {
    cmd = "start";
  }
  try {
    spawn(cmd, [url], { detached: true, stdio: "ignore" }).unref();
  } catch {
    // Not being able to launch a browser is not fatal; the URL was printed.
  }
}

interface CallbackServer {
  close: () => void;
  code: Promise<string>;
  port: number;
}

function page(message: string): string {
  return `<!doctype html><meta charset="utf-8"><title>vitals</title><body style="font-family:system-ui,sans-serif;padding:3rem;max-width:32rem"><h1>${message}</h1><p>You can close this tab and return to your terminal.</p>`;
}

/**
 * Bind a loopback listener for the OAuth redirect and return its port up front,
 * so the redirect URI can be built before the browser is opened.
 */
async function startCallbackServer(
  expectedState: string
): Promise<CallbackServer> {
  let settle: {
    reject: (err: unknown) => void;
    resolve: (code: string) => void;
  };
  const code = new Promise<string>((resolve, reject) => {
    settle = { reject, resolve };
  });

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/callback") {
      res.writeHead(404).end();
      return;
    }

    const reply = (status: number, message: string): void => {
      res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
      res.end(page(message));
    };

    const error = url.searchParams.get("error");
    const returned = url.searchParams.get("code");
    const state = url.searchParams.get("state");

    if (error) {
      reply(400, `Authorization failed: ${error}`);
      settle.reject(
        new VitalsError("AUTH_MISSING", `Authorization was denied: ${error}`)
      );
      return;
    }
    // Rejects a forged request aimed at the loopback listener.
    if (state !== expectedState) {
      reply(400, "Authorization failed: state mismatch");
      settle.reject(
        new VitalsError("AUTH_MISSING", "OAuth state mismatch; aborting.")
      );
      return;
    }
    if (!returned) {
      reply(400, "Authorization failed: no code returned");
      settle.reject(
        new VitalsError(
          "AUTH_MISSING",
          "No authorization code in the callback."
        )
      );
      return;
    }

    reply(200, "vitals is now connected");
    settle.resolve(returned);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", (cause) =>
      reject(
        new VitalsError(
          "AUTH_MISSING",
          "Could not start the local callback server.",
          { cause }
        )
      )
    );
    server.listen(0, "127.0.0.1", resolve);
  });

  return {
    close: () => server.close(),
    code,
    port: (server.address() as AddressInfo).port,
  };
}

/**
 * Run the installed-application OAuth flow and persist the resulting refresh
 * token to `paths.credentialsFile` (mode 0600).
 *
 * Requests `access_type=offline` with `prompt=consent`: Google returns a
 * refresh token only on first consent otherwise, so re-authorising an already
 * approved client would silently yield none and leave vitals unable to sync.
 */
export async function runAuthFlow(
  paths: Paths,
  clientId: string,
  clientSecret: string,
  opts?: {
    fetchImpl?: typeof fetch;
    log?: (msg: string) => void;
    openUrl?: (url: string) => void;
  }
): Promise<StoredCredentials> {
  const fetchImpl = opts?.fetchImpl ?? fetch;
  const log = opts?.log ?? ((m: string) => process.stderr.write(`${m}\n`));
  const open = opts?.openUrl ?? openBrowser;

  const state = base64url(randomBytes(24));
  const verifier = base64url(randomBytes(48));
  const challenge = base64url(createHash("sha256").update(verifier).digest());

  const server = await startCallbackServer(state);
  const redirectUri = `http://127.0.0.1:${server.port}/callback`;

  const authUrl = new URL(AUTH_ENDPOINT);
  for (const [k, v] of Object.entries({
    access_type: "offline",
    client_id: clientId,
    code_challenge: challenge,
    code_challenge_method: "S256",
    prompt: "consent",
    redirect_uri: redirectUri,
    response_type: "code",
    scope: SCOPES.join(" "),
    state,
  })) {
    authUrl.searchParams.set(k, v);
  }

  try {
    log("Opening your browser to authorize vitals.");
    log(`If it does not open, visit:\n\n  ${authUrl.toString()}\n`);
    open(authUrl.toString());

    const code = await server.code;

    const response = await fetchImpl(TOKEN_ENDPOINT, {
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        code_verifier: verifier,
        grant_type: "authorization_code",
        redirect_uri: redirectUri,
      }).toString(),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      method: "POST",
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new VitalsError(
        "AUTH_REFRESH_FAILED",
        `Code exchange failed with HTTP ${response.status}: ${body}`
      );
    }

    const parsed = (await response.json()) as { refresh_token?: string };
    if (typeof parsed.refresh_token !== "string") {
      throw new VitalsError(
        "AUTH_REFRESH_FAILED",
        "Google did not return a refresh token.",
        {
          hint: "Revoke vitals at https://myaccount.google.com/permissions, then run `vitals auth` again.",
        }
      );
    }

    const creds: StoredCredentials = {
      client_id: clientId,
      client_secret: clientSecret,
      obtained_at: new Date().toISOString(),
      refresh_token: parsed.refresh_token,
      scopes: SCOPES,
    };

    await mkdir(dirname(paths.credentialsFile), { recursive: true });
    await writeFile(paths.credentialsFile, JSON.stringify(creds, null, 2), {
      mode: 0o600,
    });
    return creds;
  } finally {
    server.close();
  }
}
