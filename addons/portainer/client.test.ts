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
});
