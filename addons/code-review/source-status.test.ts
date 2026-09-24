import { expect, test } from "bun:test";
import { mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReviewService } from "./dispatch.js";
import { SourceReader } from "./source.js";
import { reviewAction } from "./runtime.js";
import type { LocalContext } from "./host.js";

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "review-current-source-"));
  const service = new ReviewService(join(dir, "review.db"));
  const path = join(dir, "source.ts");
  writeFileSync(path, "const original = 1;\n");
  const who = { ownerId: "owner", actorId: "human", kind: "operator" as const, workspaceId: "workspace" };
  const target = { chatId: "web:worker", incarnation: "branch1", label: "Worker" };
  const reader = new SourceReader(dir, who.workspaceId);
  const capture = await reader.capture({ mode: "source", path: "source.ts" });
  const review = service.createFromCapture(who, { title: "Review", focusPath: "source.ts", target }, capture, { requestId: "create" });
  const thread = service.createThread(who, review.reviewId, { fileId: review.files[0]!, side: "source", range: { startLine: 1, endLine: 1 }, body: "Please check original" }, { requestId: "comment" });
  const dispatch = service.submit(who, review.reviewId, { target, items: [{ threadId: thread.threadId, version: 1 }] }, { requestId: "send" });
  await service.deliver(who, dispatch.dispatchId, { async enqueue() { return { status: "accepted", rowId: 1 }; } });
  const hostTarget = { chatJid: target.chatId, incarnation: target.incarnation, label: target.label, agentName: "worker", active: false };
  const ctx: LocalContext = {
    version: 1, accessMode: "single-user", ownerId: who.ownerId, actorId: "branch1", kind: "agent",
    workspaceRoot: dir, workspaceId: who.workspaceId, chatJid: target.chatId, chatIncarnation: target.incarnation,
    async listTargets() { return [hostTarget]; },
    async resolveTarget() { return hostTarget; },
    async enqueue() { throw Error("unexpected agent dispatch"); },
  };
  return { dir, path, service, who, ctx, review, thread, reader, cleanup() { service.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test("CR-035 agent reads latest authorised guidance and saved-source status without modifying the snapshot", async () => {
  const f = await fixture();
  try {
    const read = () => reviewAction(f.ctx, "thread", { threadId: f.thread.threadId }, f.service) as Promise<any>;
    const original = await read();
    expect(original.currentSource.status).toBe("unchanged");
    expect(original.currentSource).not.toHaveProperty("savedHash");
    f.service.reply(f.who, f.thread.threadId, "Use the revised guidance", { requestId: "guidance", expectedVersion: 1 });
    writeFileSync(f.path, "const updated = 2;\n");
    const next = await read();
    expect(next.version).toBe(2);
    expect(next.messages.at(-1).body).toBe("Use the revised guidance");
    expect(next.currentSource.status).toBe("changed");
    expect(next.currentSource).not.toHaveProperty("snapshotHash");
    expect(JSON.stringify(next.currentSource)).not.toContain("const updated");
    expect(next.anchor).toEqual(original.anchor);
    expect(f.service.readFile(f.who, f.review.reviewId, f.review.files[0]!).newText).toBe("const original = 1;\n");
    expect(f.service.listSnapshots(f.who, f.review.reviewId)).toHaveLength(1);
  } finally { f.cleanup(); }
});

test("agent source status distinguishes same-byte replacement and missing file, and refuses symlinks", async () => {
  const f = await fixture();
  try {
    const read = () => reviewAction(f.ctx, "thread", { threadId: f.thread.threadId }, f.service) as Promise<any>;
    renameSync(f.path, join(f.dir, "prior.ts"));
    writeFileSync(f.path, "const original = 1;\n");
    expect((await read()).currentSource.status).toBe("replaced");
    rmSync(f.path);
    expect((await read()).currentSource.status).toBe("missing");
    symlinkSync(join(f.dir, "prior.ts"), f.path);
    const unavailable = (await read()).currentSource;
    expect(unavailable.status).toBe("unavailable");
    expect(unavailable.reason).toBe("unsafe_path");
    expect(unavailable).not.toHaveProperty("savedHash");
  } finally { f.cleanup(); }
});

test("current-source helper refuses traversal and caps binary/oversized inspection without leaking bytes", async () => {
  const f = await fixture();
  try {
    expect(f.reader.currentStatus("../secret", null, null).status).toBe("unavailable");
    expect(f.reader.currentStatus("source.ts", null, null).status).toBe("unverified");
    writeFileSync(f.path, Buffer.from([0, 255, 1]));
    expect(f.reader.currentStatus("source.ts", null, null).reason).toBe("unsupported");
    writeFileSync(f.path, "x".repeat(2 * 1024 * 1024 + 1));
    expect(f.reader.currentStatus("source.ts", null, null).reason).toBe("limit");
  } finally { f.cleanup(); }
});

test("agent thread status fails closed if scope expires or assignment changes during inspection", async () => {
  const f = await fixture();
  try {
    let checks = 0;
    const expired = { ...f.ctx, async listTargets() { if (++checks > 1) throw Error("scope revoked"); return f.ctx.listTargets(); } };
    await expect(reviewAction(expired, "thread", { threadId: f.thread.threadId }, f.service)).rejects.toThrow("scope revoked");
    checks = 0;
    const reassigned = { ...f.ctx, async listTargets() {
      if (++checks === 1) f.service.reassign(f.who, f.thread.threadId, { chatId: "web:other", incarnation: "branch2", label: "Other" }, { requestId: "reassign", expectedVersion: 1 });
      return f.ctx.listTargets();
    } };
    await expect(reviewAction(reassigned, "thread", { threadId: f.thread.threadId }, f.service)).rejects.toThrow("unavailable");
  } finally { f.cleanup(); }
});

test("agent discussion fetch reads guidance updated during async host validation", async () => {
  const f = await fixture();
  try {
    let checks = 0;
    const updated = { ...f.ctx, async listTargets() {
      if (++checks === 2) f.service.reply(f.who, f.thread.threadId, "Guidance changed mid-request", { requestId: "mid-read", expectedVersion: 1 });
      return f.ctx.listTargets();
    } };
    const thread: any = await reviewAction(updated, "thread", { threadId: f.thread.threadId }, f.service);
    expect(thread.version).toBe(2);
    expect(thread.messages.at(-1).body).toBe("Guidance changed mid-request");
  } finally { f.cleanup(); }
});
