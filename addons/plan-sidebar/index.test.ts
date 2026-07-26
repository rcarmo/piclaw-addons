import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import planSidebarAddon, { applyPlanEdits, applyPlanPatches, getStructuredSessionPlan, loadSessionPlan, normalizeStoredPlanMarkdown, normalizeUpdatePlanArgs, parsePlanMarkdown, resetPlanSidebarAddonForTests, resetSessionPlan, saveSessionPlan, updatePlanArgsToMarkdown } from "./index";

const addonDir = import.meta.dir;

test("plan compat storage avoids runtime source imports", () => {
  const source = readFileSync(resolve(addonDir, "compat", "extension-kv.ts"), "utf8");
  expect(source).not.toContain("require(");
  expect(source).not.toContain("piclaw/runtime/src");
});

test("plan tool schema uses string enums throughout", () => {
  let tool: any = null;
  planSidebarAddon({ on() {}, registerTool(definition: any) { tool = definition; } } as any);
  const properties = tool.parameters.properties;
  expect(properties.action).toMatchObject({ type: "string", enum: ["read", "write", "edit", "patch", "update"] });
  expect(properties.plan.items.properties.status).toMatchObject({ type: "string", enum: ["pending", "in_progress", "completed"] });
  expect(properties.edits.items.properties.operation).toMatchObject({ type: "string", enum: ["replace", "delete", "insert_after", "insert_before", "append", "prepend"] });
  expect(properties.patches.items.properties.operation).toMatchObject({ type: "string", enum: ["add", "update", "remove"] });
  expect(properties.patches.items.properties.status).toMatchObject({ type: "string", enum: ["pending", "in_progress", "completed"] });
  expect(properties.patches.items.properties.position).toMatchObject({ type: "string", enum: ["start", "end"] });
});

test("plan storage is scoped by chat jid", () => {
  resetPlanSidebarAddonForTests();

  const first = saveSessionPlan("web:alpha", "- [ ] alpha");
  const second = saveSessionPlan("web:beta", "- [ ] beta");

  expect(first.markdown).toBe("- [ ] alpha");
  expect(second.markdown).toBe("- [ ] beta");
  expect(loadSessionPlan("web:alpha").markdown).toBe("- [ ] alpha");
  expect(loadSessionPlan("web:beta").markdown).toBe("- [ ] beta");
});

test("runtime API exposes structured session plans for sibling add-ons", () => {
  resetPlanSidebarAddonForTests();
  saveSessionPlan("web:goal", "> evidence\n\n- [x] done\n- [ ] next");
  const direct = getStructuredSessionPlan("web:goal");
  expect(direct.explanation).toBe("evidence");
  expect(direct.plan).toEqual([
    { step: "done", status: "completed" },
    { step: "next", status: "pending" },
  ]);
  const api = (globalThis as any).__piclaw_planSidebarApi;
  expect(typeof api?.getPlan).toBe("function");
  expect(api.getPlan("web:goal").plan).toEqual(direct.plan);
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
      data: { key: "plan.changes", addon: "plan-sidebar", chat_jid: "web:default", source: "tool", action: "write" },
    });

    const readResult = await tool.execute("2", { action: "read" }, undefined, undefined, ctx);
    expect(readResult.content[0].text).toContain("- [x] done");
  } finally {
    if (previousBroadcast) (globalThis as any).__PICLAW_BROADCAST_EVENT__ = previousBroadcast;
    else delete (globalThis as any).__PICLAW_BROADCAST_EVENT__;
  }
});

