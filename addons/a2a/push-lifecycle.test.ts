import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Message } from "@a2a-js/sdk";
import { A2aService } from "./service.js";
import { A2aTaskStore, type PublicOperation } from "./task-store.js";
import { A2aPushWorker } from "./push-worker.js";
import type { A2aHostApi, OperationAdapter } from "./runtime-api.js";
import type { A2aConfig } from "./config.js";
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function setup(url: string) {
  const dir = mkdtempSync(join(tmpdir(), "a2a-push-life-"));
  dirs.push(dir);
  const store = new A2aTaskStore(dir),
    t = store.reserve(
      "alice",
      "echo",
      Message.fromJSON({
        messageId: "first",
        role: "ROLE_USER",
        parts: [{ text: "work" }],
      }),
    ).record;
  store.attachOperation("alice", t.id, "op");
  const cfg: A2aConfig = {
    enabled: true,
    inbound: true,
    outbound: false,
    publicBaseUrl: "https://fixture.invalid",
    principals: [
      { id: "alice", targets: ["echo"], enabled: true, credentialKey: "in" },
    ],
    agents: [{ id: "echo", name: "Echo", description: "test", enabled: true }],
    endpoints: [],
    push: {
      enabled: true,
      callbacks: [
        {
          id: "grant",
          principal: "alice",
          targets: ["echo"],
          url,
          credentialKey: "out",
          allowPrivate: true,
          enabled: true,
        },
      ],
      receivers: [],
    },
  };
  const op: PublicOperation = {
    id: "op",
    sequence: 2,
    status: "completed",
    output: "out",
    reason: null,
    updatedAt: new Date().toISOString(),
  };
  const adapter: OperationAdapter = {
    forPrincipal() {
      return {
        version: 1,
        admit: async () => ({
          created: false,
          admission: "allow",
          operation: op,
        }),
        get: async () => op,
        events: async (_id, after = 0) => ({
          snapshot: op,
          events: after < 2 ? [{ sequence: 2, snapshot: op }] : [],
          gap: false,
        }),
        cancel: async () => ({ outcome: "not_cancellable", operation: op }),
        resume: async () => ({ resumed: false, operation: op }),
        continue: async () => ({ resumed: false, operation: op }),
      };
    },
  };
  store.push.upsert({
    principal: "alice",
    taskId: t.id,
    id: "callback",
    url,
    credentialKey: "out",
    allowPrivate: true,
  });
  return { dir, store, t, cfg, adapter };
}

test("dispatcher shutdown aborts a stalled callback and restart retries stable pending identity", async () => {
  let entered!: (value: void) => void;
  const started = new Promise<void>((r) => {
    entered = r;
  });
  const ids: string[] = [];
  let stall = true;
  const sink = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      ids.push(req.headers.get("a2a-delivery-id")!);
      entered();
      if (stall) {
        await new Promise<void>((resolve) =>
          req.signal.addEventListener("abort", () => resolve(), { once: true }),
        );
      }
      return new Response(null, { status: 204 });
    },
  });
  const f = setup(sink.url.href);
  let worker = new A2aPushWorker(
    () => f.cfg,
    f.store,
    f.adapter,
    async () => "long-test-credential-1234567890",
  );
  try {
    f.store.push.enqueue("alice", f.t.id, "initial", { task: { id: f.t.id } });
    const tick = worker.tick();
    await started;
    await worker.close();
    await tick;
    expect(
      f.store.push.inspect("alice", f.t.id).some((d) => d.state === "sending"),
    ).toBe(true);
    stall = false;
    worker = new A2aPushWorker(
      () => f.cfg,
      f.store,
      f.adapter,
      async () => "long-test-credential-1234567890",
    );
    f.store.push.recover();
    await worker.tick();
    expect(ids[1]).toBe(ids[0]);
    expect(
      f.store.push
        .inspect("alice", f.t.id)
        .every((d) => d.state === "delivered"),
    ).toBe(true);
  } finally {
    await worker.close();
    f.store.close();
    sink.stop(true);
  }
}, 15000);

test("disable and restart of real service do not leave dispatcher/network resources active", async () => {
  let posts = 0;
  const sink = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        posts++;
        return new Response(null, { status: 204 });
      },
    }),
    f = setup(sink.url.href);
  f.store.close();
  let removed = 0;
  const hooks: Array<() => void | Promise<void>> = [];
  const host: A2aHostApi = {
    operations: { version: 1, register: () => f.adapter },
    messaging: { version: 1, getAddonDataDir: () => f.dir },
    externalRoutes: {
      version: 1,
      register: () => () => {
        removed++;
      },
    },
    lifecycle: {
      version: 1,
      onShutdown(fn) {
        hooks.push(fn);
        return () => {};
      },
    },
  };
  const service = new A2aService(
    host,
    f.dir,
    async () => "long-test-credential-1234567890",
  );
  try {
    expect(service.status().push.running).toBe(false);
    await service.setConfig(f.cfg);
    expect(service.status().push.running).toBe(true);
    // A received HTTP request is not a dispatcher completion receipt. Wait for
    // durable settlement before testing idle disable; the test above covers
    // shutdown during an in-flight callback and recovery of uncertain delivery.
    const deadline = Date.now() + 10000;
    const settled = () => {
      const push = service.status().push;
      return posts > 0 && "active" in push && !push.active &&
        push.outbox.some((row) => row.state === "delivered") &&
        push.outbox.every((row) => row.state === "delivered");
    };
    while (!settled() && Date.now() < deadline)
      await Bun.sleep(10);
    expect(settled()).toBe(true);
    expect(posts).toBeGreaterThan(0);
    await service.setConfig({
      ...f.cfg,
      push: { ...f.cfg.push!, enabled: false },
    });
    const before = posts;
    await new Promise((r) => setTimeout(r, 650));
    expect(posts).toBe(before);
    expect(service.status().push.running).toBe(false);
  } finally {
    await service.close();
    for (const hook of hooks) await hook();
    sink.stop(true);
  }
  expect(removed).toBe(1);
}, 15000);
