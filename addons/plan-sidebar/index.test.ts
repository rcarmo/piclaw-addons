import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import planSidebarAddon, { applyPlanEdits, loadSessionPlan, resetPlanSidebarAddonForTests, saveSessionPlan } from "./index";

const addonDir = import.meta.dir;

test("plan storage is scoped by chat jid", () => {
  resetPlanSidebarAddonForTests();

  const first = saveSessionPlan("web:alpha", "- [ ] alpha");
  const second = saveSessionPlan("web:beta", "- [ ] beta");

  expect(first.markdown).toBe("- [ ] alpha");
  expect(second.markdown).toBe("- [ ] beta");
  expect(loadSessionPlan("web:alpha").markdown).toBe("- [ ] alpha");
  expect(loadSessionPlan("web:beta").markdown).toBe("- [ ] beta");
});

test("plan tool gets and sets active session plan", async () => {
  resetPlanSidebarAddonForTests();
  let tool: any = null;
  const events: Array<{ type: string; data: any }> = [];
  const previousBroadcast = (globalThis as any).__PICLAW_BROADCAST_EVENT__;
  (globalThis as any).__PICLAW_BROADCAST_EVENT__ = (type: string, data: any) => events.push({ type, data });
  const pi: any = {
    on() {},
    registerTool(definition: any) { tool = definition; },
  };
  try {
    planSidebarAddon(pi);

    expect(tool?.name).toBe("plan");

    const ctx: any = { sessionManager: { getSessionDir: () => "/tmp/web_default" } };
    const writeResult = await tool.execute("1", { action: "write", markdown: "- [x] done" }, undefined, undefined, ctx);
    expect(writeResult.details.chat_jid).toBe("web:default");
    expect(writeResult.details.markdown).toBe("- [x] done");
    expect(events.at(-1)).toMatchObject({
      type: "extension_ui_status",
      data: { key: "plan-sidebar.plan-updated", chat_jid: "web:default", source: "tool", action: "write" },
    });

    const readResult = await tool.execute("2", { action: "read" }, undefined, undefined, ctx);
    expect(readResult.content[0].text).toContain("- [x] done");
  } finally {
    if (previousBroadcast) (globalThis as any).__PICLAW_BROADCAST_EVENT__ = previousBroadcast;
    else delete (globalThis as any).__PICLAW_BROADCAST_EVENT__;
  }
});

test("saved plan is injected into the next model turn", async () => {
  resetPlanSidebarAddonForTests();
  let beforeAgentStart: any = null;
  const pi: any = {
    on(event: string, handler: any) {
      if (event === "before_agent_start") beforeAgentStart = handler;
    },
    registerTool() {},
  };
  planSidebarAddon(pi);

  const ctx: any = { sessionManager: { getSessionDir: () => "/tmp/web_default" } };
  saveSessionPlan("web:default", "- [ ] next step");
  const result = await beforeAgentStart({ systemPrompt: "base" }, ctx);

  expect(result.systemPrompt).toContain("## Plan Sidebar");
  expect(result.systemPrompt).toContain("editable shared state");
  expect(result.systemPrompt).toContain("must keep it current");
  expect(result.systemPrompt).toContain("`plan` tool");
  expect(result.systemPrompt).toContain("action=edit");
  expect(result.systemPrompt).toContain("action=write");
  expect(result.systemPrompt).toContain("- [ ] next step");
});

test("plan edit applies atomic exact replacements", async () => {
  resetPlanSidebarAddonForTests();
  let tool: any = null;
  const pi: any = {
    on() {},
    registerTool(definition: any) { tool = definition; },
  };
  planSidebarAddon(pi);

  const ctx: any = { sessionManager: { getSessionDir: () => "/tmp/web_default" } };
  await tool.execute("1", { action: "write", markdown: "- [ ] first\n- [ ] second" }, undefined, undefined, ctx);
  const editResult = await tool.execute("2", {
    action: "edit",
    edits: [{ oldText: "- [ ] second", newText: "- [x] second" }],
  }, undefined, undefined, ctx);

  expect(editResult.details.markdown).toBe("- [ ] first\n- [x] second");
});

