import { afterEach, describe, expect, test } from "bun:test";

import sessionTreeAddon, { buildSessionTreeModel, buildTreeWidgetHtml } from "./index.ts";

const savedRegisterWidgetKind = (globalThis as any).__piclaw_registerWidgetKind;
const savedWarn = console.warn;

afterEach(() => {
  if (savedRegisterWidgetKind === undefined) delete (globalThis as any).__piclaw_registerWidgetKind;
  else (globalThis as any).__piclaw_registerWidgetKind = savedRegisterWidgetKind;
  console.warn = savedWarn;
});

const flatSnapshot = {
  version: 1,
  flat: true,
  leafId: "leaf",
  total: 4,
  nodes: [
    { id: "leaf", parentId: "branch", type: "message", role: "assistant", detail: "leaf reply", active: false },
    { id: "root", parentId: null, type: "message", role: "user", detail: "root prompt", label: "start" },
    { id: "branch", parentId: "root", type: "message", role: "assistant", detail: "branch reply" },
    { id: "orphan", parentId: "missing", type: "compaction", preview: "[compaction]" },
  ],
};

describe("session-tree addon", () => {
  test("reconstructs hierarchy from a flat invocation snapshot", () => {
    const model = buildSessionTreeModel(flatSnapshot);

    expect(model).toMatchObject({ version: 1, leafId: "leaf", total: 4, rootIds: ["root", "orphan"] });
    expect(model.nodes.map((node) => ({
      id: node.id,
      depth: node.depth,
      childIds: node.childIds,
      active: node.active,
    }))).toEqual([
      { id: "leaf", depth: 2, childIds: [], active: true },
      { id: "root", depth: 0, childIds: ["branch"], active: false },
      { id: "branch", depth: 1, childIds: ["leaf"], active: false },
      { id: "orphan", depth: 0, childIds: [], active: false },
    ]);
  });

  test("breaks malformed parent cycles and ignores duplicate or invalid nodes", () => {
    const model = buildSessionTreeModel({
      leafId: "missing",
      nodes: [
        { id: "a", parentId: "b", type: "message" },
        { id: "b", parentId: "a", type: "message", active: true },
        { id: "a", parentId: null, type: "message" },
        { id: "", parentId: null },
        null,
      ],
    });

    expect(model.nodes.map((node) => node.id)).toEqual(["a", "b"]);
    expect(model.rootIds).toEqual(["a", "b"]);
    expect(model.leafId).toBe("b");
    expect(model.nodes.find((node) => node.id === "b")?.active).toBe(true);
  });

  test("renders only from the supplied snapshot with safe embedded data and widget actions", () => {
    const hostile = {
      ...flatSnapshot,
      nodes: [
        ...flatSnapshot.nodes,
        { id: "hostile", parentId: "root", type: "message", label: "</script><img src=x onerror=alert(1)>", detail: "<b>not markup</b>" },
      ],
    };
    const html = buildTreeWidgetHtml(hostile, "web:research & notes");

    expect(html).not.toContain("/agent/session-tree");
    expect(html).not.toContain("fetch(");
    expect(html).not.toContain("</script><img");
    expect(html).toContain("\\u003c/script\\u003e\\u003cimg");
    expect(html).toContain('const CHAT_JID = "web:research \\u0026 notes";');
    expect(html).toContain("Navigate + summarize");
    expect(html).toContain("/tree ' + selectedId + ' --summarize");
    expect(html).toContain("submitTreeCommand('/tree')");
    expect(html).toContain("aria-label=\"Session tree\"");
  });

  test("registers the session_tree renderer and consumes artifact.tree", () => {
    let kind = "";
    let render: ((artifact: Record<string, unknown>) => string) | undefined;

    (globalThis as any).__piclaw_registerWidgetKind = (k: string, fn: (artifact: Record<string, unknown>) => string) => {
      kind = k;
      render = fn;
    };

    sessionTreeAddon({});

    expect(kind).toBe("session_tree");
    expect(typeof render).toBe("function");

    const html = render!({ tree: flatSnapshot, chatJid: "web:addons" });
    expect(html).toContain('const CHAT_JID = "web:addons";');
    expect(html).toContain('"leafId":"leaf"');
    expect(html).not.toContain("/agent/session-tree");
  });

  test("falls back cleanly when widget registration is unavailable", () => {
    delete (globalThis as any).__piclaw_registerWidgetKind;

    const warnings: string[] = [];
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map((value) => String(value)).join(" "));
    };

    sessionTreeAddon({});

    expect(warnings.some((line) => line.includes("tree widget will use text fallback"))).toBe(true);
  });
});
