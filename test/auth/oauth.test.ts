import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runAuthFlow } from "../../src/auth/oauth.js";
import type { Paths } from "../../src/types.js";

let dir: string;
let paths: Paths;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "vitals-oauth-test-"));
  paths = {
    credentialsFile: join(dir, "credentials.json"),
    dataDir: dir,
    dbFile: join(dir, "vitals.db"),
    externalCredentialsFile: null,
    tokenCacheFile: join(dir, "token.json"),
  };
});

afterEach(async () => {
  await rm(dir, { force: true, recursive: true });
});

describe("runAuthFlow", () => {
  it("does not render a provider error as HTML", async () => {
    const providerError = '<img src=x onerror="alert(1)">';
    let callbackResponse: Promise<Response> | undefined;

    const flow = runAuthFlow(paths, "client-id", "client-secret", {
      log: () => undefined,
      openUrl: (authorizationUrl) => {
        const authorization = new URL(authorizationUrl);
        const callback = new URL(
          authorization.searchParams.get("redirect_uri") ?? ""
        );
        callback.searchParams.set("error", providerError);
        callback.searchParams.set(
          "state",
          authorization.searchParams.get("state") ?? ""
        );
        callbackResponse = fetch(callback);
      },
    });

    await expect(flow).rejects.toMatchObject({
      code: "AUTH_MISSING",
      message: `Authorization was denied: ${providerError}`,
    });
    if (!callbackResponse) {
      throw new Error("expected an OAuth callback response");
    }
    const response = await callbackResponse;
    const body = await response.text();

    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toBe(
      "text/html; charset=utf-8"
    );
    expect(body).toContain("Authorization failed");
    expect(body).not.toContain(providerError);
  });

  it("exchanges a legitimate callback code and persists credentials", async () => {
    let callbackResponse: Promise<Response> | undefined;
    const fetchImpl = async (): Promise<Response> =>
      new Response(JSON.stringify({ refresh_token: "refresh-token" }), {
        headers: { "Content-Type": "application/json" },
        status: 200,
      });

    const credentials = await runAuthFlow(paths, "client-id", "client-secret", {
      fetchImpl,
      log: () => undefined,
      openUrl: (authorizationUrl) => {
        const authorization = new URL(authorizationUrl);
        const callback = new URL(
          authorization.searchParams.get("redirect_uri") ?? ""
        );
        callback.searchParams.set("code", "authorization-code");
        callback.searchParams.set(
          "state",
          authorization.searchParams.get("state") ?? ""
        );
        callbackResponse = fetch(callback);
      },
    });

    expect(credentials).toMatchObject({
      client_id: "client-id",
      client_secret: "client-secret",
      refresh_token: "refresh-token",
    });
    expect(JSON.parse(await readFile(paths.credentialsFile, "utf8"))).toEqual(
      credentials
    );
    if (!callbackResponse) {
      throw new Error("expected an OAuth callback response");
    }
    const response = await callbackResponse;
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("vitals is now connected");
  });
});
