/**
 * test/extensions/m365-todo.test.ts
 *
 * Unit tests for the m365_todo tool logic.
 * Tests normalization, filtering, and sorting without real Graph calls.
 */
import { expect, test, describe } from "bun:test";

// ── Test helper: replicate the tool's normalization/filter/sort logic ────────

type NormalizedTask = {
  id: string;
  title: string;
  status: string;
  importance: string;
  source: "tasks" | "flaggedEmails" | "list";
  listId: string;
  listName: string;
  wellknownListName: string | null;
  createdDateTime: string | null;
  lastModifiedDateTime: string | null;
  dueDateTime: string | null;
  completedDateTime: string | null;
  hasAttachments: boolean;
  bodyText: string | null;
  linkedResourceCount: number;
  linkedWebUrl: string | null;
  linkedDisplayName: string | null;
};

function normalizeTask(t: any, source: NormalizedTask["source"], listId: string, listName: string, wellknown: string | null): NormalizedTask {
  const linkedResources: any[] = t.linkedResources ?? [];
  const firstLink = linkedResources[0] ?? null;
  return {
    id: t.id,
    title: t.title ?? "",
    status: t.status ?? "notStarted",
    importance: t.importance ?? "normal",
    source,
    listId,
    listName,
    wellknownListName: wellknown,
    createdDateTime: t.createdDateTime ?? null,
    lastModifiedDateTime: t.lastModifiedDateTime ?? null,
    dueDateTime: t.dueDateTime?.dateTime ?? null,
    completedDateTime: t.completedDateTime?.dateTime ?? null,
    hasAttachments: t.hasAttachments ?? false,
    bodyText: t.body?.content ? t.body.content.replace(/<[^>]+>/g, "").trim().substring(0, 300) || null : null,
    linkedResourceCount: linkedResources.length,
    linkedWebUrl: firstLink?.webUrl ?? null,
    linkedDisplayName: firstLink?.displayName ?? null,
  };
}

