import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PeerService } from "./service.js";
import { PeerState } from "./state.js";

function runtime(enqueue?: (request: any) => Promise<any>) {
  return {
    messaging: {
      version: 1,
      listAdvertisableAgents: async () => [],
      deliverPeerMessage: async () => ({}),
    },
    enqueueAgentMessage: enqueue,
  } as any;
}

test("failed work notification retries the same terminal result exactly once and rejects conflicts", async () => {
  const root = mkdtempSync(join(tmpdir(), "iroh-work-recovery-"));
  let attempts = 0,
    delivered = 0;
  const service = new PeerService({
    dataDir: root,
    runtime: runtime(async () => {
      attempts++;
      if (attempts === 1) throw new Error("queue unavailable");
      delivered++;
    }),
  });
  try {
    const peer = "22".repeat(32),
      id = "work-result";
    service.state.db.query("INSERT INTO work VALUES (?,?,?,?,?)").run(
      id,
      peer,
      "outbound",
      "pending",
      JSON.stringify({
        prompt: "p",
        type: "execute",
        capabilities: ["review"],
        chat: "web:test",
      }),
    );
    const body = {
      id,
      status: "completed",
      result: "reviewed",
      capabilities: ["review"],
    };
    await expect(
      (service as any).receiveWorkResult({ id: peer }, body),
    ).rejects.toThrow("queue unavailable");
    expect(
      service.state.db.query("SELECT status FROM work WHERE id=?").get(id),
    ).toEqual({ status: "notification-pending" });
    await expect(
      (service as any).receiveWorkResult(
        { id: peer },
        { ...body, result: "different" },
      ),
    ).rejects.toThrow("Conflicting");
    await (service as any).receiveWorkResult({ id: peer }, body);
    await (service as any).receiveWorkResult({ id: peer }, body);
    expect(attempts).toBe(2);
    expect(delivered).toBe(1);
    expect(
      service.state.db.query("SELECT status FROM work WHERE id=?").get(id),
    ).toEqual({ status: "completed" });
  } finally {
    await service.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("restart marks an in-flight work notification unknown and never blindly replays it", async () => {
  const root = mkdtempSync(join(tmpdir(), "iroh-work-unknown-"));
  try {
    const first = new PeerState(root);
    first.db.query("INSERT INTO work VALUES (?,?,?,?,?)").run(
      "w",
      "33".repeat(32),
      "outbound",
      "notification-delivering",
      JSON.stringify({
        capabilities: [],
        chat: "web:test",
        terminal: { status: "completed", result: "ok", capabilities: [] },
      }),
    );
    first.close();
    const next = new PeerState(root);
    expect(next.db.query("SELECT status FROM work WHERE id='w'").get()).toEqual(
      { status: "notification-unknown" },
    );
    next.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
