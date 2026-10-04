import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildDelegateModelChain, buildModelCandidates, classifyModel, getCurrentTier,
  getDelegateWorkspaceRoot, mergeExecutableRuntimeMetadata, parsePiListModelsOutput,
  selectModel, validateExplicitDelegateModel, validateDelegateResponseModel,
} from './delegate.ts';

// Synthetic preparation fixture, not a capture or claim of upstream availability/capabilities.
const models = parsePiListModelsOutput(`provider model context max-out thinking images
github-copilot gpt-6.1-sol 1M 128K yes yes
github-copilot gpt-6-sol 1M 128K yes yes
github-copilot gpt-5.4-mini 272K 128K yes yes
github-copilot claude-sonnet-5 1M 128K yes yes
github-copilot claude-opus-5.5 1M 128K yes yes
`);
const config = { searchable_providers: ['github-copilot'], excluded_providers: [], excluded_models: [] };
const fullId = 'github-copilot/gpt-6.1-sol';

test('GPT 6.1 Sol exact rule and punctuation aliases match tier 3 without accepting other variants', () => {
  for (const provider of ['github-copilot', 'openai', 'openai-codex', 'azure-openai']) {
    for (const id of ['gpt-6.1-sol', 'gpt-6-1-sol', 'GPT_6_1_SOL']) {
      expect(classifyModel({ provider, id })).toMatchObject({ status: 'classified', tier: 3, family: 'gpt', rule: 'gpt-6-1-sol', confidence: 'exact-policy', preference: 53 });
    }
  }
  for (const id of ['gpt-6.1', 'gpt-6.1-luna', 'gpt-6.1-sol-pro', 'gpt-6.1-sol-mini', 'gpt-6.1-sol-preview', 'gpt-6.1-sol:batch', 'gpt-6.10-sol', 'gpt-6.2-sol', 'openai/gpt-6.1-sol', 'gpt-6.1-solar']) {
    expect(classifyModel({ provider: 'github-copilot', id })).toMatchObject({ status: 'unclassified', tier: null });
  }
  expect(classifyModel('github-copilot/gpt-6-sol')).toMatchObject({ tier: 3, rule: 'gpt-6-sol', preference: 53 });
});

test('GPT 6.1 Sol approval/executable/image metadata gates remain independent of classification', () => {
  expect(buildModelCandidates(models)).toEqual([]);
  expect(validateExplicitDelegateModel(fullId, models, models, config).approved).toBe(true);
  for (const denied of [
    { ...config, searchable_providers: [] },
    { ...config, excluded_providers: ['github-copilot'] },
    { ...config, excluded_models: ['*6.1-sol*'] },
  ]) expect(validateExplicitDelegateModel(fullId, models, models, denied).approved).toBe(false);
  expect(validateExplicitDelegateModel(fullId, models.slice(1), models, config).error).toContain('not executable');
  expect(validateExplicitDelegateModel('github-copilot/gpt-6-1-sol', models, models, config).approved).toBe(false);
  const merged = mergeExecutableRuntimeMetadata(models.slice(1), models);
  expect(merged.some(model => model.fullId === fullId)).toBe(false);
  const noImages = models.map(model => ({ ...model, supportsImages: false as const }));
  expect(buildModelCandidates(noImages, config).find(model => model.id === fullId)?.supportsImages).toBe(false);
});

test('GPT 6.1 Sol parent/candidate selection keeps category caps, same-model delegation and judge preference', () => {
  expect(getCurrentTier({ model: { provider: 'github-copilot', id: 'gpt-6.1-sol' } })).toBe(3);
  const candidates = buildModelCandidates(models, config);
  const solCandidates = candidates.filter(model => [fullId, 'github-copilot/gpt-6-sol'].includes(model.id));
  // Equal policy preference retains the existing full-ID tiebreak; no silent promotion.
  expect(solCandidates.map(model => model.id)).toEqual(['github-copilot/gpt-6-sol', fullId]);
  expect(selectModel('code', 3, fullId, solCandidates)).toBe('github-copilot/gpt-6-sol');
  const sameOnly = candidates.filter(model => model.id === fullId);
  expect(selectModel('code', 3, fullId, sameOnly)).toBe(fullId);
  expect(selectModel('code', 2, 'github-copilot/gpt-5.4-mini', sameOnly)).toBeNull();
  expect(selectModel('quick', 3, fullId, sameOnly)).toBeNull();
  expect(selectModel('quick', 3, fullId, candidates)).toBe('github-copilot/gpt-5.4-mini');
  expect(selectModel('judge', 3, fullId, candidates)).toBe('github-copilot/claude-sonnet-5');
  const chain = buildDelegateModelChain('code', 3, fullId, candidates, 20);
  expect(chain).toContain(fullId);
  expect(chain.every(id => candidates.find(candidate => candidate.id === id)!.tier <= 3)).toBe(true);
  expect(validateDelegateResponseModel('github-copilot/gpt-6-sol', 'github-copilot', 'gpt-6.1-sol', candidates)).toBeNull();
  expect(validateDelegateResponseModel('github-copilot/gpt-6-sol', 'github-copilot', 'gpt-6.1-sol', candidates.filter(model => model.id !== fullId))).toBeTruthy();
});

