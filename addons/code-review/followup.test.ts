import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ReviewService } from "./dispatch.js";
import type { ReviewIdentity, WorkState } from "./contracts.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "review-followup-"));
  let store = new ReviewService(join(root, "reviews.db"));
  const who: ReviewIdentity = { ownerId: "owner", actorId: "human", kind: "operator", workspaceId: "workspace" };
  const target = { chatId: "web:worker", incarnation: "life", label: "Worker" };
  const baseAgent: ReviewIdentity = { ...who, actorId: "agent", kind: "agent", chatId: target.chatId, chatIncarnation: target.incarnation };
  let n = 0, calls = 0;
  const mut = (expectedVersion?: number, requestId = `req-${++n}`) => ({ expectedVersion, requestId });
  const review = store.createFromCapture(who, { title: "Review", focusPath: "a.ts", target }, { workspaceId: "workspace", worktreeId: "tree", mode: "source", base: null, head: null, capturedAt: new Date().toISOString(), files: [{ oldPath: null, newPath: "a.ts", change: "source", oldText: null, newText: "one\ntwo\n" }] }, mut());
  const a = store.createThread(who, review.reviewId, { fileId: review.files[0], side: "source", body: "Check one" }, mut());
  const b = store.createThread(who, review.reviewId, { fileId: review.files[0], side: "source", body: "Check two" }, mut());
  const selection = (ids = [a.threadId]) => ({ target, items: ids.map(threadId => ({ threadId, version: store.getThread(who, threadId).version })) });
  const submit = (ids?: string[], key?: string) => store.submit(who, review.reviewId, selection(ids), mut(undefined, key));
  const deliver = (id: string, outcome = "accepted") => store.deliver(who, id, { async enqueue(input) { calls++; expect(input.mode).toBe("queue"); if (outcome === "unknown") throw Error("lost receipt"); if (outcome === "rejected") throw Object.assign(Error("unavailable"), { delivery: "rejected" }); return { status: "accepted", rowId: calls }; } });
  const agent = (dispatchId: string): ReviewIdentity => ({ ...baseAgent, reference: { addonId: "code-review", intentId: dispatchId } });
  const reply = (threadId = a.threadId, body = "My answer") => store.reply(who, threadId, body, mut(store.getThread(who, threadId).version));
  const work = (dispatchId: string, state: WorkState) => store.updateWork(agent(dispatchId), dispatchId, a.threadId, { state, itemVersion: 1, threadVersion: store.getThread(who, a.threadId).version, assignmentEpoch: 1 }, mut());
  return { get store() { return store; }, who, target, review, a, b, mut, selection, submit, deliver, agent, reply, work, get calls() { return calls; }, reopen() { store.close(); store = new ReviewService(join(root, "reviews.db")); }, cleanup() { store.close(); rmSync(root, { recursive: true, force: true }); } };
}

for (const state of ["not_started", "in_progress", "waiting_user", "blocked", "completed", "failed"] as const) {
  test(`saved follow-up queues after accepted ${state} work without duplicate dispatch`, async () => {
    const f = fixture();
    try {
      const first = f.submit(); await f.deliver(first.dispatchId);
      if (state !== "not_started") f.work(first.dispatchId, state);
      f.reply();
      expect(f.store.listThreads(f.who, f.review.reviewId).find(t => t.id === f.a.threadId)!.summary.hasUnsentGuidance).toBe(true);
      const input = f.selection();
      const next = f.store.submit(f.who, f.review.reviewId, input, f.mut(undefined, "follow-up"));
      expect(f.store.submit(f.who, f.review.reviewId, input, f.mut(undefined, "follow-up"))).toEqual(next);
      await Promise.all([f.deliver(next.dispatchId), f.deliver(next.dispatchId)]);
      expect(f.calls).toBe(2);
      expect(f.store.getThread(f.agent(next.dispatchId), f.a.threadId).messages.at(-1)!.body).toBe("My answer");
      expect(() => f.store.getThread(f.agent(first.dispatchId), f.a.threadId)).toThrow("unavailable");
      expect(f.store.inspectDispatch(f.agent(first.dispatchId), first.dispatchId).items[0]).toMatchObject({ unavailable: true, work_state: "superseded" });
      expect(() => f.submit()).toThrow("already sent");
      f.reopen();
      expect(() => f.submit()).toThrow("already sent");
      expect(f.store.listThreads(f.who, f.review.reviewId).find(t => t.id === f.a.threadId)!.summary.hasUnsentGuidance).toBe(false);
    } finally { f.cleanup(); }
  });
}

