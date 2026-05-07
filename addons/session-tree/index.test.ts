import { afterEach, describe, expect, test } from "bun:test";

import sessionTreeAddon from "./index.ts";

const savedRegisterWidgetKind = (globalThis as any).__piclaw_registerWidgetKind;
const savedWarn = console.warn;

afterEach(() => {
  if (savedRegisterWidgetKind === undefined) delete (globalThis as any).__piclaw_registerWidgetKind;
  else (globalThis as any).__piclaw_registerWidgetKind = savedRegisterWidgetKind;
  console.warn = savedWarn;
});

describe("session-tree addon", () => {
  test("registers the session_tree widget renderer", () => {
    let kind = "";
    let render: ((artifact: Record<string, unknown>) => string) | undefined;

    (globalThis as any).__piclaw_registerWidgetKind = (k: string, fn: (artifact: Record<string, unknown>) => string) => {
      kind = k;
      render = fn;
    };

    sessionTreeAddon({});

    expect(kind).toBe("session_tree");
    expect(typeof render).toBe("function");

    const html = render!({ leafId: "leaf-direct", chatJid: "web:addons", tree: { leafId: "leaf-from-tree" } });

    expect(html).toContain('const LEAF_ID = "leaf-from-tree";');
    expect(html).toContain('const CHAT_JID = "web:addons";');
    expect(html).toContain("/agent/session-tree?");
    expect(html).toContain("window.piclawWidget?.submit({ text: '/tree ' + id });");
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
