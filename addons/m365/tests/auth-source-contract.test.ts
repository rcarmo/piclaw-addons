import { expect, test } from "bun:test";

import {
  auth,
  extractConsumerAuthCodeFromRedirect,
  extractImplicitOAuthTokenFromRedirect,
  graphFetch,
  isM365YoloEnabled,
  resolveGraphAuthMode,
} from "../shared.js";

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
