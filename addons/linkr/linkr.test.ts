import { test, expect, afterEach } from "bun:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LinkrClient, type Transport } from "./client";
import {
  validateConfig,
  saveConfig,
  selectProfile,
  getProfile,
  type Profile,
} from "./config";
import { validate, textEvents, combo, click } from "./input";
import {
  state,
  send,
  startJob,
  ownedJob,
  validateJob,
  pruneArtifacts,
} from "./jobs";
import { dispatch, buildEvents, Parameters } from "./extension";
import addon, { skillNames } from "./index";
const p: Profile = {
  id: "fixture",
  label: "Fixture",
  origin: "http://127.0.0.1:11111",
  targetIdentity: "Disposable fixture",
  tokenKeychain: "linkr/test-only",
  inputEnabled: true,
};
let roots: string[] = [];
afterEach(async () => {
  for (const j of state.jobs.values()) j.abort.abort();
  await Bun.sleep(10);
  state.jobs.clear();
  state.leases.clear();
  for (const r of roots) await rm(r, { recursive: true, force: true });
  roots = [];
});
const root = async () => {
  const r = await mkdtemp(join(tmpdir(), "linkr-test-"));
  roots.push(r);
  return r;
};
const mock: Transport = {
  snapshot: async () => Buffer.from([255, 216, 255, 217]),
  control: async () => {},
};
test("input validates paired keys, clicks, limits, Unicode and pauses", () => {
  expect(
    validate({ events: combo(["ControlLeft", "KeyL"]) }).events.at(-1),
  ).toEqual(["keyboard", "ControlLeft", false]);
  expect(validate({ events: click(0.5, 0.5) }).events.length).toBe(3);
  expect(textEvents("a".repeat(61)).length).toBe(6);
  for (const events of [
    [["keyboard", "ShiftLeft", true]],
    [["keyboard", "KeyA", false]],
    [["mouse_abs", 1, 0.5, 0.5, 0, 0]],
    [["mouse_rel", 0, 0, 0, 21, 0]],
    [["text", "abc"]],
    Array(13).fill(["delay", 5000]),
  ])
    expect(() => validate({ events })).toThrow();
  expect(() => textEvents("olá")).toThrow();
  expect(() => textEvents("a".repeat(1025))).toThrow();
  expect(() => validate({ events: click(2, 0.5) })).toThrow();
});
test("high-level input repeat/drag and mouse validation", () => {
  expect(
    buildEvents({ action: "mouse.drag", x: 0, y: 0, to_x: 1, to_y: 1 }).at(-1),
  ).toEqual(["mouse_abs", 0, 1, 1, 0, 0]);
  expect(() =>
    buildEvents({
      action: "key.repeat",
      key: "F2",
      count: 100,
      interval_ms: 200,
    }),
  ).toThrow();
  expect(() => buildEvents({ action: "mouse.click", x: NaN, y: 0 })).toThrow();
  expect(() => buildEvents({ action: "key.tap" })).toThrow();
  expect(
    buildEvents({ action: "key.repeat", key: "F2", count: 2, interval_ms: 200 })
      .length,
  ).toBe(8);
});
test("profiles require unique explicit origins and chat-scoped selection", () => {
  expect(() =>
    validateConfig({ profiles: [p, { ...p, id: "alias" }] }),
  ).toThrow();
  for (const origin of [
    "http://user:secret@host",
    "file:///etc",
    "http://host/path",
    "http://host/?x=1",
  ])
    expect(() => validateConfig({ profiles: [{ ...p, origin }] })).toThrow();
  saveConfig({ profiles: [p] });
  selectProfile(p.id, "test-a");
  expect(getProfile(undefined, "test-a").id).toBe("fixture");
  expect(() => getProfile(undefined, "test-b")).toThrow();
});
test("tool previews do not resolve secrets or send requests; optional APIs unsupported", async () => {
  saveConfig({ profiles: [p] });
  const r = await dispatch(
    { action: "text", device_id: p.id, text: "private" },
    "test",
  );
  expect(JSON.stringify(r)).not.toContain("private");
  expect((r.details as any).dry_run).toBe(true);
  const unsupported = await dispatch(
    { action: "power.cycle", device_id: p.id, execute: true },
    "test",
  );
  expect((unsupported.details as any).outcome).toBe("unsupported");
  expect(
    (await dispatch({ action: "reboot.plan", device_id: p.id }, "test"))
      .details,
  ).toHaveProperty("execute_supported", false);
  saveConfig({ profiles: [{ ...p, inputEnabled: false }] });
  await expect(
    dispatch(
      { action: "key.tap", key: "F2", device_id: p.id, execute: true },
      "test",
    ),
  ).rejects.toThrow("disabled");
});
test("HTTP auth, JPEG and API acknowledgements; no control retry or redirect forwarding", async () => {
  let mode = "ok",
    hits = 0;
  const token = "fixture-secret";
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      hits++;
      expect(req.headers.get("authorization")).toBe("token " + token);
      if (mode === "redirect")
        return new Response(null, {
          status: 302,
          headers: { location: "/other" },
        });
      if (req.method === "POST") {
        await req.json();
        return Response.json({ code: mode === "error" ? 1 : 0 });
      }
      return new Response(
        mode === "badjpeg" ? "not JPEG" : new Uint8Array([255, 216, 255, 217]),
      );
    },
  });
  const c = new LinkrClient(
    { ...p, origin: `http://127.0.0.1:${server.port}` },
    () => token,
  );
  try {
    expect((await c.snapshot()).length).toBe(4);
    await c.control(combo(["KeyA"]));
    mode = "error";
    await expect(c.control(combo(["KeyA"]))).rejects.toThrow();
    mode = "badjpeg";
    await expect(c.snapshot()).rejects.toThrow();
    mode = "redirect";
    const n = hits;
    await expect(c.snapshot()).rejects.toThrow();
    expect(hits - n).toBe(1);
  } finally {
    server.stop(true);
  }
});
test("unknown delivery reserves device and known keys; aliases cannot evade lock", async () => {
  const bad: Transport = {
    ...mock,
    control: async () => {
      throw new Error("timeout");
    },
  };
  await expect(
    send(p, "owner", combo(["ControlLeft", "KeyA"]), bad),
  ).rejects.toThrow();
  expect(state.leases.get(p.origin)?.uncertain).toBe(true);
  expect(state.leases.get(p.origin)?.keys.has("ControlLeft")).toBe(true);
  await expect(
    send({ ...p, id: "alias" }, "other", combo(["KeyA"]), mock),
  ).rejects.toThrow();
});
test("concurrent control fails and successful action releases lease", async () => {
  let done!: () => void;
  const slow: Transport = {
    ...mock,
    control: () => new Promise((r) => (done = r)),
  };
  const a = send(p, "a", combo(["KeyA"]), slow);
  await expect(send(p, "b", combo(["KeyB"]), mock)).rejects.toThrow();
  done();
  await a;
  expect(state.leases.size).toBe(0);
});
test("job validation requires key evidence and narrow repeat window", () => {
  const base = {
    kind: "firmware-entry" as const,
    duration_ms: 1000,
    capture_interval_ms: 1000,
    key: "F2",
    key_evidence: "fixture prompt",
    tap_start_ms: 0,
    tap_interval_ms: 200,
    tap_duration_ms: 400,
  };
  expect(validateJob(base)).toEqual(base);
  expect(() => validateJob({ ...base, key_evidence: "" })).toThrow();
  expect(() => validateJob({ ...base, tap_duration_ms: 6000 })).toThrow();
  expect(() => validateJob({ ...base, capture_interval_ms: 1 })).toThrow();
});
test("bounded capture job completes, records private evidence, owner checks", async () => {
  const dir = await root();
  const j = await startJob(
    p,
    "a",
    { kind: "capture", duration_ms: 1000, capture_interval_ms: 1000 },
    mock,
    dir,
  );
  expect(() => ownedJob(j.id, "b")).toThrow();
  await Bun.sleep(1100);
  expect(j.state).toBe("completed");
  expect(j.frames.length).toBe(1);
  const saved = JSON.parse(
    await readFile(join(j.directory, "job.json"), "utf8"),
  );
  expect(saved.state).toBe("completed");
  expect(saved).not.toHaveProperty("tokenKeychain");
});
test("firmware job stops taps, cancellation stops future events and releases device", async () => {
  const dir = await root();
  let taps = 0;
  const t: Transport = {
    ...mock,
    control: async () => {
      taps++;
    },
  };
  const j = await startJob(
    p,
    "a",
    {
      kind: "firmware-entry",
      duration_ms: 3000,
      capture_interval_ms: 1000,
      key: "F2",
      key_evidence: "operator",
      tap_start_ms: 0,
      tap_interval_ms: 200,
      tap_duration_ms: 400,
    },
    t,
    dir,
  );
  await Bun.sleep(600);
  expect(taps).toBeGreaterThan(0);
  const at = taps;
  await Bun.sleep(250);
  expect(taps).toBe(at);
  j.abort.abort();
  await Bun.sleep(30);
  expect(j.state).toBe("cancelled");
  expect(state.leases.size).toBe(0);
});
test("failed input job retains uncertain lease, no subsequent replay", async () => {
  const j = await startJob(
    p,
    "a",
    {
      kind: "firmware-entry",
      duration_ms: 1000,
      capture_interval_ms: 1000,
      key: "F2",
      key_evidence: "operator",
      tap_start_ms: 0,
      tap_interval_ms: 200,
      tap_duration_ms: 400,
    },
    {
      ...mock,
      control: async () => {
        throw new Error("connection gone");
      },
    },
    await root(),
  );
  await Bun.sleep(50);
  expect(j.state).toBe("failed");
  expect(state.leases.get(p.origin)?.uncertain).toBe(true);
  expect(j.taps).toBe(0);
});
test("pruning ignores non-owned directory and standalone registers seven skills", async () => {
  const dir = await root();
  await pruneArtifacts(dir);
  const hooks: any = {};
  const tools: any[] = [];
  addon({
    on: (n: string, f: any) => (hooks[n] = f),
    registerTool: (t: any) => tools.push(t),
  } as any);
  expect(tools[0].name).toBe("linkr");
  expect((Parameters.properties.action as any).enum).toContain("snapshot");
  expect(hooks.resources_discover().skillPaths.length).toBe(7);
  for (const name of skillNames)
    expect(
      await Bun.file(
        join(import.meta.dir, "skills", name, "SKILL.md"),
      ).exists(),
    ).toBe(true);
});
test("simultaneous capture starts reserve admission before filesystem awaits", async () => {
  const dir = await root();
  const spec = {
    kind: "capture" as const,
    duration_ms: 1000,
    capture_interval_ms: 1000,
  };
  const first = startJob(p, "a", spec, mock, dir);
  await expect(startJob(p, "b", spec, mock, dir)).rejects.toThrow();
  const j = await first;
  j.abort.abort();
});
test("already-aborted HID never claims control or reaches transport", async () => {
  const abort = new AbortController();
  abort.abort();
  let calls = 0;
  await expect(
    send(
      p,
      "a",
      combo(["KeyA"]),
      {
        ...mock,
        control: async () => {
          calls++;
        },
      },
      abort.signal,
    ),
  ).rejects.toThrow();
  expect(calls).toBe(0);
  expect(state.leases.size).toBe(0);
});
test("capture failure becomes failed, not falsely cancelled", async () => {
  const j = await startJob(
    p,
    "a",
    { kind: "capture", duration_ms: 1000, capture_interval_ms: 1000 },
    {
      ...mock,
      snapshot: async () => {
        throw new Error("offline");
      },
    },
    await root(),
  );
  await Bun.sleep(40);
  expect(j.state).toBe("failed");
});