test("plan action=update stores a Codex-style structured plan in the sidebar", async () => {
  resetPlanSidebarAddonForTests();
  const tools = new Map<string, any>();
  const events: Array<{ type: string; data: any }> = [];
  const previousBroadcast = (globalThis as any).__PICLAW_BROADCAST_EVENT__;
  (globalThis as any).__PICLAW_BROADCAST_EVENT__ = (type: string, data: any) => events.push({ type, data });
  const pi: any = {
    on() {},
    registerTool(definition: any) { tools.set(definition.name, definition); },
  };
  try {
    planSidebarAddon(pi);
    expect([...tools.keys()]).toEqual(["plan"]);
    const planTool = tools.get("plan");
    expect(planTool?.description).toContain("action=update");
    expect(planTool?.description).toContain("at most one in_progress");

    const ctx: any = { sessionManager: { getSessionDir: () => "/tmp/web_default" } };
    const result = await planTool.execute("1", {
      action: "update",
      explanation: "Reorder after inspection",
      plan: [
        { step: "Inspect current code", status: "completed" },
        { step: "Port plan action=update contract", status: "in_progress" },
        { step: "Run tests", status: "pending" },
      ],
    }, undefined, undefined, ctx);

    expect(result.content[0].text).toBe("Plan updated.");
    expect(result.details.markdown).toBe("> Reorder after inspection\n\n- [x] Inspect current code\n- [-] Port plan action=update contract\n- [ ] Run tests");
    expect(result.details.plan).toEqual([
      { step: "Inspect current code", status: "completed" },
      { step: "Port plan action=update contract", status: "in_progress" },
      { step: "Run tests", status: "pending" },
    ]);
    expect(result.details.explanation).toBe("Reorder after inspection");
    expect(loadSessionPlan("web:default").markdown).toContain("- [-] Port plan action=update contract");
    expect(events.at(-1)).toMatchObject({
      type: "extension_ui_status",
      data: { key: "plan.changes", addon: "plan-sidebar", chat_jid: "web:default", source: "tool", action: "update" },
    });
  } finally {
    if (previousBroadcast) (globalThis as any).__PICLAW_BROADCAST_EVENT__ = previousBroadcast;
    else delete (globalThis as any).__PICLAW_BROADCAST_EVENT__;
  }
});

test("plan action=update rejects multiple in-progress steps", () => {
  expect(() => normalizeUpdatePlanArgs({
    plan: [
      { step: "first", status: "in_progress" },
      { step: "second", status: "in_progress" },
    ],
  })).toThrow(/at most one in_progress/);
});

test("plan action=update markdown conversion normalizes status markers", () => {
  expect(updatePlanArgsToMarkdown({
    plan: [
      { step: "done", status: "completed" },
      { step: "working", status: "in_progress" },
      { step: "later", status: "pending" },
    ],
  })).toBe("- [x] done\n- [-] working\n- [ ] later");
});

