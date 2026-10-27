import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { ReviewService } from "./dispatch.js";
import { createCodeReviewTool, type CodeReviewReadAuthority } from "./tool.js";
import { runCodeReviewMutation } from "./runtime.js";
import type { ReviewIdentity, SourceCapture } from "./contracts.js";

/** Isolated native adapter qualification: no ambient runtime setter, session,
 * mocked service writes, scheduler or actual host enqueue. */
async function fixture(action: "reply" | "work") {
  const root = new Database(":memory:");
  root.exec("PRAGMA foreign_keys=ON; CREATE TABLE host_marker(value TEXT); INSERT INTO host_marker VALUES('preserve')");
  let current = true;
  const assertCurrent = () => { if (!current) throw Error("owner revoked"); };
  const service = new ReviewService({ database: root, assertOwner: assertCurrent });
  const operator: ReviewIdentity = { ownerId: "owner", actorId: "operator", kind: "operator", workspaceId: "workspace" };
  const target = { chatId: "web:worker", incarnation: "branch", label: "Worker" };
  const capture: SourceCapture = {
    workspaceId: "workspace", worktreeId: "tree", mode: "source", base: null, head: null,
    capturedAt: new Date().toISOString(),
    files: [{ oldPath: null, newPath: "a.ts", oldText: null, newText: "const n = 1;\n", change: "source", fileIdentity: "inode" }],
  };
  const review = service.createFromCapture(operator, { title: "Native rollback", focusPath: "a.ts", target }, capture, { requestId: "create" });
  const thread = service.createThread(operator, review.reviewId, {
    fileId: review.files[0]!, side: "source", body: "Review this",
  }, { requestId: "thread" });
  const dispatch = service.submit(operator, review.reviewId, {
    target, items: [{ threadId: thread.threadId, version: 1 }],
  }, { requestId: "dispatch" });
  const delivered = await service.deliver(operator, dispatch.dispatchId, {
    async enqueue() { return { status: "accepted", rowId: 1 }; },
  });
  expect(delivered.attempts[0]!.state).toBe("accepted");
  const identity: ReviewIdentity = {
    ...operator, actorId: "trusted-agent", kind: "agent", chatId: target.chatId,
    chatIncarnation: target.incarnation, reference: { addonId: "code-review", intentId: dispatch.dispatchId },
  };
  expect(service.agentDispatchScope(identity, dispatch.dispatchId).threadIds).toEqual([thread.threadId]);
  let afterCallback = () => {};
  let writes = 0;
  const authority: CodeReviewReadAuthority = {
    service, identity, workspaceRoot: "/unused-native-review", assertCurrent,
    write<T>(body: () => T): T {
      writes++;
      return root.transaction(() => {
        assertCurrent();
        const result = body();
        afterCallback();
        assertCurrent();
        return result;
      }).immediate();
    },
  };
  const snapshot = () => {
    const names = root.query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[];
    return names.map(({ name }) => [name, root.query(`SELECT * FROM "${name}"`).all()]);
  };
  const params = action === "reply"
    ? { action, threadId: thread.threadId, body: "Native reply", expectedVersion: 1, assignmentEpoch: 1, requestId: "native-reply" }
    : { action, dispatchId: dispatch.dispatchId, threadId: thread.threadId, state: "in_progress", itemVersion: service.inspectDispatch(operator, dispatch.dispatchId).items[0]!.version, threadVersion: 1, assignmentEpoch: 1, requestId: "native-work" };
  return {
    root, service, operator, identity, authority, params, snapshot,
    get writes() { return writes; },
    revoke() { current = false; },
    afterCallback(fn: () => void) { afterCallback = fn; },
    close() { service.close(); root.close(); },
  };
}

test("native review awaits asynchronous host mutation admission before serialising the result", async () => {
  const f = await fixture("reply");
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const tool = createCodeReviewTool({ async resolve() { return { ...f.authority,
    async write<T>(body: () => T): Promise<T> { await gate; return f.authority.write!(body); },
  }; } });
  let acknowledged = false;
  const before = f.snapshot();
  const pending = tool.execute("async-review", f.params).then(result => { acknowledged = true; return result; });
  try {
    await Bun.sleep(0); expect(acknowledged).toBe(false); expect(f.snapshot()).toEqual(before);
    release(); const result = await pending;
    expect(result.details).toMatchObject({ version: 2 });
    expect(JSON.parse(result.content[0]!.text)).toEqual(result.details); expect(f.writes).toBe(1);
  } finally { release(); await pending.catch(() => {}); f.close(); }
});