test('synthetic GPT 6.1 Sol child executes, falls back safely and rejects unapproved or non-image-capable launches', async () => {
  const root = mkdtempSync(join(getDelegateWorkspaceRoot(), 'delegate-gpt61-'));
  const globals = globalThis as any, previous = globals.__piclaw_registerAddonConfigApi, oldCli = process.env.PI_DELEGATE_CLI;
  let configApi: any;
  try {
    const marker = join(root, 'attempts'), mode = join(root, 'mode'), cli = join(root, 'cli.ts'), image = join(root, 'image.png');
    writeFileSync(mode, 'ok');
    writeFileSync(image, Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]));
    writeFileSync(cli, `import {appendFileSync,readFileSync} from 'node:fs';
      if(process.argv.includes('--list-models')) {
        console.log('provider model context max-out thinking images');
        console.log('github-copilot gpt-6.1-sol 1M 128K yes no');
        console.log('github-copilot gpt-6-luna 1M 128K yes yes');
        console.log('github-copilot claude-opus-5.5 1M 128K yes yes');
        process.exit(0);
      }
      await Bun.stdin.text();
      const full=process.argv[process.argv.indexOf('--model')+1], mode=readFileSync(${JSON.stringify(mode)},'utf8');
      appendFileSync(${JSON.stringify(marker)},full+'\\n');
      if(mode==='auth'&&full.endsWith('gpt-6.1-sol')) {console.error('No API key for provider');process.exit(1);}
      if(mode==='unavailable'&&full.endsWith('gpt-6.1-sol')) {console.error('unknown model: synthetic unavailable');process.exit(1);}
      const id=full.split('/').slice(1).join('/');
      const [field,...rest]=mode.split(':');
      console.log(JSON.stringify({type:'message_end',message:{role:'assistant',provider:'github-copilot',model:field==='model'?rest.join(':'):id,responseModel:field==='response'?rest.join(':'):undefined,content:[{type:'text',text:'GPT61_FIXTURE_OK'}],stopReason:'stop'}}));
    `);
    process.env.PI_DELEGATE_CLI = `${process.execPath} ${cli}`;
    globals.__piclaw_registerAddonConfigApi = (_id: string, action: string, api: any) => { if (action === 'config') configApi = api; };
    const module = await import(`./delegate.ts?gpt61=${encodeURIComponent(root)}`);
    globals.__piclaw_registerAddonConfigApi = previous;
    let tool: any; module.default({ on() {}, registerTool(value: any) { tool = value; } });
    await configApi.set(config);
    const ctx = { model: { provider: 'github-copilot', id: 'gpt-6.1-sol' }, modelRegistry: { getAvailable() { return []; } } };
    const request = { prompt: 'offline fixture', task_category: 'code', tools: 'read' };
    const attempts = () => existsSync(marker) ? readFileSync(marker, 'utf8').trim().split('\n') : [];
    const execute = (params: any = {}, context: any = ctx) => tool.execute('fixture', { ...request, ...params }, undefined, undefined, context);
    expect((await execute()).content[0].text).toContain('GPT61_FIXTURE_OK');
    expect(attempts()).toEqual([fullId]);
    // Explicit model overrides the parent's tier, while preserving all other gates.
    const lower = { ...ctx, model: { provider: 'github-copilot', id: 'gpt-5.4-mini' } };
    expect((await execute({ model: fullId }, lower)).details.model).toBe(fullId);
    const before = attempts().length;
    await expect(execute({}, lower)).rejects.toThrow('within the current model tier');
    await expect(execute({ model: fullId, files: [image] })).rejects.toThrow('images=no');
    await configApi.set({ excluded_models: ['*6.1-sol*'] });
    await expect(execute({ model: fullId })).rejects.toThrow();
    await configApi.set({ excluded_models: [], searchable_providers: [] });
    await expect(execute()).rejects.toThrow('No approved');
    expect(attempts()).toHaveLength(before);
    await configApi.set(config);
    writeFileSync(mode, 'auth');
    const authCount = attempts().length;
    await expect(execute()).rejects.toThrow('[auth]');
    expect(attempts().slice(authCount)).toEqual([fullId]);
    writeFileSync(mode, 'unavailable');
    expect((await execute()).details.fallback_count).toBe(1);
    expect(attempts().slice(-2)).toEqual([fullId, 'github-copilot/gpt-6-luna']);
    const count = attempts().length;
    await expect(execute({ model: fullId })).rejects.toThrow();
    expect(attempts()).toHaveLength(count + 1);
    for (const field of ['model','response']) {
      for (const disclosed of ['gpt-6.1-sol-preview', 'claude-opus-5.5']) {
        writeFileSync(mode, `${field}:${disclosed}`);
        const count = attempts().length;
        await expect(execute()).rejects.toThrow('disclosed response model');
        expect(attempts()).toHaveLength(count + 1);
      }
      writeFileSync(mode, `${field}:gpt-6.1-sol`);
      await expect(execute({ model: 'github-copilot/gpt-6-luna', files: [image] })).rejects.toThrow('disclosed response model');
      expect((await execute()).details.model).toBe(fullId);
    }
  } finally {
    if (previous === undefined) delete globals.__piclaw_registerAddonConfigApi; else globals.__piclaw_registerAddonConfigApi = previous;
    if (oldCli === undefined) delete process.env.PI_DELEGATE_CLI; else process.env.PI_DELEGATE_CLI = oldCli;
    rmSync(root, { recursive: true, force: true });
  }
});
