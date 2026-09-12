import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import {
  getProfile,
  loadConfig,
  selectProfile,
  registerConfigApi,
} from "./config.js";
import { getChatJid } from "./compat/chat-context.js";
import { LinkrClient } from "./client.js";
import { validate, textEvents, combo, click, type Event } from "./input.js";
import {
  state,
  send,
  ownedJob,
  startJob,
  summary,
  validateJob,
  pruneArtifacts,
  type JobSpec,
} from "./jobs.js";
export const actions = [
  "help",
  "capabilities",
  "profile.list",
  "profile.select",
  "status",
  "snapshot",
  "key.tap",
  "key.combo",
  "key.repeat",
  "text",
  "mouse.move",
  "mouse.click",
  "mouse.drag",
  "mouse.scroll",
  "input.batch",
  "input.release",
  "job.start",
  "job.status",
  "job.cancel",
  "reboot.plan",
  "firmware.entry.plan",
  "power.status",
  "power.press",
  "power.reset",
  "power.cycle",
  "media.list",
  "media.mount",
  "media.eject",
  "device.reboot",
] as const;
const number = () => Type.Optional(Type.Number());
export const Parameters = Type.Object({
  action: Type.String({ enum: actions }),
  device_id: Type.Optional(Type.String()),
  execute: Type.Optional(Type.Boolean()),
  key: Type.Optional(Type.String()),
  keys: Type.Optional(Type.Array(Type.String())),
  text: Type.Optional(Type.String()),
  x: number(),
  y: number(),
  to_x: number(),
  to_y: number(),
  wheel_y: number(),
  wheel_x: number(),
  count: number(),
  interval_ms: number(),
  events: Type.Optional(Type.Array(Type.Array(Type.Unknown()))),
  job_id: Type.Optional(Type.String()),
  frame_index: number(),
  job: Type.Optional(
    Type.Object({
      kind: Type.String({ enum: ["capture", "firmware-entry"] }),
      duration_ms: Type.Number(),
      capture_interval_ms: Type.Number(),
      key: Type.Optional(Type.String()),
      key_evidence: Type.Optional(Type.String()),
      tap_start_ms: number(),
      tap_interval_ms: number(),
      tap_duration_ms: number(),
    }),
  ),
});
type Params = {
  action: string;
  device_id?: string;
  execute?: boolean;
  key?: string;
  keys?: string[];
  text?: string;
  x?: number;
  y?: number;
  to_x?: number;
  to_y?: number;
  wheel_y?: number;
  wheel_x?: number;
  count?: number;
  interval_ms?: number;
  events?: Event[];
  job_id?: string;
  frame_index?: number;
  job?: JobSpec;
};
export function buildEvents(p: Params): Event[] {
  let e: Event[];
  switch (p.action) {
    case "key.tap":
      if (!p.key) throw new Error("key required.");
      e = combo([p.key]);
      break;
    case "key.combo":
      if (!p.keys?.length) throw new Error("keys required.");
      e = combo(p.keys);
      break;
    case "key.repeat": {
      if (
        !p.key ||
        !Number.isInteger(p.count) ||
        p.count! < 1 ||
        p.count! > 20 ||
        !Number.isInteger(p.interval_ms) ||
        p.interval_ms! < 200 ||
        p.interval_ms! > 1000 ||
        p.count! * p.interval_ms! > 5000
      )
        throw new Error(
          "Repeat requires key, count 1–20, interval 200–1000ms, total at most 5s.",
        );
      e = Array.from({ length: p.count! }, () => [
        ...combo([p.key!]),
        ["delay", p.interval_ms!] as Event,
      ]).flat();
      break;
    }
    case "text":
      e = textEvents(p.text ?? "");
      break;
    case "mouse.move":
      e = [["mouse_abs", 0, p.x!, p.y!, 0, 0]];
      break;
    case "mouse.click":
      e = click(p.x!, p.y!);
      break;
    case "mouse.drag":
      e = [
        ["mouse_abs", 0, p.x!, p.y!, 0, 0],
        ["mouse_abs", 1, p.x!, p.y!, 0, 0],
        ["delay", 80],
        ["mouse_abs", 1, p.to_x!, p.to_y!, 0, 0],
        ["delay", 80],
        ["mouse_abs", 0, p.to_x!, p.to_y!, 0, 0],
      ];
      break;
    case "mouse.scroll":
      e = [["mouse_rel", 0, 0, 0, p.wheel_y ?? 0, p.wheel_x ?? 0]];
      break;
    case "input.batch":
      e = p.events ?? [];
      break;
    default:
      throw new Error("Unknown input action.");
  }
  return validate({ events: e }).events;
}
const capabilities = {
  snapshot: "documented; prototype live-verified",
  hid: "documented; mock-tested",
  jobs: "local bounded capture and operator-assisted firmware-entry",
  power: "unsupported: API not verified",
  media: "unsupported: API not verified",
  device_reboot: "unsupported: API not verified",
  os_reboot: "operator-assisted; no universal HID reboot command",
};
const json = (d: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(d) }],
  details: d,
});
const image = (b: Buffer, d: unknown) => ({
  content: [
    { type: "text" as const, text: JSON.stringify(d) },
    {
      type: "image" as const,
      data: b.toString("base64"),
      mimeType: "image/jpeg",
    },
  ],
  details: d,
});
export async function dispatch(p: Params, owner: string, signal?: AbortSignal) {
  if (!actions.includes(p.action as any))
    throw new Error("Unsupported action.");
  if (p.action === "help")
    return json({
      actions,
      usage:
        "Configure named profiles in Settings → Linkr, select device_id, snapshot before input. HID and job.start preview by default; execute:true sends. Firmware jobs start NOW, anchored to operator-assisted reboot, never reboot a device. Only job.status returns captured frames when frame_index is explicitly supplied. Use bundled skills for BIOS and installers.",
      limits: {
        job_ms: 60000,
        tap_window_ms: 5000,
        capture_interval_min_ms: 1000,
      },
      capabilities,
    });
  if (p.action === "capabilities") return json(capabilities);
  if (p.action === "profile.list") return json(loadConfig());
  if (p.action === "profile.select") {
    selectProfile(p.device_id ?? "", owner);
    return json({ selected: p.device_id });
  }
  if (p.action === "job.status" || p.action === "job.cancel") {
    const j = ownedJob(p.job_id ?? "", owner);
    if (p.action === "job.cancel") {
      j.abort.abort();
      return json({
        ...summary(j),
        cancellation_requested: true,
        warning:
          "Future events are stopping. Check job.status; an in-flight input may require input.release.",
      });
    }
    if (p.action === "job.status" && p.frame_index !== undefined) {
      if (!Number.isInteger(p.frame_index) || !j.frames[p.frame_index])
        throw new Error("Unknown frame index.");
      return image(
        await readFile(join(j.directory, j.frames[p.frame_index].file)),
        summary(j),
      );
    }
    return json(summary(j));
  }
  const profile = getProfile(p.device_id, owner),
    client = new LinkrClient(profile);
  const identity = {
    device_id: profile.id,
    target_identity: profile.targetIdentity,
  };
  if (
    p.action.startsWith("power.") ||
    p.action.startsWith("media.") ||
    p.action === "device.reboot"
  )
    return json({
      ...identity,
      ok: false,
      outcome: "unsupported",
      reason:
        "No verified API adapter. Use supported platform tools or operator assistance; no request sent.",
    });
  if (p.action === "reboot.plan")
    return json({
      ...identity,
      execute_supported: false,
      methods: [
        "observed OS interface using individually approved HID steps",
        "operator-assisted physical reboot",
        "separately authorised SSH/Proxmox integration",
      ],
      warnings: [
        "Rebooting Linkr is distinct from rebooting the attached machine.",
        "No automatic Ctrl+Alt+Delete, ATX or power-cycle fallback.",
        "Check updates, writes and recovery keys first.",
      ],
    });
  if (p.action === "status") {
    await client.snapshot(signal);
    return json({
      ...identity,
      snapshot_reachable: true,
      power_state: "unknown",
      input_enabled: profile.inputEnabled,
      control_busy: state.leases.has(profile.origin),
      captured_at: new Date().toISOString(),
    });
  }
  if (p.action === "snapshot")
    return image(await client.snapshot(signal), {
      ...identity,
      captured_at: new Date().toISOString(),
      freshness: "new HTTP capture; source-frame freshness unverified",
    });
  if (p.action === "job.start" || p.action === "firmware.entry.plan") {
    const spec = validateJob(p.job!);
    if (!p.execute || p.action === "firmware.entry.plan")
      return json({
        ...identity,
        dry_run: true,
        job: spec,
        anchor: "local start time; operator-assisted reboot only",
        warning:
          "No semantic BIOS detector. Tap burst ends without waiting for model interpretation.",
      });
    const root = join(
      process.env.PICLAW_WORKSPACE || process.cwd(),
      ".piclaw",
      "data",
      "addons",
      "linkr",
      "jobs",
    );
    await pruneArtifacts(root);
    const j = await startJob(profile, owner, spec, client, root);
    return json({
      ...summary(j),
      warning:
        "Bounded local job continues after tool returns. Use job.cancel to stop; no automatic resume after restart.",
    });
  }
  if (p.action === "input.release") {
    const l = state.leases.get(profile.origin);
    if (!l || l.owner !== owner || !l.uncertain)
      throw new Error("No uncertain input owned by this chat.");
    if (!p.execute)
      return json({
        ...identity,
        dry_run: true,
        tracked_keys: l.keys.size,
        mouse: l.mouse,
      });
    await client.release([...l.keys], l.mouse, signal);
    state.leases.delete(profile.origin);
    return json({
      ...identity,
      outcome: "release_acknowledged",
      verify: "Observe screen before further actions.",
    });
  }
  const events = buildEvents(p);
  if (!p.execute)
    return json({
      ...identity,
      dry_run: true,
      event_count: events.length,
      has_newline: events.some(
        (e) => e[0] === "text" && String(e[1]).includes("\n"),
      ),
      input_enabled: profile.inputEnabled,
    });
  if (!profile.inputEnabled)
    throw new Error(
      "HID disabled for this profile. Enable deliberately in Settings.",
    );
  await send(profile, owner, events, client, signal);
  return json({
    ...identity,
    outcome: "acknowledged",
    verification:
      "Capture and inspect a fresh screenshot; acknowledgement does not prove the intended application result.",
  });
}
registerConfigApi();
export default function extension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "linkr",
    label: "Linkr",
    description:
      "Observe and control an explicitly selected Radxa Linkr KVM. Named keychain-backed profiles, screenshots, bounded HID and firmware-entry jobs; BIOS/installation decisions belong to bundled skills. Read help/capabilities first. execute:true is explicit intent, NOT proof of human approval. Never guess disks, reboot methods or BIOS keys.",
    parameters: Parameters,
    async execute(_id, params, signal) {
      try {
        return await dispatch(params as Params, getChatJid(), signal);
      } catch {
        return {
          content: [
            {
              type: "text" as const,
              text: "Linkr action failed. Check parameters/profile and job.status. If input was sent, delivery may be uncertain: observe, then input.release if needed; never blindly retry. No secrets or remote error text are returned.",
            },
          ],
          details: { ok: false },
          isError: true,
        };
      }
    },
  });
}
