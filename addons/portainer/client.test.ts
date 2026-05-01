import { afterEach, describe, expect, test } from "bun:test";

import {
  requestPortainerApi,
  resolvePortainerAuth,
  setPortainerRequestExecutorForTests,
} from "./client.js";

afterEach(() => {
  setPortainerRequestExecutorForTests(null);
  delete (globalThis as { __piclawRuntimeInterop?: unknown }).__piclawRuntimeInterop;
});

describe("portainer client auth", () => {
  test("resolvePortainerAuth reads the token secret from keychain", async () => {
    (globalThis as { __piclawRuntimeInterop?: { getKeychainEntry?: (name: string) => Promise<unknown> } }).__piclawRuntimeInterop = {
      getKeychainEntry: async (name: string) => ({
        name,
        type: "secret",
        secret: "portainer-token-123",
      }),
    };

    await expect(resolvePortainerAuth("portainer/relay")).resolves.toEqual({
      base_url: null,
      token: "portainer-token-123",
    });
  });

  test("resolvePortainerAuth unwraps a nested keychain entry JSON secret", async () => {
    (globalThis as { __piclawRuntimeInterop?: { getKeychainEntry?: (name: string) => Promise<unknown> } }).__piclawRuntimeInterop = {
      getKeychainEntry: async (name: string) => ({
        name,
        type: "secret",
        secret: JSON.stringify({
          name,
          type: "secret",
          secret: "portainer-token-456",
          username: "https://relay.local:9443",
        }),
      }),
    };

    await expect(resolvePortainerAuth("portainer/relay")).resolves.toEqual({
      base_url: "https://relay.local:9443",
      token: "portainer-token-456",
    });
  });

  test("requestPortainerApi prefers the configured base URL over legacy keychain username data", async () => {
    (globalThis as { __piclawRuntimeInterop?: { getKeychainEntry?: (name: string) => Promise<unknown> } }).__piclawRuntimeInterop = {
      getKeychainEntry: async (name: string) => ({
        name,
        type: "secret",
        secret: "portainer-token-123",
        username: "https://old-portainer.example:9443",
      }),
    };

    let capturedInput: { url: string; headers: Record<string, string> } | null = null;
    setPortainerRequestExecutorForTests(async (input) => {
      capturedInput = { url: input.url, headers: input.headers };
      return {
        status: 200,
        statusText: "OK",
        bodyText: '{"Version":"2.27.6"}',
      };
    });

    const response = await requestPortainerApi(
      {
        base_url: "https://relay.local:9443",
        api_token_keychain: "portainer/relay",
        allow_insecure_tls: true,
      },
      {
        method: "GET",
        path: "/api/status",
      },
    );

    expect(response.status).toBe(200);
    expect(capturedInput).toEqual({
      url: "https://relay.local:9443/api/status",
      headers: expect.objectContaining({
        "X-API-Key": "portainer-token-123",
        Accept: "application/json",
      }),
    });
  });

  test("requestPortainerApi extracts the token from mixed-output keychain payloads", async () => {
    (globalThis as { __piclawRuntimeInterop?: { getKeychainEntry?: (name: string) => Promise<unknown> } }).__piclawRuntimeInterop = {
      getKeychainEntry: async (name: string) => ({
        name,
        type: "secret",
        secret: [
          '{"ts":"2026-04-30T17:39:44Z","level":"info","message":"Opened database connection"}',
          JSON.stringify({ name, type: "secret", secret: "portainer-token-789" }),
        ].join("\n"),
      }),
    };

    let capturedHeaders: Record<string, string> | null = null;
    setPortainerRequestExecutorForTests(async (input) => {
      capturedHeaders = input.headers;
      return {
        status: 200,
        statusText: "OK",
        bodyText: '{"Version":"2.27.6"}',
      };
    });

    await requestPortainerApi(
      {
        base_url: "https://relay.local:9443",
        api_token_keychain: "portainer/relay",
        allow_insecure_tls: true,
      },
      {
        method: "GET",
        path: "/api/status",
      },
    );

    expect(capturedHeaders).toEqual(expect.objectContaining({
      "X-API-Key": "portainer-token-789",
    }));
  });
});
