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

test("work notification retries only a provably unentered enqueue and rejects conflicting results", async () => {
  const root = mkdtempSync(join(tmpdir(), "iroh-work-recovery-"));
  let attempts = 0,
    delivered = 0;
  const host = runtime();
  const service = new PeerService({ dataDir: root, runtime: host });
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
    ).rejects.toThrow("enqueue API is unavailable");
    expect(
      service.state.db.query("SELECT status FROM work WHERE id=?").get(id),
    ).toEqual({ status: "notification-pending" });
    await expect(
      (service as any).receiveWorkResult(
        { id: peer },
        { ...body, result: "different" },
      ),
    ).rejects.toThrow("Conflicting");
    host.enqueueAgentMessage = async () => { attempts++; delivered++; };
    await (service as any).receiveWorkResult({ id: peer }, body);
    await (service as any).receiveWorkResult({ id: peer }, body);
    expect(attempts).toBe(1);
    expect(delivered).toBe(1);
    expect(
      service.state.db.query("SELECT status FROM work WHERE id=?").get(id),
    ).toEqual({ status: "completed" });
    const dashboard = await service.dashboard();
    expect(dashboard.work[0].data).toMatchObject({
      result: "reviewed",
      terminal_status: "completed",
      notification_delivered: true,
    });
  } finally {
    await service.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("entered enqueue failure is retained as unknown across reopen and never blindly repeated", async () => {
  const root = mkdtempSync(join(tmpdir(), 'iroh-work-entered-'));
  let calls = 0;
  const host = runtime(async () => { calls++; throw Error('acknowledgement lost after entry'); });
  let service = new PeerService({ dataDir: root, runtime: host });
  const peer = '55'.repeat(32), body = { id: 'entered', status: 'completed', result: 'retained', capabilities: [] };
  try {
    service.state.db.query('INSERT INTO work VALUES (?,?,?,?,?)').run('entered', peer, 'outbound', 'pending', JSON.stringify({ capabilities: [], chat: 'web:fixture' }));
    await expect((service as any).receiveWorkResult({ id: peer }, body)).rejects.toThrow('acknowledgement lost');
    expect(service.state.db.query("SELECT status FROM work WHERE id='entered'").get()).toEqual({ status: 'notification-unknown' });
    await expect((service as any).receiveWorkResult({ id: peer }, body)).rejects.toThrow('outcome is unknown');
    expect(calls).toBe(1);
    await service.close(); service = new PeerService({ dataDir: root, runtime: host });
    await expect((service as any).receiveWorkResult({ id: peer }, body)).rejects.toThrow('outcome is unknown');
    expect(calls).toBe(1);
    expect(JSON.parse((service.state.db.query("SELECT data FROM work WHERE id='entered'").get() as any).data).terminal).toEqual({ status: 'completed', result: 'retained', capabilities: [] });
  } finally { await service.close(); rmSync(root, { recursive: true, force: true }); }
});

test("terminal work result remains visible without an origin chat", async () => {
  const root = mkdtempSync(join(tmpdir(), "iroh-work-visible-"));
  const service = new PeerService({ dataDir: root, runtime: runtime() });
  try {
    const peer = "44".repeat(32);
    service.state.db
      .query("INSERT INTO work VALUES (?,?,?,?,?)")
      .run(
        "visible",
        peer,
        "outbound",
        "pending",
        JSON.stringify({
          prompt: "p",
          type: "proposal",
          capabilities: [],
          chat: "",
        }),
      );
    await (service as any).receiveWorkResult(
      { id: peer },
      {
        id: "visible",
        status: "completed",
        result: "visible result",
        capabilities: [],
      },
    );
    const row = (await service.dashboard()).work[0];
    expect(row.status).toBe("completed");
    expect(row.data).toMatchObject({
      result: "visible result",
      terminal_status: "completed",
    });
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
