import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { TOKEN_ENDPOINT } from "../config/paths.js";
import type { AccessToken, Paths } from "../types.js";
import { VitalsError } from "../types.js";

/**
 * OAuth credentials holding a long-lived refresh token.
 *
 * Normally written by `vitals auth` to `paths.credentialsFile`. If
 * `VITALS_GOOGLE_TOKEN` points at another tool's credential file, that file is
 * used instead and is only ever READ — the owning tool may refresh the same
 * credential concurrently, and a competing write could corrupt it. Minted
 * access tokens go to `paths.tokenCacheFile` regardless.
 */
interface SourceCredentials {
  client_id: string;
  client_secret: string;
  expiry?: string;
  refresh_token: string;
  scopes?: string[];
  token?: string;
}

interface TokenRefreshResponse {
  access_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
}

const EXPIRY_SKEW_MS = 60_000;

function isSourceCredentials(v: unknown): v is SourceCredentials {
  if (typeof v !== "object" || v === null) {
    return false;
  }
  const o = v as Record<string, unknown>;
  return (
    typeof o.client_id === "string" &&
    typeof o.client_secret === "string" &&
    typeof o.refresh_token === "string"
  );
}

const RUN_AUTH = "Run `vitals auth` to connect your Google account.";

/** Parse a credential file, or return null if it is absent or unusable. */
async function tryReadCredentials(
  file: string
): Promise<SourceCredentials | "absent" | "invalid"> {
  let raw: string;
  try {
    raw = await readFile(file, "utf-8");
  } catch {
    return "absent";
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return isSourceCredentials(parsed) ? parsed : "invalid";
  } catch {
    return "invalid";
  }
}

/**
 * Load credentials, preferring vitals' own file and falling back to an
 * external one named by `VITALS_GOOGLE_TOKEN`.
 *
 * An explicitly configured external file that is missing or malformed is an
 * error rather than a silent fallthrough — the user asked for that file, so
 * quietly ignoring it would sync from an unexpected account or fail later with
 * a confusing message.
 */
async function readSourceCredentials(paths: Paths): Promise<SourceCredentials> {
  const own = await tryReadCredentials(paths.credentialsFile);
  if (own !== "absent" && own !== "invalid") {
    return own;
  }

  const external = paths.externalCredentialsFile;
  if (external) {
    const found = await tryReadCredentials(external);
    if (found !== "absent" && found !== "invalid") {
      return found;
    }
    throw new VitalsError(
      "AUTH_MISSING",
      found === "absent"
        ? `VITALS_GOOGLE_TOKEN points at ${external}, which could not be read.`
        : `Credential file at ${external} is not valid JSON, or lacks client_id, client_secret, and refresh_token.`,
      {
        hint: `Fix that file, unset VITALS_GOOGLE_TOKEN, or ${RUN_AUTH.toLowerCase()}`,
      }
    );
  }

  if (own === "invalid") {
    throw new VitalsError(
      "AUTH_MISSING",
      `Credential file at ${paths.credentialsFile} is not valid JSON, or lacks client_id, client_secret, and refresh_token.`,
      { hint: RUN_AUTH }
    );
  }

  throw new VitalsError(
    "AUTH_MISSING",
    "vitals is not connected to a Google account yet.",
    {
      hint: RUN_AUTH,
    }
  );
}

async function readCachedToken(
  tokenCacheFile: string
): Promise<AccessToken | null> {
  let raw: string;
  try {
    raw = await readFile(tokenCacheFile, "utf-8");
  } catch {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as Record<string, unknown>).token === "string" &&
      typeof (parsed as Record<string, unknown>).expiresAt === "string"
    ) {
      return parsed as AccessToken;
    }
    return null;
  } catch {
    return null;
  }
}

async function writeCachedToken(
  tokenCacheFile: string,
  token: AccessToken
): Promise<void> {
  await mkdir(dirname(tokenCacheFile), { recursive: true });
  await writeFile(tokenCacheFile, JSON.stringify(token, null, 2), {
    mode: 0o600,
  });
}

async function refreshAccessToken(
  creds: SourceCredentials,
  now: Date,
  fetchImpl: typeof fetch
): Promise<AccessToken> {
  const body = new URLSearchParams({
    client_id: creds.client_id,
    client_secret: creds.client_secret,
    grant_type: "refresh_token",
    refresh_token: creds.refresh_token,
  });

  const response = await fetchImpl(TOKEN_ENDPOINT, {
    body: body.toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });

  if (!response.ok) {
    const responseBody = await response.text().catch(() => "");
    throw new VitalsError(
      "AUTH_REFRESH_FAILED",
      `Token refresh failed with HTTP ${response.status}: ${responseBody}`
    );
  }

  const parsed = (await response.json()) as TokenRefreshResponse;
  if (
    typeof parsed.access_token !== "string" ||
    typeof parsed.expires_in !== "number"
  ) {
    throw new VitalsError(
      "AUTH_REFRESH_FAILED",
      `Token refresh response is missing access_token or expires_in: ${JSON.stringify(parsed)}`
    );
  }

  const expiresAt = new Date(
    now.getTime() + parsed.expires_in * 1000
  ).toISOString();
  return { expiresAt, token: parsed.access_token };
}

/**
 * Get a valid access token, reusing the cache when possible and refreshing
 * from stored credentials otherwise.
 *
 * NEVER writes to `paths.externalCredentialsFile` — see the comment on
 * `SourceCredentials`. Minted tokens are cached at `paths.tokenCacheFile`
 * (mode 0600).
 */
export async function getAccessToken(
  paths: Paths,
  opts?: { now?: Date; fetchImpl?: typeof fetch }
): Promise<string> {
  const now = opts?.now ?? new Date();
  const fetchImpl = opts?.fetchImpl ?? fetch;

  const cached = await readCachedToken(paths.tokenCacheFile);
  if (cached) {
    const expiresAtMs = Date.parse(cached.expiresAt);
    if (
      Number.isFinite(expiresAtMs) &&
      expiresAtMs - now.getTime() > EXPIRY_SKEW_MS
    ) {
      return cached.token;
    }
  }

  const creds = await readSourceCredentials(paths);
  const minted = await refreshAccessToken(creds, now, fetchImpl);
  await writeCachedToken(paths.tokenCacheFile, minted);
  return minted.token;
}