test("legacy get/set arguments are prepared as read/write", async () => {
  resetPlanSidebarAddonForTests();
  let tool: any = null;
  const pi: any = {
    on() {},
    registerTool(definition: any) { tool = definition; },
  };
  planSidebarAddon(pi);

  const writeArgs = tool.prepareArguments({ action: "set", markdown: "- [ ] old" });
  const readArgs = tool.prepareArguments({ action: "get" });
  const editArgs = tool.prepareArguments({ action: "edit", oldText: "- [ ] old", newText: "- [x] old" });

  expect(writeArgs.action).toBe("write");
  expect(readArgs.action).toBe("read");
  expect(editArgs.edits).toEqual([{ oldText: "- [ ] old", newText: "- [x] old" }]);
});

test("plan edit rejects ambiguous matches without changing text", () => {
  expect(() => applyPlanEdits("- [ ] same\n- [ ] same", [{ oldText: "- [ ] same", newText: "- [x] same" }])).toThrow(/exactly once/);
});

test("web sidebar renders progress bar and collapsed meter", () => {
  const source = readFileSync(resolve(addonDir, "web", "index.ts"), "utf8");
  expect(() => new Bun.Transpiler({ loader: "ts" }).transformSync(source)).not.toThrow();
  expect(source).toContain("plan-sidebar-progress");
  expect(source).toContain("plan-sidebar-toggle-meter");
  expect(source).toContain("function getPlanProgress");
  expect(source).toContain("items complete");
});


test("visible sidebar listens for model plan update events and refreshes without clobbering dirty edits", () => {
  const source = readFileSync(resolve(addonDir, "web", "index.ts"), "utf8");
  expect(source).toContain('window.addEventListener("piclaw-extension-ui:status", handleRemotePlanUpdate);');
  expect(source).toContain('payload?.key !== "plan-sidebar.plan-updated"');
  expect(source).toContain("if (!state.open) return;");
  expect(source).toContain("void loadPlan({ preserveDirty: true, remote: true, remoteLabel });");
  expect(source).toContain("Plan changed remotely; save or refresh to update.");
});

test("collapsed progress meter loads the current chat plan", () => {
  const source = readFileSync(resolve(addonDir, "web", "index.ts"), "utf8");
  expect(source).toContain("else loadPlan();");
  expect(source).toContain("clearDisplayedPlan();");
  expect(source).toContain("loadPlan();\n  }");
});

test("submit-to-model prompt is concise and action oriented", () => {
  const source = readFileSync(resolve(addonDir, "web", "index.ts"), "utf8");
  expect(source).toContain("Use this `plan` tool checklist as the working plan.");
  expect(source).toContain("Report periodically on progress and next steps.");
  expect(source).not.toContain("editable shared state, not a static user note");
});

test("sidebar border and open tab use only a subtle open-state gradient hint", () => {
  const source = readFileSync(resolve(addonDir, "web", "index.ts"), "utf8");
  expect(source).toContain(".plan-sidebar-root.open .plan-sidebar-toggle");
  expect(source).toContain("right: var(--plan-sidebar-width, 380px)");
  expect(source).toContain("box-shadow: none;");
  expect(source).toContain(".plan-sidebar-panel::before");
  expect(source).toContain("opacity: 0;");
  expect(source).toContain(".plan-sidebar-root.open .plan-sidebar-panel::before { opacity: 1; }");
  expect(source).not.toContain("-18px 0 42px");
});

test("sidebar can close with Esc and autosaves dirty contents", () => {
  const source = readFileSync(resolve(addonDir, "web", "index.ts"), "utf8");
  expect(source).toContain('event.key !== "Escape"');
  expect(source).toContain("closeSidebar({ autosave: true })");
  expect(source).toContain("if (autosave && state.dirty)");
  expect(source).toContain("await savePlan();");
});