function filterAndSort(
  items: NormalizedTask[],
  opts: { includeCompleted?: boolean; statusFilter?: Set<string>; searchTerm?: string; dueBefore?: Date | null; dueAfter?: Date | null }
): NormalizedTask[] {
  const { includeCompleted = false, statusFilter = null, searchTerm = "", dueBefore = null, dueAfter = null } = opts;
  const importanceOrder: Record<string, number> = { high: 0, normal: 1, low: 2 };

  return items
    .filter(t => {
      if (!includeCompleted && t.status === "completed") return false;
      if (statusFilter && !statusFilter.has(t.status.toLowerCase())) return false;
      if (dueBefore && t.dueDateTime && new Date(t.dueDateTime) > dueBefore) return false;
      if (dueAfter && t.dueDateTime && new Date(t.dueDateTime) < dueAfter) return false;
      if (searchTerm) {
        const haystack = [t.title, t.bodyText ?? "", t.linkedDisplayName ?? ""].join(" ").toLowerCase();
        if (!haystack.includes(searchTerm)) return false;
      }
      return true;
    })
    .sort((a, b) => {
      const aComplete = a.status === "completed" ? 1 : 0;
      const bComplete = b.status === "completed" ? 1 : 0;
      if (aComplete !== bComplete) return aComplete - bComplete;
      const aDue = a.dueDateTime ? new Date(a.dueDateTime).getTime() : Infinity;
      const bDue = b.dueDateTime ? new Date(b.dueDateTime).getTime() : Infinity;
      if (aDue !== bDue) return aDue - bDue;
      const aImp = importanceOrder[a.importance] ?? 1;
      const bImp = importanceOrder[b.importance] ?? 1;
      if (aImp !== bImp) return aImp - bImp;
      const aModified = a.lastModifiedDateTime ? new Date(a.lastModifiedDateTime).getTime() : 0;
      const bModified = b.lastModifiedDateTime ? new Date(b.lastModifiedDateTime).getTime() : 0;
      return bModified - aModified;
    });
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

const rawTask1 = {
  id: "task-1",
  title: "Write quarterly report",
  status: "notStarted",
  importance: "high",
  dueDateTime: { dateTime: "2026-04-25T00:00:00.000Z" },
  lastModifiedDateTime: "2026-04-21T10:00:00.000Z",
  createdDateTime: "2026-04-20T09:00:00.000Z",
  hasAttachments: false,
  body: null,
  linkedResources: [],
};

const rawTask2 = {
  id: "task-2",
  title: "Review flagged email from Alice",
  status: "notStarted",
  importance: "normal",
  dueDateTime: null,
  lastModifiedDateTime: "2026-04-21T08:00:00.000Z",
  createdDateTime: "2026-04-20T08:00:00.000Z",
  hasAttachments: false,
  body: { content: "<p>From: Alice — follow up on contract</p>" },
  linkedResources: [{ webUrl: "https://outlook.office.com/mail/inbox/AAA", displayName: "Re: Contract renewal" }],
};

const rawTask3 = {
  id: "task-3",
  title: "Book travel to conference",
  status: "completed",
  importance: "normal",
  dueDateTime: { dateTime: "2026-04-18T00:00:00.000Z" },
  completedDateTime: { dateTime: "2026-04-17T15:00:00.000Z" },
  lastModifiedDateTime: "2026-04-17T15:00:00.000Z",
  createdDateTime: "2026-04-15T09:00:00.000Z",
  hasAttachments: false,
  body: null,
  linkedResources: [],
};

const task1 = normalizeTask(rawTask1, "tasks", "list-1", "Tasks", "defaultList");
const task2 = normalizeTask(rawTask2, "flaggedEmails", "list-2", "Flagged Email", "flaggedEmails");
const task3 = normalizeTask(rawTask3, "tasks", "list-1", "Tasks", "defaultList");

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("m365_todo normalization", () => {
  test("normalizes basic task fields", () => {
    expect(task1.id).toBe("task-1");
    expect(task1.title).toBe("Write quarterly report");
    expect(task1.status).toBe("notStarted");
    expect(task1.importance).toBe("high");
    expect(task1.source).toBe("tasks");
    expect(task1.listId).toBe("list-1");
    expect(task1.wellknownListName).toBe("defaultList");
    expect(task1.dueDateTime).toBe("2026-04-25T00:00:00.000Z");
    expect(task1.linkedResourceCount).toBe(0);
    expect(task1.linkedWebUrl).toBeNull();
  });

  test("normalizes flagged email task with linked resource", () => {
    expect(task2.source).toBe("flaggedEmails");
    expect(task2.wellknownListName).toBe("flaggedEmails");
    expect(task2.linkedResourceCount).toBe(1);
    expect(task2.linkedWebUrl).toBe("https://outlook.office.com/mail/inbox/AAA");
    expect(task2.linkedDisplayName).toBe("Re: Contract renewal");
  });

  test("strips HTML from body content", () => {
    expect(task2.bodyText).toBe("From: Alice — follow up on contract");
  });

  test("handles null dueDateTime", () => {
    expect(task2.dueDateTime).toBeNull();
  });

  test("maps completedDateTime from nested dateTime", () => {
    expect(task3.completedDateTime).toBe("2026-04-17T15:00:00.000Z");
  });
});

describe("m365_todo filtering", () => {
  const all = [task1, task2, task3];

  test("excludes completed by default", () => {
    const result = filterAndSort(all, { includeCompleted: false });
    expect(result.find(t => t.id === "task-3")).toBeUndefined();
    expect(result.length).toBe(2);
  });

  test("includes completed when requested", () => {
    const result = filterAndSort(all, { includeCompleted: true });
    expect(result.find(t => t.id === "task-3")).toBeDefined();
    expect(result.length).toBe(3);
  });

  test("filters by status", () => {
    const result = filterAndSort(all, { includeCompleted: true, statusFilter: new Set(["completed"]) });
    expect(result.length).toBe(1);
    expect(result[0].id).toBe("task-3");
  });

  test("searches across title", () => {
    const result = filterAndSort(all, { searchTerm: "quarterly" });
    expect(result.length).toBe(1);
    expect(result[0].id).toBe("task-1");
  });

  test("searches across body text", () => {
    const result = filterAndSort(all, { searchTerm: "alice" });
    expect(result.length).toBe(1);
    expect(result[0].id).toBe("task-2");
  });

  test("searches across linked display name", () => {
    const result = filterAndSort(all, { searchTerm: "contract" });
    expect(result.length).toBe(1);
    expect(result[0].id).toBe("task-2");
  });

  test("filters by dueBefore", () => {
    const result = filterAndSort(all, { dueBefore: new Date("2026-04-26T00:00:00.000Z") });
    // task-1 is due 2026-04-25, task-2 has no due date, task-3 is completed/excluded
    expect(result.find(t => t.id === "task-1")).toBeDefined();
  });

  test("excludes tasks due after dueBefore", () => {
    const result = filterAndSort(all, { dueBefore: new Date("2026-04-20T00:00:00.000Z") });
    expect(result.find(t => t.id === "task-1")).toBeUndefined();
  });
});

describe("m365_todo sorting", () => {
  const taskHigh = { ...task1, importance: "high" as const, dueDateTime: "2026-04-25T00:00:00.000Z" };
  const taskNormal = { ...task2, importance: "normal" as const, dueDateTime: "2026-04-25T00:00:00.000Z" };
  const taskNoDate = { ...task2, id: "nd", importance: "normal" as const, dueDateTime: null };
  const taskComplete = { ...task3, status: "completed" as const, dueDateTime: "2026-04-18T00:00:00.000Z" };

  test("incomplete before complete", () => {
    const result = filterAndSort([taskComplete, taskHigh], { includeCompleted: true });
    expect(result[0].status).not.toBe("completed");
    expect(result[result.length - 1].status).toBe("completed");
  });

  test("earlier due date before later", () => {
    const earlier = { ...taskNormal, id: "early", dueDateTime: "2026-04-22T00:00:00.000Z" };
    const later = { ...taskNormal, id: "late", dueDateTime: "2026-04-30T00:00:00.000Z" };
    const result = filterAndSort([later, earlier], {});
    expect(result[0].id).toBe("early");
  });

  test("undated tasks come after dated tasks", () => {
    const result = filterAndSort([taskNoDate, taskHigh], {});
    expect(result[0].id).toBe(taskHigh.id);
    expect(result[1].id).toBe(taskNoDate.id);
  });

  test("high importance before normal at same due date", () => {
    const result = filterAndSort([taskNormal, taskHigh], {});
    expect(result[0].importance).toBe("high");
  });
});
