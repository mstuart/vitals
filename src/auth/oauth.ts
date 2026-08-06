import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';

import { AUTH_ENDPOINT, SCOPES, TOKEN_ENDPOINT } from '../config/paths.js';
import type { Paths } from '../types.js';
import { VitalsError } from '../types.js';

/** Credentials vitals persists after a successful consent flow. */
export interface StoredCredentials {
  client_id: string;
  client_secret: string;
  refresh_token: string;
  scopes: string[];
  obtained_at: string;
}

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Open a URL in the platform browser. Best effort — the URL is printed too. */
function openBrowser(url: string): void {
  const cmd =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  try {
    spawn(cmd, [url], { stdio: 'ignore', detached: true }).unref();
  } catch {
    // Not being able to launch a browser is not fatal; the URL was printed.
  }
}

interface CallbackServer {
  port: number;
  code: Promise<string>;
  close(): void;
}

function page(message: string): string {
  return `<!doctype html><meta charset="utf-8"><title>vitals</title><body style="font-family:system-ui,sans-serif;padding:3rem;max-width:32rem"><h1>${message}</h1><p>You can close this tab and return to your terminal.</p>`;
}

/**
 * Bind a loopback listener for the OAuth redirect and return its port up front,
 * so the redirect URI can be built before the browser is opened.
 */
async function startCallbackServer(expectedState: string): Promise<CallbackServer> {
  let settle: { resolve(code: string): void; reject(err: unknown): void };
  const code = new Promise<string>((resolve, reject) => {
    settle = { resolve, reject };
  });

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname !== '/callback') {
      res.writeHead(404).end();
      return;
    }

    const reply = (status: number, message: string): void => {
      res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(page(message));
    };

    const error = url.searchParams.get('error');
    const returned = url.searchParams.get('code');
    const state = url.searchParams.get('state');

    if (error) {
      reply(400, `Authorization failed: ${error}`);
      settle.reject(new VitalsError('AUTH_MISSING', `Authorization was denied: ${error}`));
      return;
    }
    // Rejects a forged request aimed at the loopback listener.
    if (state !== expectedState) {
      reply(400, 'Authorization failed: state mismatch');
      settle.reject(new VitalsError('AUTH_MISSING', 'OAuth state mismatch; aborting.'));
      return;
    }
    if (!returned) {
      reply(400, 'Authorization failed: no code returned');
      settle.reject(new VitalsError('AUTH_MISSING', 'No authorization code in the callback.'));
      return;
    }

    reply(200, 'vitals is now connected');
    settle.resolve(returned);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', (cause) =>
      reject(
        new VitalsError('AUTH_MISSING', 'Could not start the local callback server.', { cause }),
      ),
    );
    server.listen(0, '127.0.0.1', resolve);
  });

  return {
    port: (server.address() as AddressInfo).port,
    code,
    close: () => server.close(),
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
  opts?: { fetchImpl?: typeof fetch; log?: (msg: string) => void; openUrl?: (url: string) => void },
): Promise<StoredCredentials> {
  const fetchImpl = opts?.fetchImpl ?? fetch;
  const log = opts?.log ?? ((m: string) => process.stderr.write(`${m}\n`));
  const open = opts?.openUrl ?? openBrowser;

  const state = base64url(randomBytes(24));
  const verifier = base64url(randomBytes(48));
  const challenge = base64url(createHash('sha256').update(verifier).digest());

  const server = await startCallbackServer(state);
  const redirectUri = `http://127.0.0.1:${server.port}/callback`;

  const authUrl = new URL(AUTH_ENDPOINT);
  for (const [k, v] of Object.entries({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  })) {
    authUrl.searchParams.set(k, v);
  }

  try {
    log('Opening your browser to authorize vitals.');
    log(`If it does not open, visit:\n\n  ${authUrl.toString()}\n`);
    open(authUrl.toString());

    const code = await server.code;

    const response = await fetchImpl(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
        code_verifier: verifier,
      }).toString(),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new VitalsError(
        'AUTH_REFRESH_FAILED',
        `Code exchange failed with HTTP ${response.status}: ${body}`,
      );
    }

    const parsed = (await response.json()) as { refresh_token?: string };
    if (typeof parsed.refresh_token !== 'string') {
      throw new VitalsError('AUTH_REFRESH_FAILED', 'Google did not return a refresh token.', {
        hint: 'Revoke vitals at https://myaccount.google.com/permissions, then run `vitals auth` again.',
      });
    }

    const creds: StoredCredentials = {
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: parsed.refresh_token,
      scopes: SCOPES,
      obtained_at: new Date().toISOString(),
    };

    await mkdir(dirname(paths.credentialsFile), { recursive: true });
    await writeFile(paths.credentialsFile, JSON.stringify(creds, null, 2), { mode: 0o600 });
    return creds;
  } finally {
    server.close();
  }
}