for (const action of ["reply", "work"] as const) {
test(`native ${action}: revocation across awaited resolve prevents every backend mutation`, async () => {
  const f = await fixture(action);
  try {
    const before = f.snapshot();
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const resolving = new Promise<void>(resolve => { entered = resolve; });
    const tool = createCodeReviewTool({ async resolve() {
      const captured = f.authority;
      entered();
      await gate;
      return captured;
    } });
    const pending = tool.execute("native", f.params);
    await resolving;
    f.revoke();
    release();
    await expect(pending).rejects.toThrow("owner revoked");
    expect(f.writes).toBe(0);
    expect(f.snapshot()).toEqual(before);
  } finally { f.close(); }
});

test(`native ${action}: revocation after real mutation callback rolls back all nested stores at root commit`, async () => {
  const f = await fixture(action);
  try {
    const before = f.snapshot();
    let callbackCompleted = false;
    f.afterCallback(() => {
      // The actual service reply and its nested transaction have finished.
      if (action === "reply") expect(f.service.getThread(f.identity, f.params.threadId).version).toBe(2);
      else expect(f.service.inspectDispatch(f.identity, f.params.dispatchId!).items[0]!.work_state).toBe("in_progress");
      expect(f.snapshot()).not.toEqual(before);
      expect(f.root.query("SELECT COUNT(*) AS n FROM addon_code_review_request_receipts WHERE request_id=?").get(f.params.requestId)).toEqual({ n: 1 });
      callbackCompleted = true;
      f.revoke();
    });
    const tool = createCodeReviewTool({ async resolve() { return f.authority; } });
    await expect(tool.execute("native", f.params)).rejects.toThrow("owner revoked");
    expect(callbackCompleted).toBe(true);
    expect(f.writes).toBe(1);
    // Raw root inspection remains possible after ownership has expired. Covers
    // messages/revisions, thread/review versions, events, receipts and host rows.
    expect(f.snapshot()).toEqual(before);
    expect(f.root.query("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally { f.close(); }
});

test(`native ${action}: revoked owner cannot replay an existing committed request receipt`, async () => {
  const f = await fixture(action);
  try {
    const tool = createCodeReviewTool({ async resolve() { return f.authority; } });
    const first = await tool.execute("native", f.params);
    expect(first.details).toMatchObject({ version: 2 });
    expect(await tool.execute("replay", f.params)).toEqual(first);
    const before = f.snapshot();
    expect(f.root.query("SELECT COUNT(*) AS n FROM addon_code_review_request_receipts WHERE request_id=?").get(f.params.requestId)).toEqual({ n: 1 });
    const writes = f.writes;
    f.revoke();
    await expect(tool.execute("revoked-replay", f.params)).rejects.toThrow("owner revoked");
    expect(f.writes).toBe(writes);
    expect(f.snapshot()).toEqual(before);
  } finally { f.close(); }
});

test(`native ${action}: caller authority fields cannot replace dispatch-bound identity; shared freshBody also rejects them`, async () => {
  const f = await fixture(action);
  try {
    const before = f.snapshot();
    let resolutions = 0;
    const tool = createCodeReviewTool({ async resolve() { resolutions++; return f.authority; } });
    for (const key of ["ownerId", "actorId", "kind", "workspaceId", "workspaceRoot"]) {
      const forged = { ...f.params, [key]: "attacker" };
      await expect(tool.execute("forged", forged)).rejects.toThrow("unavailable");
      expect(() => runCodeReviewMutation(f.service, f.identity, action, forged)).toThrow("Authority fields");
    }
    expect(resolutions).toBe(0);
    expect(f.snapshot()).toEqual(before);
    await tool.execute("trusted", f.params);
    if (action === "reply") expect(f.service.getThread(f.identity, f.params.threadId).messages.at(-1)).toMatchObject({ author_id: "trusted-agent", author_kind: "agent", body: "Native reply" });
    else {
      expect(f.service.inspectDispatch(f.identity, f.params.dispatchId!).items[0]!.work_state).toBe("in_progress");
      await expect(createCodeReviewTool({ async resolve() { return { ...f.authority, identity: f.operator }; } }).execute("operator", { ...f.params, requestId: "operator-work" })).rejects.toThrow("assigned agent");
    }
  } finally { f.close(); }
});
}
