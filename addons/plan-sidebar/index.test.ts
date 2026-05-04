import { expect, test } from "bun:test";
import planSidebarAddon, { loadSessionPlan, resetPlanSidebarAddonForTests, saveSessionPlan } from "./index";

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
  const pi: any = {
    on() {},
    registerTool(definition: any) { tool = definition; },
  };
  planSidebarAddon(pi);

  expect(tool?.name).toBe("plan");

  const ctx: any = { sessionManager: { getSessionDir: () => "/tmp/web_default" } };
  const setResult = await tool.execute("1", { action: "set", markdown: "- [x] done" }, undefined, undefined, ctx);
  expect(setResult.details.chat_jid).toBe("web:default");
  expect(setResult.details.markdown).toBe("- [x] done");

  const getResult = await tool.execute("2", { action: "get" }, undefined, undefined, ctx);
  expect(getResult.content[0].text).toContain("- [x] done");
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
  expect(result.systemPrompt).toContain("`plan` tool");
  expect(result.systemPrompt).toContain("- [ ] next step");
});
