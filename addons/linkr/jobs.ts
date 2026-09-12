import { randomUUID, createHash } from "node:crypto";
import { mkdir, writeFile, readdir, stat, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Profile } from "./config.js";
import type { Transport } from "./client.js";
import { combo, type Event } from "./input.js";
export interface JobSpec {
  kind: "capture" | "firmware-entry";
  duration_ms: number;
  capture_interval_ms: number;
  key?: string;
  key_evidence?: string;
  tap_start_ms?: number;
  tap_interval_ms?: number;
  tap_duration_ms?: number;
}
export interface Job {
  id: string;
  owner: string;
  profile: Profile;
  spec: JobSpec;
  state: "running" | "completed" | "cancelled" | "failed";
  started_at: string;
  ended_at?: string;
  frames: { at_ms: number; sha256: string; file: string }[];
  taps: number;
  error?: string;
  abort: AbortController;
  directory: string;
}
interface Lease {
  owner: string;
  id: string;
  keys: Set<string>;
  mouse: boolean;
  uncertain: boolean;
}
interface State {
  leases: Map<string, Lease>;
  jobs: Map<string, Job>;
  pending: Set<string>;
}
const key = Symbol.for("piclaw.linkr.jobs.v1");
const global = globalThis as typeof globalThis & { [key]?: State };
export const state: State = (global[key] ??= {
  leases: new Map(),
  jobs: new Map(),
  pending: new Set(),
});
// Device origin, not profile ID: aliases cannot evade in-process ownership.
export function acquire(p: Profile, owner: string, id = randomUUID()): string {
  if (state.leases.has(p.origin))
    throw new Error(
      "Device input is owned by another operation, or needs input.release after uncertain delivery.",
    );
  state.leases.set(p.origin, {
    owner,
    id,
    keys: new Set(),
    mouse: false,
    uncertain: false,
  });
  return id;
}
export function track(p: Profile, events: Event[]) {
  const lease = state.leases.get(p.origin);
  if (!lease) return;
  for (const e of events) {
    if (e[0] === "keyboard" && e[2]) lease.keys.add(String(e[1]));
    if ((e[0] === "mouse_abs" || e[0] === "mouse_rel") && e[1])
      lease.mouse = true;
  }
}
export function finish(p: Profile, id: string, uncertain = false) {
  const l = state.leases.get(p.origin);
  if (l?.id !== id) return;
  if (uncertain) l.uncertain = true;
  else state.leases.delete(p.origin);
}
export async function send(
  p: Profile,
  owner: string,
  events: Event[],
  transport: Transport,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const id = acquire(p, owner);
  track(p, events);
  try {
    await transport.control(events, signal);
    finish(p, id);
  } catch (e) {
    finish(p, id, true);
    throw e;
  }
}
export function validateJob(raw: JobSpec): JobSpec {
  const integer = (x: unknown, lo: number, hi: number) =>
    Number.isInteger(x) && Number(x) >= lo && Number(x) <= hi;
  if (
    !raw ||
    !["capture", "firmware-entry"].includes(raw.kind) ||
    !integer(raw.duration_ms, 1000, 60000) ||
    !integer(raw.capture_interval_ms, 1000, 10000)
  )
    throw new Error("Job duration 1–60s; capture interval 1–10s.");
  const s: JobSpec = {
    kind: raw.kind,
    duration_ms: raw.duration_ms,
    capture_interval_ms: raw.capture_interval_ms,
  };
  if (raw.kind === "firmware-entry") {
    if (
      !raw.key ||
      !/^([A-Za-z][A-Za-z0-9]{0,39})$/.test(raw.key) ||
      !raw.key_evidence?.trim() ||
      raw.key_evidence.length > 500
    )
      throw new Error("Firmware entry requires a key and its evidence.");
    if (
      !integer(raw.tap_start_ms, 0, 10000) ||
      !integer(raw.tap_interval_ms, 200, 2000) ||
      !integer(raw.tap_duration_ms, 200, 5000) ||
      Number(raw.tap_start_ms) + Number(raw.tap_duration_ms) > raw.duration_ms
    )
      throw new Error(
        "Invalid bounded tap window (maximum 5s, minimum interval 200ms).",
      );
    Object.assign(s, {
      key: raw.key,
      key_evidence: raw.key_evidence,
      tap_start_ms: raw.tap_start_ms,
      tap_interval_ms: raw.tap_interval_ms,
      tap_duration_ms: raw.tap_duration_ms,
    });
  }
  return s;
}
export const summary = (j: Job) => ({
  job_id: j.id,
  device_id: j.profile.id,
  target_identity: j.profile.targetIdentity,
  kind: j.spec.kind,
  state: j.state,
  started_at: j.started_at,
  ended_at: j.ended_at,
  taps: j.taps,
  frames: j.frames.length,
  last_frame: j.frames.at(-1)?.sha256,
  error: j.error,
  artifact_directory: j.directory,
});
const pause = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
export async function startJob(
  p: Profile,
  owner: string,
  spec: JobSpec,
  transport: Transport,
  root: string,
): Promise<Job> {
  spec = validateJob(spec);
  if (spec.kind === "firmware-entry" && !p.inputEnabled)
    throw new Error("HID disabled for this profile.");
  if (
    [...state.jobs.values()].filter((j) => j.state === "running").length +
      state.pending.size >=
    4
  )
    throw new Error("At most four active jobs.");
  if (
    state.pending.has(p.origin) ||
    [...state.jobs.values()].some(
      (j) => j.state === "running" && j.profile.origin === p.origin,
    )
  )
    throw new Error("A job is already active for this device.");
  const id = randomUUID();
  if (spec.kind === "firmware-entry") acquire(p, owner, id);
  state.pending.add(p.origin);
  const directory = join(root, id);
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
  } catch (e) {
    finish(p, id);
    state.pending.delete(p.origin);
    throw e;
  }
  const j: Job = {
    id,
    owner,
    profile: { ...p },
    spec,
    state: "running",
    started_at: new Date().toISOString(),
    frames: [],
    taps: 0,
    abort: new AbortController(),
    directory,
  };
  state.jobs.set(id, j);
  state.pending.delete(p.origin);
  // Keep bounded memory; disk retention is separately managed by pruneArtifacts.
  for (const [old, v] of state.jobs)
    if (state.jobs.size > 100 && v.state !== "running") state.jobs.delete(old);
  void run(j, transport).catch(() => {});
  return j;
}
async function run(j: Job, transport: Transport) {
  const signal = AbortSignal.any([
    j.abort.signal,
    AbortSignal.timeout(j.spec.duration_ms),
  ]);
  const start = performance.now();
  let uncertain = false;
  let failed = false;
  let bytes = 0;
  let nextTap = j.spec.tap_start_ms ?? 0;
  const elapsed = () => performance.now() - start;
  const checkpoint = async () =>
    writeFile(
      join(j.directory, "job.json"),
      JSON.stringify({ ...summary(j), frames: j.frames }),
      { mode: 0o600 },
    );
  const taps = async () => {
    if (j.spec.kind !== "firmware-entry") return;
    const end = nextTap + (j.spec.tap_duration_ms ?? 0);
    while (!signal.aborted && elapsed() < end) {
      if (elapsed() < nextTap) await pause(nextTap - elapsed(), signal);
      if (signal.aborted || elapsed() >= end) break;
      // No catch-up flood after stalled network; next tap is relative to completion.
      const events = combo([j.spec.key!]);
      track(j.profile, events);
      uncertain = true;
      const tapSignal = AbortSignal.any([
        signal,
        AbortSignal.timeout(Math.max(1, Math.floor(end - elapsed()))),
      ]);
      await transport.control(events, tapSignal);
      uncertain = false;
      j.taps++;
      nextTap = elapsed() + j.spec.tap_interval_ms!;
    }
  };
  const captures = async () => {
    while (!signal.aborted) {
      try {
        const frame = await transport.snapshot(signal);
        if (signal.aborted) break;
        bytes += frame.length;
        if (bytes > 32 * 1024 * 1024)
          throw new Error("Job evidence exceeds 32 MiB.");
        const file = `frame-${String(j.frames.length).padStart(3, "0")}.jpg`;
        await writeFile(join(j.directory, file), frame, { mode: 0o600 });
        j.frames.push({
          at_ms: Math.round(elapsed()),
          sha256: createHash("sha256").update(frame).digest("hex"),
          file,
        });
        await checkpoint();
      } catch {
        if (!signal.aborted) throw new Error("Capture failed; job stopped.");
      }
      await pause(j.spec.capture_interval_ms, signal);
    }
  };
  try {
    await checkpoint();
    const work = [taps(), captures()];
    try {
      await Promise.all(work);
    } catch (e) {
      failed = true;
      j.abort.abort();
      await Promise.allSettled(work);
      throw e;
    }
    j.state = j.abort.signal.aborted ? "cancelled" : "completed";
  } catch {
    j.state =
      !failed && j.abort.signal.aborted && !uncertain ? "cancelled" : "failed";
    j.error = uncertain
      ? "Input delivery uncertain; observe and input.release before further control."
      : "Job interrupted by transport or storage failure.";
  } finally {
    j.ended_at = new Date().toISOString();
    finish(j.profile, j.id, uncertain);
    await checkpoint().catch(() => {});
  }
}
export function ownedJob(id: string, owner: string) {
  const j = state.jobs.get(id);
  if (!j || j.owner !== owner)
    throw new Error(
      "Unknown job for this chat (jobs are not replayed after restart).",
    );
  return j;
}
export async function pruneArtifacts(root: string) {
  // Only owned UUID directories; never follow symlinks or delete active jobs.
  await mkdir(root, { recursive: true, mode: 0o700 });
  const rows = [];
  for (const d of await readdir(root, { withFileTypes: true })) {
    if (!d.isDirectory() || !/^[0-9a-f-]{36}$/.test(d.name)) continue;
    const p = join(root, d.name);
    rows.push({ id: d.name, path: p, mtime: (await stat(p)).mtimeMs });
  }
  rows.sort((a, b) => b.mtime - a.mtime);
  for (let i = 0; i < rows.length; i++)
    if (
      (i >= 20 || Date.now() - rows[i].mtime > 86400000) &&
      state.jobs.get(rows[i].id)?.state !== "running"
    )
      await rm(rows[i].path, { recursive: true });
}