test("agent replies alone do not make sent guidance new; edit and reopen do", async () => {
  const f = fixture();
  try {
    const first = f.submit(); await f.deliver(first.dispatchId);
    f.store.reply(f.agent(first.dispatchId), f.a.threadId, "What should this do?", f.mut(1), 1);
    expect(() => f.submit()).toThrow("already sent");
    f.store.editMessage(f.who, f.a.messageId, "Changed instruction", f.mut(1));
    const next = f.submit(); await f.deliver(next.dispatchId);
    f.store.resolveThread(f.who, f.a.threadId, { explanation: "Done", fileId: f.review.files[0] }, f.mut(f.store.getThread(f.who, f.a.threadId).version));
    expect(() => f.submit()).toThrow("Only open");
    f.store.reopen(f.who, f.a.threadId, f.mut(f.store.getThread(f.who, f.a.threadId).version));
    const resumed = f.submit(); await f.deliver(resumed.dispatchId);
    expect(f.calls).toBe(3);
  } finally { f.cleanup(); }
});

test("unknown/prepared/attempting receipt blocks new sends but not saved discussion", async () => {
  for (const state of ["prepared", "attempting", "unknown"] as const) {
    const f = fixture();
    try {
      const first = f.submit();
      if (state === "unknown") await f.deliver(first.dispatchId, "unknown");
      let release!: () => void;
      let running: Promise<unknown> | undefined;
      if (state === "attempting") running = f.store.deliver(f.who, first.dispatchId, { async enqueue() { await new Promise<void>(r => { release = r; }); return { status: "accepted", rowId: 1 }; } });
      try { f.reply(); expect(() => f.submit()).toThrow(state === "unknown" ? "no confirmed delivery" : "still being delivered"); }
      finally { if (running) { release(); await running; } }
      if (state === "unknown") {
        f.store.reconcile(f.who, first.dispatchId, { attemptId: first.attemptId, decision: "accepted", evidence: "Confirmed receipt" }, f.mut());
        await f.deliver(f.submit().dispatchId);
      }
    } finally { f.cleanup(); }
  }
});

test("rejected follow-up does not revoke old authority; unknown follow-up does", async () => {
  for (const outcome of ["rejected", "unknown"]) {
    const f = fixture();
    try {
      const first = f.submit(); await f.deliver(first.dispatchId); f.reply();
      const next = f.submit(); await f.deliver(next.dispatchId, outcome);
      if (outcome === "rejected") {
        expect(f.store.getThread(f.agent(first.dispatchId), f.a.threadId).id).toBe(f.a.threadId);
        f.store.retry(f.who, next.dispatchId, f.mut()); await f.deliver(next.dispatchId);
        expect(() => f.store.getThread(f.agent(first.dispatchId), f.a.threadId)).toThrow("unavailable");
      } else expect(() => f.store.getThread(f.agent(first.dispatchId), f.a.threadId)).toThrow("unavailable");
    } finally { f.cleanup(); }
  }
});

test("partial-batch follow-up replaces only selected items; stale agent cannot resolve or finish them", async () => {
  const f = fixture();
  try {
    const first = f.submit([f.a.threadId, f.b.threadId]); await f.deliver(first.dispatchId); f.reply();
    expect(() => f.submit([f.a.threadId, f.b.threadId])).toThrow("already sent");
    const next = f.submit(); await f.deliver(next.dispatchId);
    expect(f.store.listScopedThreads(f.agent(first.dispatchId), first.dispatchId).map(t => t.id)).toEqual([f.b.threadId]);
    expect(f.store.getThread(f.agent(first.dispatchId), f.b.threadId).id).toBe(f.b.threadId);
    expect(() => f.store.resolveThread(f.agent(first.dispatchId), f.a.threadId, { fileId: f.review.files[0], explanation: "stale", assignmentEpoch: 1 }, f.mut(2))).toThrow("unavailable");
    expect(() => f.work(first.dispatchId, "completed")).toThrow("newer submission");
    f.work(first.dispatchId, "superseded");
    expect(f.calls).toBe(2);
  } finally { f.cleanup(); }
});

test("a newer prepared send prevents retrying the rejected predecessor", async () => {
  const f = fixture();
  try {
    const first = f.submit(); await f.deliver(first.dispatchId, "rejected");
    const newer = f.submit();
    expect(() => f.store.retry(f.who, first.dispatchId, f.mut())).toThrow("prepare a new explicit send");
    await f.deliver(newer.dispatchId);
    expect(f.calls).toBe(2);
  } finally { f.cleanup(); }
});

test("reply-and-send commits one follow-up atomically and stale concurrent submits lose", async () => {
  const f = fixture();
  try {
    const first = f.submit(); await f.deliver(first.dispatchId);
    const input = f.selection();
    const next = f.store.replyAndSubmit(f.who, f.a.threadId, "Continue with this", f.target, f.mut(1, "reply-send"));
    expect(f.store.replyAndSubmit(f.who, f.a.threadId, "Continue with this", f.target, f.mut(1, "reply-send"))).toEqual(next);
    expect(() => f.store.submit(f.who, f.review.reviewId, input, f.mut())).toThrow("record changed");
    expect(() => f.submit()).toThrow("still being delivered");
    await f.deliver(next.dispatchId);
    expect(f.store.getThread(f.who, f.a.threadId).messages).toHaveLength(2);
    expect(f.calls).toBe(2);
  } finally { f.cleanup(); }
});
