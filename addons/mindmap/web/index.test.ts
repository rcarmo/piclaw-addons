import { afterEach, describe, expect, test } from "bun:test";

import {
  findExistingMindmapTab,
  handleMindmapDuplicateOpenRequest,
  isMindmapPath,
  normalizeMindmapOpenWorkspaceFileRequest,
  normalizeMindmapPanePath,
} from "./index.ts";

const savedDocument = (globalThis as any).document;
const savedMouseEvent = (globalThis as any).MouseEvent;
const savedRequestAnimationFrame = (globalThis as any).requestAnimationFrame;
const savedFetch = (globalThis as any).fetch;

afterEach(() => {
  if (savedDocument === undefined) delete (globalThis as any).document;
  else (globalThis as any).document = savedDocument;
  if (savedMouseEvent === undefined) delete (globalThis as any).MouseEvent;
  else (globalThis as any).MouseEvent = savedMouseEvent;
  if (savedRequestAnimationFrame === undefined) delete (globalThis as any).requestAnimationFrame;
  else (globalThis as any).requestAnimationFrame = savedRequestAnimationFrame;
  if (savedFetch === undefined) delete (globalThis as any).fetch;
  else (globalThis as any).fetch = savedFetch;
});

function createTab(title: string) {
  const events: string[] = [];
  return {
    events,
    getAttribute(name: string) { return name === "title" ? title : null; },
    dispatchEvent(event: any) { events.push(String(event?.type || "")); return true; },
  } as any;
}

describe("mindmap web duplicate-open guard", () => {
  test("normalizes mindmap pane paths for stable identity", () => {
    expect(normalizeMindmapPanePath(" ./notes//maps/../plan.mindmap.yaml ")).toBe("notes/plan.mindmap.yaml");
    expect(normalizeMindmapPanePath("notes\\plan.mindmap.yml")).toBe("notes/plan.mindmap.yml");
    expect(isMindmapPath("notes/plan.mindmap.yaml")).toBe(true);
    expect(isMindmapPath("notes/plan.yaml")).toBe(false);
  });

  test("recognizes open_workspace_file requests for mindmap files", () => {
    expect(normalizeMindmapOpenWorkspaceFileRequest({
      kind: "custom",
      request_id: "req-1",
      chat_jid: "web:addons",
      options: { action: "open_workspace_file", path: "./notes/plan.mindmap.yaml", target: "popout" },
    })).toEqual({
      requestId: "req-1",
      chatJid: "web:addons",
      path: "notes/plan.mindmap.yaml",
      target: "popout",
    });
    expect(normalizeMindmapOpenWorkspaceFileRequest({
      kind: "custom",
      request_id: "req-2",
      options: { action: "open_workspace_file", path: "notes/plain.md" },
    })).toBeNull();
  });

  test("finds an existing tab by normalized file path", () => {
    const existing = createTab("notes/plan.mindmap.yaml");
    const doc = { querySelectorAll: () => [createTab("other.mindmap.yaml"), existing] } as any;
    expect(findExistingMindmapTab("./notes/maps/../plan.mindmap.yaml", doc)).toBe(existing);
  });

  test("focuses an existing tab and stops duplicate open_workspace_file handling", async () => {
    const existing = createTab("notes/plan.mindmap.yaml");
    const focused: string[] = [];
    const fetches: any[] = [];
    const doc = {
      querySelectorAll: () => [existing],
      querySelector: () => ({ focus: () => focused.push("focused") }),
    } as any;
    (globalThis as any).document = doc;
    (globalThis as any).MouseEvent = class {
      type: string;
      constructor(type: string) { this.type = type; }
    };
    (globalThis as any).requestAnimationFrame = (cb: () => void) => { cb(); return 1; };
    (globalThis as any).fetch = async (...args: any[]) => {
      fetches.push(args);
      return { ok: true, json: async () => ({ ok: true }) };
    };

    let prevented = false;
    let stopped = false;
    const handled = handleMindmapDuplicateOpenRequest({
      detail: {
        payload: {
          kind: "custom",
          request_id: "req-3",
          chat_jid: "web:addons",
          options: { action: "open_workspace_file", path: "./notes/plan.mindmap.yaml", target: "popout" },
        },
      },
      preventDefault: () => { prevented = true; },
      stopImmediatePropagation: () => { stopped = true; },
    } as any, { document: doc });

    await Promise.resolve();

    expect(handled).toBe(true);
    expect(prevented).toBe(true);
    expect(stopped).toBe(true);
    expect(existing.events).toEqual(["mousedown", "click"]);
    expect(focused).toEqual(["focused"]);
    expect(fetches).toHaveLength(1);
    expect(fetches[0][0]).toBe("/agent/respond");
    expect(JSON.parse(fetches[0][1].body).outcome).toEqual({
      ok: true,
      opened: true,
      focused_existing: true,
      target: "popout",
      path: "notes/plan.mindmap.yaml",
    });
  });
});