test("Markdown parsing and normalization expose the same structured plan data", () => {
  const markdown = "> why\n\n- [X]  done now\n- [-] working now\n- [ ] later";
  expect(normalizeStoredPlanMarkdown(markdown)).toBe("> why\n\n- [x]  done now\n- [-] working now\n- [ ] later");
  expect(parsePlanMarkdown(markdown)).toMatchObject({
    explanation: "why",
    plan: [
      { step: "done now", status: "completed" },
      { step: "working now", status: "in_progress" },
      { step: "later", status: "pending" },
    ],
    inProgressCount: 1,
  });
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
  expect(result.systemPrompt).toContain("`plan` tool with `action=patch`");
  expect(result.systemPrompt).toContain("Use `action=update` for structured full-plan replacement");
  expect(result.systemPrompt).toContain("pending`, `in_progress`, or `completed`");
  expect(result.systemPrompt).toContain("action=read");
  expect(result.systemPrompt).toContain("action=edit");
  expect(result.systemPrompt).toContain("action=write");
  expect(result.systemPrompt).toContain("at most one `[-]`");
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

test("plan edit supports batch insert, delete, append, and replace operations", async () => {
  resetPlanSidebarAddonForTests();
  let tool: any = null;
  const pi: any = {
    on() {},
    registerTool(definition: any) { tool = definition; },
  };
  planSidebarAddon(pi);

  const ctx: any = { sessionManager: { getSessionDir: () => "/tmp/web_default" } };
  await tool.execute("1", { action: "write", markdown: "- [ ] first\n- [ ] second\n- [ ] remove me" }, undefined, undefined, ctx);
  const editResult = await tool.execute("2", {
    action: "edit",
    edits: [
      { operation: "replace", oldText: "- [ ] first", newText: "- [x] first" },
      { operation: "insert_after", anchorText: "- [ ] second", text: "\n- [-] inserted active\n- [ ] inserted pending" },
      { operation: "delete", oldText: "\n- [ ] remove me" },
      { operation: "append", text: "\n- [ ] final appended" },
    ],
  }, undefined, undefined, ctx);

  expect(editResult.details.markdown).toBe("- [x] first\n- [ ] second\n- [-] inserted active\n- [ ] inserted pending\n- [ ] final appended");
});

test("plan patch applies multi-item add/update/remove operations by index or step match", async () => {
  resetPlanSidebarAddonForTests();
  let tool: any = null;
  const pi: any = {
    on() {},
    registerTool(definition: any) { tool = definition; },
  };
  planSidebarAddon(pi);

  const ctx: any = { sessionManager: { getSessionDir: () => "/tmp/web_default" } };
  await tool.execute("1", { action: "write", markdown: "> Keep this note\n\n- [ ] inspect\n- [-] implement\n- [ ] obsolete" }, undefined, undefined, ctx);
  const patchResult = await tool.execute("2", {
    action: "patch",
    patches: [
      { operation: "update", match: "inspect", status: "completed" },
      { operation: "update", match: "implement", step: "implement batch patches", status: "in_progress" },
      { operation: "remove", match: "obsolete" },
      { operation: "add", after: "implement batch patches", step: "run patch tests", status: "pending" },
      { operation: "add", position: "start", step: "write down goal", status: "completed" },
    ],
  }, undefined, undefined, ctx);

  expect(patchResult.content[0].text).toBe("Patched plan for web:default.");
  expect(patchResult.details.markdown).toBe("> Keep this note\n\n- [x] write down goal\n- [x] inspect\n- [-] implement batch patches\n- [ ] run patch tests");
  expect(patchResult.details.plan).toEqual([
    { step: "write down goal", status: "completed" },
    { step: "inspect", status: "completed" },
    { step: "implement batch patches", status: "in_progress" },
    { step: "run patch tests", status: "pending" },
  ]);
});


test("plan patch rejects ambiguous matches and multiple in-progress items", () => {
  expect(() => applyPlanPatches("- [ ] same\n- [ ] same", [{ operation: "update", match: "same", status: "completed" }])).toThrow(/exactly one/);
  expect(() => applyPlanPatches("- [-] active\n- [ ] next", [{ operation: "update", match: "next", status: "in_progress" }])).toThrow(/at most one/);
});


test("legacy get/set arguments are prepared as read/write and patches imply patch action", async () => {
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
  const patchArgs = tool.prepareArguments({ patches: [{ operation: "add", step: "new" }] });

  expect(writeArgs.action).toBe("write");
  expect(readArgs.action).toBe("read");
  expect(editArgs.edits).toEqual([{ oldText: "- [ ] old", newText: "- [x] old" }]);
  expect(patchArgs.action).toBe("patch");
});

test("plan edit rejects ambiguous matches without changing text", () => {
  expect(() => applyPlanEdits("- [ ] same\n- [ ] same", [{ oldText: "- [ ] same", newText: "- [x] same" }])).toThrow(/exactly once/);
});

test("plan write and edit reject multiple in-progress Markdown items", async () => {
  resetPlanSidebarAddonForTests();
  let tool: any = null;
  const pi: any = {
    on() {},
    registerTool(definition: any) { tool = definition; },
  };
  planSidebarAddon(pi);

  const ctx: any = { sessionManager: { getSessionDir: () => "/tmp/web_default" } };
  await expect(tool.execute("1", { action: "write", markdown: "- [-] first\n- [-] second" }, undefined, undefined, ctx)).rejects.toThrow(/at most one/);
  await tool.execute("2", { action: "write", markdown: "- [-] first\n- [ ] second" }, undefined, undefined, ctx);
  await expect(tool.execute("3", {
    action: "edit",
    edits: [{ oldText: "- [ ] second", newText: "- [-] second" }],
  }, undefined, undefined, ctx)).rejects.toThrow(/at most one/);
});

test("resetSessionPlan restores the canonical default Markdown", () => {
  resetPlanSidebarAddonForTests();
  saveSessionPlan("web:default", "- [x] custom");
  const reset = resetSessionPlan("web:default");
  expect(reset.markdown).toContain("- [ ] Update this plan thoroughly with ongoing work");
  expect(reset.markdown).toContain("- [ ] Verify the result");
  expect(parsePlanMarkdown(reset.markdown).inProgressCount).toBe(0);
});

test("web sidebar renders progress bar and collapsed meter", () => {
  const source = readFileSync(resolve(addonDir, "web", "index.ts"), "utf8");
  expect(() => new Bun.Transpiler({ loader: "ts" }).transformSync(source)).not.toThrow();
  expect(source).toContain("plan-sidebar-progress");
  expect(source).toContain("plan-sidebar-toggle-meter");
  expect(source).toContain("function getPlanProgress");
  expect(source).toContain("items complete");
});


test("web sidebar uses a real wrapped Markdown editor with checklist decorations for human editing", () => {
  const source = readFileSync(resolve(addonDir, "web", "index.ts"), "utf8");
  expect(source).toContain('await import("/editor-vendor/codemirror.js")');
  expect(source).toContain("cm.EditorView.lineWrapping");
  expect(source).toContain("buildPlanDecorationsExtension(cm)");
  expect(source).toContain("plan-sidebar-cm-checkbox-current");
  expect(source).toContain("plan-sidebar-cm-line-current");
  expect(source).toContain('const textarea = document.createElement("textarea")');
  expect(source).toContain('textarea.className = "plan-sidebar-textarea plan-sidebar-markdown-source"');
  expect(source).toContain('textarea.wrap = "soft"');
  expect(source).toContain("state.fallbackTextarea?.focus()");
  expect(source).toContain("white-space: pre-wrap;");
  expect(source).not.toContain('contentEditable = "plaintext-only"');
  expect(source).not.toContain('checkbox.type = "checkbox"');
  expect(source).not.toContain('preview.className = "plan-sidebar-live-preview"');
  expect(source).not.toContain("display: none !important");
});


test("sidebar listens for plan.changes events and refreshes without clobbering dirty edits", () => {
  const source = readFileSync(resolve(addonDir, "web", "index.ts"), "utf8");
  expect(source).toContain('window.addEventListener("piclaw-extension-ui:status", handleRemotePlanUpdate);');
  expect(source).toContain('key !== "plan.changes" && key !== "plan-sidebar.plan-updated"');
  expect(source).not.toContain("if (!state.open) return;");
  expect(source).toContain("void loadPlan({ preserveDirty: true, remote: true, remoteLabel });");
  expect(source).toContain("Plan changed remotely; save or refresh to update.");
});

test("collapsed progress meter loads the current chat plan", () => {
  const source = readFileSync(resolve(addonDir, "web", "index.ts"), "utf8");
  expect(source).toContain("else loadPlan();");
  expect(source).toContain("clearDisplayedPlan();");
  expect(source).toContain("loadPlan();\n  }");
});

test("web sidebar exposes a reset button backed by the plan API", () => {
  const source = readFileSync(resolve(addonDir, "web", "index.ts"), "utf8");
  expect(source).toContain("plan-sidebar-reset");
  expect(source).toContain("async function resetPlan()");
  expect(source).toContain('action: "reset"');
  expect(source).toContain('resetButton.addEventListener("click"');
  expect(source).toContain("setEditorValue(plan.markdown || \"\")");
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
