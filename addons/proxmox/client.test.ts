import { afterEach, describe, expect, test } from "bun:test";

import {
  requestProxmoxApi,
  resolveProxmoxToken,
  setProxmoxCurlExecutorForTests,
} from "./client.js";

afterEach(() => {
  setProxmoxCurlExecutorForTests(null);
  delete (globalThis as { __piclawRuntimeInterop?: unknown }).__piclawRuntimeInterop;
});

describe("proxmox client auth", () => {
  test("resolveProxmoxToken combines configured username with a raw keychain secret", async () => {
    (globalThis as { __piclawRuntimeInterop?: { getKeychainEntry?: (name: string) => Promise<unknown> } }).__piclawRuntimeInterop = {
      getKeychainEntry: async (name: string) => ({
        name,
        type: "secret",
        secret: "f1630-uuid-token",
      }),
    };

    await expect(resolveProxmoxToken("root@pam!piclaw", "proxmox/piclaw-management-token")).resolves.toEqual({
      username: "root@pam!piclaw",
      secret: "f1630-uuid-token",
    });
  });

  test("requestProxmoxApi uses the configured username in the authorization header", async () => {
    (globalThis as { __piclawRuntimeInterop?: { getKeychainEntry?: (name: string) => Promise<unknown> } }).__piclawRuntimeInterop = {
      getKeychainEntry: async (name: string) => ({
        name,
        type: "secret",
        secret: "f1630-uuid-token",
      }),
    };

    let capturedCommand: string[] = [];
    setProxmoxCurlExecutorForTests(async (command) => {
      capturedCommand = command;
      return {
        exitCode: 0,
        stdout: '{"data":{"version":"9.1.7"}}\n__PICLAW_PROXMOX_STATUS__:200',
        stderr: "",
      };
    });

    const response = await requestProxmoxApi(
      {
        base_url: "https://borg.local:8006/api2/json",
        username: "root@pam!piclaw",
        api_token_keychain: "proxmox/piclaw-management-token",
        allow_insecure_tls: true,
      },
      {
        method: "GET",
        path: "/version",
      },
    );

    expect(response.status).toBe(200);
    expect(capturedCommand).toEqual(expect.arrayContaining([
      "-H",
      "Authorization: PVEAPIToken=root@pam!piclaw=f1630-uuid-token",
    ]));
  });
});
