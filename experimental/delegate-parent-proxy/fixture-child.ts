// Disposable test entrypoint only; never imported or registered by Delegate.
import { createReadStream, createWriteStream, writeSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createAssistantMessageEventStream, createModels } from '@earendil-works/pi-ai';
import { ChildProxySession } from './child-session.ts';
import { childAgentOptions, createProxyProvider } from './provider.ts';
import { createPipeChannel } from './pipe.ts';
import type { ChildRequestPlanV1 } from './contracts.ts';

const mode = process.argv[2];
if (mode === 'truncated') { writeSync(4, Buffer.from([0, 0, 0])); process.exit(0); }
if (mode === 'stubborn') process.on('SIGTERM', () => {});
const deny = () => { throw Error('network forbidden'); };
globalThis.fetch = Object.assign(deny, { preconnect: deny }) as typeof fetch;
const plan: ChildRequestPlanV1 = { version: 1, execution: 'parent-provider-proxy', model: { provider: 'synthetic', id: 'fixture' }, mcp: 'none' };
const model = { ...plan.model, api: 'openai-completions', name: 'fixture', baseUrl: 'https://delegate.invalid', reasoning: false, input: ['text' as const], contextWindow: 10000, maxTokens: 100, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
let child!: ChildProxySession;
const input = createReadStream('', { fd: 3 }), output = createWriteStream('', { fd: 4 });
const channel = createPipeChannel(input, output, { data(bytes) { child.push(bytes); }, lost() { child.close('REQUEST_FAILED'); } });
child = new ChildProxySession({ plan, send: channel.send, disconnect: channel.close });
const proxy = createProxyProvider({ session: child, plan, model, createStream: createAssistantMessageEventStream });
const models = createModels(); models.setProvider(proxy.provider);
let grandchild: number | undefined;
if (mode === 'grandchild' || mode === 'inherited-grandchild') {
  const descendant = spawn(process.execPath, ['--no-env-file', '-e', 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'], { stdio: mode === 'inherited-grandchild' ? 'inherit' : 'ignore', env: { PATH: '/usr/bin:/bin' } });
  grandchild = descendant.pid; descendant.unref();
}
try {
  const responses: string[] = [];
  if (mode === 'agent') {
    const { createAgentSession, createExtensionRuntime, ModelRuntime, SessionManager, SettingsManager } = await import('@earendil-works/pi-coding-agent');
    const runtime = await ModelRuntime.create({ refreshOnCreate: false, allowModelNetwork: false, modelsPath: null,
      credentials: { async read() { return undefined; }, async list() { return []; }, async modify() { return undefined; }, async delete() {} },
      modelsStore: { async read() { return undefined; }, async write() {}, async delete() {} } });
    runtime.registerNativeProvider({ ...proxy.provider, streamSimple(m, c, o) { return proxy.provider.streamSimple(m, c, childAgentOptions(o)); } });
    const { session } = await createAgentSession({ cwd: process.cwd(), agentDir: process.env.PI_CODING_AGENT_DIR, model, modelRuntime: runtime,
      thinkingLevel: 'off', tools: ['read'], sessionManager: SessionManager.inMemory(),
      settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false, maxRetries: 0 } }),
      resourceLoader: { getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }), getSkills: () => ({ skills: [], diagnostics: [] }),
        getPrompts: () => ({ prompts: [], diagnostics: [] }), getThemes: () => ({ themes: [], diagnostics: [] }), getAgentsFiles: () => ({ agentsFiles: [] }),
        getSystemPrompt: () => 'Offline fixture. Read only the supplied fixture file.', getSystemPromptSource: () => undefined,
        getAppendSystemPrompt: () => [], getAppendSystemPromptSources: () => [], extendResources() {}, async reload() {} },
    });
    try { await session.prompt('fixture'); responses.push(session.getLastAssistantText() ?? ''); }
    finally { session.dispose(); runtime.unregisterProvider(model.provider); }
  }
  for (let i = 0; i < (mode === 'agent' ? 0 : mode === 'twice' ? 2 : 1); i++) {
    const stream = models.streamSimple(model, { messages: [{ role: 'user', content: 'fixture', timestamp: 1 }] }, { maxTokens: 10, maxRetries: 0 });
    if (mode === 'crash') { await Bun.sleep(30); process.exit(7); }
    for await (const _event of stream) { /* consume concurrently with parent pipe */ }
    const result = await stream.result();
    if (result.stopReason !== 'stop') process.exitCode = 1;
    responses.push(result.stopReason);
  }
  const envSafe = !['DELEGATE_TEST_PARENT_SECRET', 'NODE_OPTIONS', 'BUN_OPTIONS', 'OPENAI_API_KEY', 'OTEL_EXPORTER_OTLP_HEADERS'].some(key => process.env[key]);
  console.log(JSON.stringify({ responses, envSafe, profile: process.env.PI_CODING_AGENT_DIR, home: process.env.HOME, grandchild }));
} finally { await proxy.close(); }
