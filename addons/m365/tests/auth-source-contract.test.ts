import { afterEach, expect, test } from "bun:test";

import {
  auth,
  extractConsumerAuthCodeFromRedirect,
  extractImplicitOAuthTokenFromRedirect,
  graphFetch,
  isM365YoloEnabled,
  M365_CREDENTIAL_MIN_REMAINING_SECONDS,
  M365_CREDENTIAL_PROVIDER_GLOBAL,
  requestHostM365Credential,
  resolveGraphAuthMode,
  validateHostM365Credential,
} from "../shared.js";

const credentialGlobals = globalThis as Record<string, unknown>;
const originalCredentialProvider = credentialGlobals[M365_CREDENTIAL_PROVIDER_GLOBAL];

function jwt(claims: Record<string, unknown>): string {
  return `header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`;
}

afterEach(() => {
  auth.clearAll();
  if (originalCredentialProvider === undefined) delete credentialGlobals[M365_CREDENTIAL_PROVIDER_GLOBAL];
  else credentialGlobals[M365_CREDENTIAL_PROVIDER_GLOBAL] = originalCredentialProvider;
});

test("isM365YoloEnabled accepts common truthy spellings", () => {
  expect(isM365YoloEnabled(undefined)).toBe(false);
  expect(isM365YoloEnabled("0")).toBe(false);
  expect(isM365YoloEnabled("1")).toBe(true);
  expect(isM365YoloEnabled("true")).toBe(true);
  expect(isM365YoloEnabled("YES")).toBe(true);
  expect(isM365YoloEnabled(" on ")).toBe(true);
});

test("extractConsumerAuthCodeFromRedirect requires exact redirect origin/path and matching state", () => {
  expect(
    extractConsumerAuthCodeFromRedirect(
      "https://outlook.live.com/mail/?code=abc&state=ok",
      "https://outlook.live.com/mail/",
      "ok",
    ),
  ).toBe("abc");

  expect(
    extractConsumerAuthCodeFromRedirect(
      "https://outlook.live.com/mail/inbox?code=abc&state=ok",
      "https://outlook.live.com/mail/",
      "ok",
    ),
  ).toBeNull();

  expect(
    extractConsumerAuthCodeFromRedirect(
      "https://outlook.live.com/mail/?code=abc&state=wrong",
      "https://outlook.live.com/mail/",
      "ok",
    ),
  ).toBeNull();

  expect(
    extractConsumerAuthCodeFromRedirect(
      "https://outlook.live.com/mail/?error=access_denied&state=ok",
      "https://outlook.live.com/mail/",
      "ok",
    ),
  ).toBeNull();
});

test("extractImplicitOAuthTokenFromRedirect requires exact redirect origin/path and matching state", () => {
  expect(
    extractImplicitOAuthTokenFromRedirect(
      "https://teams.microsoft.com/go#access_token=abc&state=ok",
      "https://teams.microsoft.com/go",
      "ok",
    ),
  ).toBe("abc");

  expect(
    extractImplicitOAuthTokenFromRedirect(
      "https://teams.microsoft.com/go?state=ok#access_token=abc",
      "https://teams.microsoft.com/go",
      "ok",
    ),
  ).toBe("abc");

  expect(
    extractImplicitOAuthTokenFromRedirect(
      "https://teams.microsoft.com/go/elsewhere#access_token=abc&state=ok",
      "https://teams.microsoft.com/go",
      "ok",
    ),
  ).toBeNull();

  expect(
    extractImplicitOAuthTokenFromRedirect(
      "https://teams.microsoft.com/go#access_token=abc&state=wrong",
      "https://teams.microsoft.com/go",
      "ok",
    ),
  ).toBeNull();

  expect(
    extractImplicitOAuthTokenFromRedirect(
      "https://teams.microsoft.com/go#error=access_denied&state=ok",
      "https://teams.microsoft.com/go",
      "ok",
    ),
  ).toBeNull();
});

test("resolveGraphAuthMode hard-fails only for known consumer mode", () => {
  expect(resolveGraphAuthMode({ tenantId: "9188040d-6c67-4c5b-b112-36a304b66dad" })).toEqual({
    useConsumerFlow: true,
    hardFailOnConsumerFailure: true,
  });

  expect(resolveGraphAuthMode({ isConsumer: true })).toEqual({
    useConsumerFlow: true,
    hardFailOnConsumerFailure: true,
  });

  expect(resolveGraphAuthMode({ consumerSessionVisible: true })).toEqual({
    useConsumerFlow: true,
    hardFailOnConsumerFailure: false,
  });

  expect(resolveGraphAuthMode({ consumerSessionVisible: false })).toEqual({
    useConsumerFlow: false,
    hardFailOnConsumerFailure: false,
  });
});

test("host credential validation accepts target audiences and rejects stale, mismatched, or opaque tokens", () => {
  const now = 1_800_000_000;
  const graphToken = jwt({ aud: "https://graph.microsoft.com", exp: now + 900, tid: "tenant-a" });
  expect(validateHostM365Credential("graph", { token: graphToken, expiresAt: now + 800, tenantId: "tenant-a" }, 300, now)).toEqual({
    token: graphToken,
    expiresAt: now + 800,
    tenantId: "tenant-a",
  });
  expect(validateHostM365Credential("graph", { token: jwt({ aud: "https://wrong.example", exp: now + 900 }) }, 300, now)).toBeNull();
  expect(validateHostM365Credential("graph", { token: graphToken, expiresAt: now + 100 }, 300, now)).toBeNull();
  expect(validateHostM365Credential("graph", { token: graphToken, tenantId: "tenant-b" }, 300, now)).toBeNull();
  expect(validateHostM365Credential("graph", { token: "opaque-token", expiresAt: now + 900 }, 300, now)).toBeNull();

  const chatsvcToken = jwt({ aud: "https://ic3.teams.office.com", exp: now + 900 });
  expect(validateHostM365Credential("teams_chatsvc", { token: chatsvcToken }, 300, now)?.token).toBe(chatsvcToken);
  expect(validateHostM365Credential("teams_chatsvc", {
    token: jwt({ aud: "https://wrong.example", scp: "Teams.AccessAsUser.All", exp: now + 900 }),
  }, 300, now)).toBeNull();
  expect(validateHostM365Credential("teams_chatsvc", {
    token: jwt({ aud: "https://evil.example/chatsvcagg", exp: now + 900 }),
  }, 300, now)).toBeNull();
});

