import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { getDelegateWorkspaceRoot } from "./delegate.ts";

test("authentication failure never launches another approved provider/account", async () => {
  const root = mkdtempSync(join(getDelegateWorkspaceRoot(), "delegate-auth-stop-"));
  const globals = globalThis as any, registrar = globals.__piclaw_registerAddonConfigApi, oldCli = process.env.PI_DELEGATE_CLI;
  try {
    const marker = join(root, "attempts"), cli = join(root, "cli.ts");
    writeFileSync(cli, `import{appendFileSync}from'node:fs';if(process.argv.includes('--list-models')){console.log('provider model context max-out thinking images');console.log('github-copilot gpt-5.4 1M 128K yes yes');console.log('openai-codex gpt-5.4 1M 128K yes yes');process.exit(0);}await Bun.stdin.text();const id=process.argv[process.argv.indexOf('--model')+1];appendFileSync(${JSON.stringify(marker)},id+'\\n');if(id.startsWith('github-copilot/')){console.log(JSON.stringify({type:'message_end',message:{role:'assistant',content:[],stopReason:'error',errorMessage:'unknown model: synthetic'}}));console.error('No API key found for "github-copilot"');process.exit(1);}console.log(JSON.stringify({type:'message_end',message:{role:'assistant',provider:'openai-codex',model:'gpt-5.4',content:[{type:'text',text:'MUST_NOT_FALLBACK'}],stopReason:'stop'}}));`);
    process.env.PI_DELEGATE_CLI = `${process.execPath} ${cli}`;
    let config: any, tool: any;
    globals.__piclaw_registerAddonConfigApi = (_id: string, action: string, api: any) => { if (action === "config") config = api; };
    const module = await import(`./delegate.ts?auth-stop=${encodeURIComponent(root)}`);
    module.default({ on() {}, registerTool(value: any) { tool = value; } });
    await config.set({ searchable_providers: ["github-copilot", "openai-codex"], excluded_providers: [], excluded_models: [] });
    await expect(tool.execute("fixture", { prompt: "synthetic auth-stop fixture", task_category: "code", tools: "read" }, undefined, undefined, { model: { provider: "github-copilot", id: "gpt-6-sol" }, modelRegistry: { getAvailable() { return []; } } })).rejects.toThrow("[auth]");
    expect(readFileSync(marker, "utf8").trim().split("\n")).toEqual(["github-copilot/gpt-5.4"]);
  } finally {
    if (registrar === undefined) delete globals.__piclaw_registerAddonConfigApi; else globals.__piclaw_registerAddonConfigApi = registrar;
    if (oldCli === undefined) delete process.env.PI_DELEGATE_CLI; else process.env.PI_DELEGATE_CLI = oldCli;
    rmSync(root, { recursive: true, force: true });
  }
});
