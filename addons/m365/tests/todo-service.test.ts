import { test, expect, describe } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createTodoService,
  fileJournal,
  normalizeTask,
  taskPatch,
  registerTodoTools,
} from "../todo.ts";
const list = {
  id: "l",
  displayName: "Tasks",
  wellknownListName: "defaultList",
  isOwner: true,
  isShared: false,
  "@odata.etag": "list-v1",
};
function fixture() {
  const calls: any[] = [],
    records = new Map<string, any>();
  let n = 0;
  records.set("me/todo/lists/l", { ...list });
  const receipts = new Map();
  const journal = {
    begin(k: string, f: string) {
      const r = receipts.get(k);
      if (r) {
        if (r.f !== f) throw Error("different payload");
        if (!r.result) throw Error("uncertain");
        return r.result;
      }
      receipts.set(k, { f });
    },
    finish(k: string, f: string, result: any) {
      receipts.set(k, { f, result });
    },
  };
  const graph = async (path: string, o: any = {}) => {
    calls.push({ path, ...o });
    const method = o.method ?? "GET";
    if (path === "me?$select=id") return { id: "u" };
    if (path.includes("$select")) throw Error("Graph 400: invalidRequest");
    if (method === "GET") {
      if (path === "me/todo/lists?$top=100") return { value: [list] };
      if (path.includes("?")) return { value: [] };
      if (!records.has(path)) throw Error("Graph 404: ErrorItemNotFound");
      return structuredClone(records.get(path));
    }
    if (method === "POST") {
      const id = "t" + ++n,
        item = { id, "@odata.etag": "v1", status: "notStarted", ...o.body };
      records.set(path + "/" + id, item);
      return structuredClone(item);
    }
    const old = records.get(path);
    if (!old) throw Error("Graph 404: ErrorItemNotFound");
    if (o.headers?.["If-Match"] && o.headers["If-Match"] !== old["@odata.etag"])
      throw Error("Graph 412: stale");
    if (method === "DELETE") {
      records.delete(path);
      return null;
    }
    const item = { ...old, ...o.body, "@odata.etag": "v" + (++n + 1) };
    records.set(path, item);
    return structuredClone(item);
  };
  return {
    service: createTodoService(graph, journal),
    graph,
    calls,
    records,
    journal,
  };
}
const approved = { confirmed: true, requestKey: "test-1", listId: "l" };
describe("To Do read regressions", () => {
  test("never emits $select on To Do endpoints and accepts empty status", async () => {
    const f = fixture();
    const r = await f.service.read({ status: [], top: 5 });
    expect(r.complete).toBe(true);
    expect(f.calls.every((x) => !x.path.includes("$select"))).toBe(true);
  });
  test("all failures throw rather than report zero", async () => {
    const f = fixture();
    const s = createTodoService(
      async (p) =>
        p === "me/todo/lists?$top=100"
          ? { value: [list] }
          : Promise.reject(Error("Graph 400: bad")),
      f.journal,
    );
    await expect(s.read({})).rejects.toThrow("no task count");
  });
  test("follows task pages and searches untruncated notes", async () => {
    const f = fixture();
    const s = createTodoService(
      async (p) =>
        p.includes("/tasks")
          ? p.includes("skip=1")
            ? {
                value: [
                  {
                    id: "t2",
                    title: "Two",
                    body: {
                      content: "a".repeat(500) + "needle",
                      contentType: "text",
                    },
                  },
                ],
              }
            : {
                value: [{ id: "t1", title: "One" }],
                "@odata.nextLink":
                  "https://graph.microsoft.com/v1.0/me/todo/lists/l/tasks?$top=100&$skip=1",
              }
          : { value: [list] },
      f.journal,
    );
    const r = await s.read({ search: "needle" });
    expect(r.items[0].id).toBe("t2");
    expect(r.complete).toBe(true);
  });
  test("follows list pagination", async () => {
    const f = fixture();
    const s = createTodoService(
      async (p) =>
        p.includes("/tasks")
          ? { value: [] }
          : p.includes("skip=1")
            ? { value: [list] }
            : {
                value: [],
                "@odata.nextLink":
                  "https://graph.microsoft.com/v1.0/me/todo/lists?$skip=1",
              },
      f.journal,
    );
    expect((await s.read({})).listsQueried).toHaveLength(1);
  });
  test("caps pages and marks incomplete", async () => {
    const f = fixture();
    const s = createTodoService(
      async (p) =>
        p.includes("/tasks")
          ? {
              value: [],
              "@odata.nextLink":
                "https://graph.microsoft.com/v1.0/me/todo/lists/l/tasks?$skip=100",
            }
          : { value: [list] },
      f.journal,
    );
    const r = await s.read({ maxPages: 2 });
    expect(r.complete).toBe(false);
    expect(r.pagesUsed).toBe(2);
  });
  test("rejects cross-origin pagination before sending credentials", async () => {
    const f = fixture();
    let count = 0;
    const s = createTodoService(async () => {
      count++;
      return {
        value: [],
        "@odata.nextLink": "https://evil.example/me/todo/lists",
      };
    }, f.journal);
    await expect(s.lists({ action: "list" })).rejects.toThrow("Rejected");
    expect(count).toBe(1);
  });
  test("rejects Graph pagination to another resource", async () => {
    const f = fixture();
    const s = createTodoService(
      async () => ({
        value: [],
        "@odata.nextLink": "https://graph.microsoft.com/v1.0/me/messages",
      }),
      f.journal,
    );
    await expect(s.lists({ action: "list" })).rejects.toThrow("Rejected");
  });
  test("partial errors are explicit", async () => {
    const f = fixture();
    const s = createTodoService(
      async (p) =>
        p === "me/todo/lists?$top=100"
          ? { value: [list, { ...list, id: "b" }] }
          : p.includes("/b/")
            ? Promise.reject(Error("denied"))
            : { value: [] },
      f.journal,
    );
    const r = await s.read({ sources: ["allLists"] });
    expect(r.complete).toBe(false);
    expect(r.errors).toHaveLength(1);
  });
  test("date filter excludes undated tasks", async () => {
    const f = fixture();
    const s = createTodoService(
      async (p) =>
        p.includes("/tasks")
          ? {
              value: [
                { id: "a" },
                {
                  id: "b",
                  dueDateTime: {
                    dateTime: "2026-10-02T00:00:00",
                    timeZone: "UTC",
                  },
                },
              ],
            }
          : { value: [list] },
      f.journal,
    );
    expect(
      (await s.read({ dueBefore: "2026-10-03" })).items.map((x) => x.id),
    ).toEqual(["b"]);
  });
  test("preserves timezone and full text", () => {
    const r = normalizeTask(
      {
        dueDateTime: {
          dateTime: "2026-10-02T12:00:00",
          timeZone: "GMT Standard Time",
        },
        body: { content: "a".repeat(800), contentType: "text" },
      },
      list,
    );
    expect(r.dueDateTime.timeZone).toBe("GMT Standard Time");
    expect(r.bodyText.length).toBe(800);
  });
  test("result limit declares truncation", async () => {
    const f = fixture();
    const s = createTodoService(
      async (p) =>
        p.includes("/tasks")
          ? { value: [{ id: "a" }, { id: "b" }] }
          : { value: [list] },
      f.journal,
    );
    const r = await s.read({ top: 1 });
    expect(r.complete).toBe(false);
    expect(r.truncated).toBe(true);
    expect(r.count).toBe(1);
  });
  test("rejects invalid limits and unknown actions", async () => {
    const f = fixture();
    await expect(f.service.read({ top: 0 })).rejects.toThrow();
    await expect(f.service.read({ action: "delete" })).rejects.toThrow();
  });
});
describe("write safety and contracts", () => {
  test("unconfirmed write makes no network calls", async () => {
    const f = fixture();
    await expect(
      f.service.task({ action: "create", listId: "l", title: "test" }),
    ).rejects.toThrow("approval");
    expect(f.calls).toHaveLength(0);
  });
  test("create, replay, update, complete, reopen and delete", async () => {
    const f = fixture();
    const c = await f.service.task({
      ...approved,
      action: "create",
      title: "Test",
    });
    expect(c.verified).toBe(true);
    expect(
      (await f.service.task({ ...approved, action: "create", title: "Test" }))
        .replayed,
    ).toBe(true);
    expect(f.calls.filter((c) => c.method === "POST")).toHaveLength(1);
    let t = c.current;
    for (const action of ["update", "complete", "reopen"]) {
      const r = await f.service.task({
        ...approved,
        action,
        taskId: t.id,
        expectedEtag: t["@odata.etag"],
        ...(action === "update" ? { notes: "new", importance: "high" } : {}),
      });
      t = r.current;
      expect(r.verified).toBe(true);
    }
    expect(t.status).toBe("notStarted");
    expect(t.body.content).toBe("new");
    const r = await f.service.task({
      ...approved,
      action: "delete",
      confirmDelete: true,
      taskId: t.id,
      expectedEtag: t["@odata.etag"],
    });
    expect(r.deleted).toBe(true);
  });
  test("stale ETag prevents PATCH", async () => {
    const f = fixture();
    f.records.set("me/todo/lists/l/tasks/t", { id: "t", "@odata.etag": "v2" });
    await expect(
      f.service.task({
        ...approved,
        action: "update",
        taskId: "t",
        expectedEtag: "v1",
        title: "X",
      }),
    ).rejects.toThrow("changed");
    expect(f.calls.filter((c) => c.method === "PATCH")).toHaveLength(0);
  });
  test("missing delete confirmation prevents DELETE", async () => {
    const f = fixture();
    f.records.set("me/todo/lists/l/tasks/t", { id: "t", "@odata.etag": "v1" });
    await expect(
      f.service.task({
        ...approved,
        action: "delete",
        taskId: "t",
        expectedEtag: "v1",
      }),
    ).rejects.toThrow("confirmDelete");
    expect(f.calls.filter((c) => c.method === "DELETE")).toHaveLength(0);
  });
  test("protects shared lists", async () => {
    const f = fixture();
    f.records.set("me/todo/lists/l", { ...list, isShared: true });
    await expect(
      f.service.task({ ...approved, action: "create", title: "X" }),
    ).rejects.toThrow("unshared");
  });
  test("protects flagged emails", async () => {
    const f = fixture();
    f.records.set("me/todo/lists/l", {
      ...list,
      wellknownListName: "flaggedEmails",
    });
    await expect(
      f.service.task({ ...approved, action: "create", title: "X" }),
    ).rejects.toThrow("Flagged");
  });
  test("protects built-in list deletion", async () => {
    const f = fixture();
    await expect(
      f.service.lists({
        ...approved,
        action: "delete",
        expectedEtag: "list-v1",
        confirmDelete: true,
      }),
    ).rejects.toThrow("Built-in");
  });
  test("refuses nonempty custom list deletion", async () => {
    const f = fixture();
    const s = createTodoService(
      async (p) =>
        p.includes("/tasks?")
          ? { value: [{ id: "t" }] }
          : { ...list, wellknownListName: "none" },
      f.journal,
    );
    await expect(
      s.lists({
        ...approved,
        action: "delete",
        expectedEtag: "list-v1",
        confirmDelete: true,
      }),
    ).rejects.toThrow("empty");
  });
  test("unknown write action fails closed", async () => {
    const f = fixture();
    await expect(
      f.service.task({ ...approved, action: "send" }),
    ).rejects.toThrow("Invalid");
  });
  test("task patch does not overwrite omitted notes or dates", () => {
    expect(taskPatch({ importance: "high" })).toEqual({ importance: "high" });
    expect(taskPatch({ dueDateTime: null })).toEqual({ dueDateTime: null });
  });
  test("validates dates, statuses, reminder requirements and lengths", () => {
    expect(() =>
      taskPatch({
        dueDateTime: { dateTime: "2026-02-30T00:00:00", timeZone: "UTC" },
      }),
    ).toThrow();
    expect(() =>
      taskPatch({
        dueDateTime: { dateTime: "2026-10-01T00:00:00Z", timeZone: "UTC" },
      }),
    ).toThrow();
    expect(() => taskPatch({ status: "bogus" })).toThrow();
    expect(() => taskPatch({ isReminderOn: true })).toThrow();
    expect(() => taskPatch({ title: " " })).toThrow();
  });
  test("id encoding prevents path injection", async () => {
    const f = fixture();
    await f.service
      .task({ action: "get", listId: "l/evil", taskId: "t?x" })
      .catch(() => {});
    expect(f.calls[0].path).toBe("me/todo/lists/l%2Fevil/tasks/t%3Fx");
  });
  test("rejects dot path segments before network access", async () => {
    const f = fixture();
    await expect(
      f.service.task({ action: "get", listId: "..", taskId: "t" }),
    ).rejects.toThrow("Invalid resource");
    expect(f.calls).toHaveLength(0);
  });
  test("ambiguous create blocks POST replay", async () => {
    const f = fixture();
    let posts = 0;
    const s = createTodoService(async (p, o = {}) => {
      if (o.method === "POST") {
        posts++;
        throw Error("network lost");
      }
      return f.graph(p, o);
    }, f.journal);
    await expect(
      s.task({ ...approved, action: "create", title: "X" }),
    ).rejects.toThrow("network lost");
    await expect(
      s.task({ ...approved, action: "create", title: "X" }),
    ).rejects.toThrow("uncertain");
    expect(posts).toBe(1);
  });
  test("write readback mismatch fails verification", async () => {
    const f = fixture();
    const s = createTodoService(
      async (p, o = {}) =>
        o.method === "PATCH"
          ? null
          : p.endsWith("/l")
            ? list
            : { id: "t", "@odata.etag": "v1", title: "Old" },
      f.journal,
    );
    await expect(
      s.task({
        ...approved,
        action: "update",
        taskId: "t",
        expectedEtag: "v1",
        title: "New",
      }),
    ).rejects.toThrow("read-back");
  });
});
describe("durable create receipts", () => {
  test("rejects a tampered replay path before sending a request to it", async () => {
    const f = fixture();
    const service = createTodoService(f.graph, {
      begin() { return { id: "t", path: "https://invalid.example/collect" }; },
      finish() {},
    });
    await expect(service.task({ ...approved, action: "create", title: "Synthetic" })).rejects.toThrow("receipt path");
    expect(f.calls.some(c => c.path.includes("invalid.example"))).toBe(false);
  });
  test("completed receipt survives new journal; changed payload rejected", () => {
    const dir = mkdtempSync(join(tmpdir(), "todo-journal-"));
    try {
      const j = fileJournal(dir);
      expect(j.begin("k", "f")).toBeUndefined();
      j.finish("k", "f", { id: "x", path: "p" });
      expect(fileJournal(dir).begin("k", "f").id).toBe("x");
      expect(() => j.begin("k", "other")).toThrow("different");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
  test("pending receipt blocks ambiguous retry", () => {
    const dir = mkdtempSync(join(tmpdir(), "todo-journal-"));
    try {
      const j = fileJournal(dir);
      j.begin("k", "f");
      expect(() => j.begin("k", "f")).toThrow("uncertain");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});
test("aborted registered call makes no request", async () => {
  const f = fixture(),
    tools: any[] = [];
  const T: any = {
    Optional: (v: any) => v,
    String: () => ({}),
    Boolean: () => ({}),
    Union: () => ({}),
    Literal: () => ({}),
    Object: () => ({}),
    Array: () => ({}),
    Integer: () => ({}),
    Null: () => ({}),
  };
  registerTodoTools(
    { registerTool: (t) => tools.push(t) },
    T,
    f.graph,
    f.journal,
  );
  const c = new AbortController();
  c.abort();
  await expect(tools[0].execute("x", {}, c.signal)).rejects.toThrow();
  expect(f.calls).toHaveLength(0);
});
test("registers four real tools and executes actual registered read", async () => {
  const f = fixture();
  const tools: any[] = [];
  const T: any = {
    Optional: (v: any) => v,
    String: () => ({}),
    Boolean: () => ({}),
    Union: () => ({}),
    Literal: () => ({}),
    Object: () => ({}),
    Array: () => ({}),
    Integer: () => ({}),
    Null: () => ({}),
  };
  registerTodoTools(
    { registerTool: (t) => tools.push(t) },
    T,
    f.graph,
    f.journal,
  );
  expect(tools.map((t) => t.name)).toEqual([
    "m365_todo",
    "m365_todo_lists",
    "m365_todo_task",
    "m365_todo_step",
  ]);
  const r = await tools[0].execute("x", {});
  expect(r.details.complete).toBe(true);
});