test("host credential provider is optional, bounded by contract, and suppresses provider error contents", async () => {
  delete credentialGlobals[M365_CREDENTIAL_PROVIDER_GLOBAL];
  await expect(requestHostM365Credential("graph")).resolves.toBeNull();

  const originalSetTimeout = globalThis.setTimeout;
  credentialGlobals[M365_CREDENTIAL_PROVIDER_GLOBAL] = () => new Promise(() => {});
  globalThis.setTimeout = ((callback: (...args: unknown[]) => void) => originalSetTimeout(callback, 0)) as typeof setTimeout;
  try {
    await expect(requestHostM365Credential("graph")).resolves.toBeNull();
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }

  const originalDebug = console.debug;
  const originalDebugFlag = process.env.DEBUG;
  const logs: string[] = [];
  process.env.DEBUG = "1";
  console.debug = (...args: unknown[]) => logs.push(args.map(String).join(" "));
  credentialGlobals[M365_CREDENTIAL_PROVIDER_GLOBAL] = async () => {
    throw new Error("provider-secret-must-not-be-logged");
  };
  try {
    await expect(requestHostM365Credential("graph")).resolves.toBeNull();
    expect(logs.join("\n")).not.toContain("provider-secret-must-not-be-logged");
  } finally {
    console.debug = originalDebug;
    if (originalDebugFlag === undefined) delete process.env.DEBUG;
    else process.env.DEBUG = originalDebugFlag;
  }
});

test("auth consults and RAM-caches the host provider before browser acquisition", async () => {
  const now = Math.floor(Date.now() / 1000);
  const graphToken = jwt({ aud: "00000003-0000-0000-c000-000000000000", exp: now + 900 });
  let calls = 0;
  credentialGlobals[M365_CREDENTIAL_PROVIDER_GLOBAL] = async (request: { resource: string; minRemainingSeconds: number }) => {
    calls += 1;
    expect(request).toEqual({ resource: "graph", minRemainingSeconds: M365_CREDENTIAL_MIN_REMAINING_SECONDS });
    return { token: graphToken };
  };

  await expect(auth.getGraphToken()).resolves.toBe(graphToken);
  delete credentialGlobals[M365_CREDENTIAL_PROVIDER_GLOBAL];
  await expect(auth.getGraphToken()).resolves.toBe(graphToken);
  expect(calls).toBe(1);
});

test("auth accepts a host chatsvc token and derives its regional endpoint", async () => {
  const now = Math.floor(Date.now() / 1000);
  const chatsvcToken = jwt({ aud: "https://ic3.teams.office.com", exp: now + 900, regionGtms: "amer" });
  credentialGlobals[M365_CREDENTIAL_PROVIDER_GLOBAL] = async (request: { resource: string }) => {
    expect(request.resource).toBe("teams_chatsvc");
    return { token: chatsvcToken };
  };

  await expect(auth.getChatsvcAuth()).resolves.toEqual({
    token: chatsvcToken,
    baseUrl: "https://teams.cloud.microsoft/api/chatsvc/amer/v1",
  });
});

test("graphFetch cancels 401 bodies before retrying with a fresh token", async () => {
  const originalFetch = globalThis.fetch;
  const originalGetGraphToken = auth.getGraphToken;
  const requests: Array<{ url: string; headers: Record<string, string> }> = [];
  let cancelled = false;

  auth.getGraphToken = async (force = false) => force ? "fresh-token" : "stale-token";
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({
      url: String(input),
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    if (requests.length === 1) {
      return {
        ok: false,
        status: 401,
        body: {
          locked: false,
          cancel: async () => {
            cancelled = true;
          },
        },
        text: async () => "Unauthorized",
      } as unknown as Response;
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as typeof fetch;

  try {
    await expect(graphFetch("me")).resolves.toEqual({ ok: true });
    expect(cancelled).toBe(true);
    expect(requests).toHaveLength(2);
    expect(requests[0]?.headers.Authorization).toBe("Bearer stale-token");
    expect(requests[1]?.headers.Authorization).toBe("Bearer fresh-token");
  } finally {
    globalThis.fetch = originalFetch;
    auth.getGraphToken = originalGetGraphToken;
  }
});

test("graphFetch returns null for 204 no-content JSON responses", async () => {
  const originalFetch = globalThis.fetch;
  const originalGetGraphToken = auth.getGraphToken;

  auth.getGraphToken = async () => "graph-token";
  globalThis.fetch = (async () => new Response(null, { status: 204 })) as unknown as typeof fetch;

  try {
    await expect(graphFetch("me/drive/items/123", { method: "DELETE" })).resolves.toBeNull();
  } finally {
    globalThis.fetch = originalFetch;
    auth.getGraphToken = originalGetGraphToken;
  }
});
