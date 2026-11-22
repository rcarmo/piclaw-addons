import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { parse } from '@babel/parser';
import inventory from './tool-call-summary-inventory.json';
import { readDeprecatedAddons } from './scripts/lib/deprecated-addons.ts';

const root = import.meta.dir;
const active = inventory.addons.filter(addon => !addon.retired && addon.tools.length);
const callbacks = new Map<string, (args: unknown) => string | null | undefined>();
const modules = new Map<string, Readonly<Record<string, (args: unknown) => string | null | undefined>>>();
for (const addon of active) {
  // Pure modules only: never load device/FFI/browser/account entrypoints here.
  const { callSummaries } = await import(`./addons/${addon.addon}/summary.ts`);
  modules.set(addon.addon, callSummaries);
  for (const [name, callback] of Object.entries(callSummaries)) callbacks.set(name, callback as any);
}
const summary = (name: string, args: unknown) => callbacks.get(name)!(args);
const samples: Record<string, Record<string, unknown>> = {
  exec_command: { cmd: 'git status' }, proxmox: { action: 'workflow', workflow: 'vm.status', vmid: 100 },
  portainer: { action: 'workflow', workflow: 'container.inspect', endpoint_id: 2, name: 'api' },
  imap: { action: 'search', account: 'work', folder: 'INBOX' }, image_process: { action: 'resize', input: 'photo.png' },
  ava: { command: 'sensors' }, git_history: { mode: 'log' }, cheapskate: { action: 'status' }, restic: { action: 'status', config: null },
  remote_peer: { action: 'status' }, code_review: { action: 'threads' }, stealth_browser: { action: 'status' }, linkr: { action: 'status' },
};

for (const addon of active) test(`${addon.addon} owns a provider for every declared tool`, () => {
  const provided = modules.get(addon.addon)!;
  expect(Object.isFrozen(provided)).toBe(true);
  expect(Object.keys(provided).sort()).toEqual([...addon.tools].sort());
  for (const name of addon.tools) {
    const callback = provided[name];
    expect(Object.prototype.toString.call(callback)).toBe('[object Function]');
    const text = callback(samples[name] ?? {});
    expect(typeof text).toBe('string'); expect(text!.trim().length).toBeGreaterThan(3);
    expect(text).not.toMatch(/[\r\n]/); expect(text!.startsWith(`${name}:`)).toBe(false);
  }
});

test('all active catalogue tools are updated; retired releases remain immutable', () => {
  const catalogue = JSON.parse(readFileSync(join(root, 'catalog.json'), 'utf8'));
  expect(catalogue.addons).toHaveLength(46);
  expect(inventory.addons).toHaveLength(49);
  expect(active).toHaveLength(27); expect(callbacks.size).toBe(77);
  const retired = readDeprecatedAddons(root);
  expect(Object.keys(retired).sort()).toEqual(['delegate', 'plan-sidebar', 'session-dashboard']);
  for (const addon of active) expect(retired[addon.addon]).toBeUndefined();
}, 30000);

for (const [tool, api] of Object.entries(inventory.apis)) {
  for (const action of api.actions) test(`${tool} action ${action}`, () => {
    const text = summary(tool, { action }); expect(typeof text).toBe('string');
    expect(text).not.toContain('undefined'); expect(text).not.toBe('manage API connection');
  });
  for (const workflow of api.workflows) test(`${tool} workflow ${workflow}`, () => {
    const text = summary(tool, { action: 'workflow', workflow, vmid: 101, node: 'pve', endpoint_id: 2, name: 'api' });
    expect(typeof text).toBe('string'); expect(text).not.toContain(workflow);
    expect(text).not.toContain('run workflow'); expect(text).not.toContain('undefined'); expect(text).not.toMatch(/[\r\n]/);
  });
}
for (const [tool, operations] of Object.entries(inventory.operations)) {
  for (const operation of operations.values) test(`${tool} operation ${operation}`, () => {
    const text = summary(tool, { ...samples[tool], [operations.field]: operation })!;
    expect(typeof text).toBe('string'); expect(text).not.toContain('undefined'); expect(text).not.toMatch(/[\r\n]/);
    expect(text.split(' · ')[0]).not.toMatch(/[_.]/); expect(text).not.toMatch(/^(?:manage|control|run workflow)/);
  });
}

describe('operation wording and safe selectors', () => {
  for (const [name, args, expected] of [
    ['proxmox', { action: 'workflow', workflow: 'vm.start', vmid: 101, node: 'pve' }, 'start VM · 101 · pve'],
    ['proxmox', { action: 'workflow_help', workflow: 'vm.start' }, 'workflow help · start VM'],
    ['portainer', { action: 'workflow', workflow: 'container.restart', endpoint_id: 2, name: 'api' }, 'restart container · api · endpoint 2'],
    ['portainer', { action: 'workflow', workflow: 'stack.resolve', endpoint_id: 2, name: 'api' }, 'resolve stack · api · endpoint 2'],
    ['portainer', { action: 'workflow', workflow: 'container.upgrade_many', names: ['api', 'worker'], endpoint_id: 2 }, 'upgrade containers · 2 containers · endpoint 2'],
    ['proxmox', { action: 'request', method: 'GET', path: '/nodes/pve/status' }, 'GET /nodes/pve/status'],
    ['portainer', { action: 'request', requests: [{ method: 'POST', path: '/endpoints/2/docker/containers/api/restart' }, { path: '/endpoints/2/docker/info' }] }, '2 API requests · POST /endpoints/2/docker/containers/api/restart'],
    ['restic', { action: 'set_config', config: { enabled: true } }, 'update backup configuration'],
    ['remote_peer', { action: 'work_send', peer: 'alice', agent: 'reviewer' }, 'send work request · alice · reviewer'],
    ['code_review', { action: 'reply', threadId: 'thread-7' }, 'reply to review thread · thread-7'],
    ['imap', { action: 'move', account: 'work', folder: 'INBOX', targetFolder: 'Archive' }, 'move mail · work · INBOX → Archive'],
    ['image_process', { action: 'resize', input: 'photo.png', output: 'small.png' }, 'resize image · photo.png → small.png'],
    ['office_write', { path: 'report.docx', markdown: '# Report' }, 'write Office document · report.docx'],
    ['editable_table', { title: 'Release checklist', markdown: '| Task |' }, 'edit Markdown table · Release checklist'],
    ['stealth_browser', { action: 'goto', url: 'https://example.com/docs' }, 'open page · https://example.com/docs'],
    ['git_history', { mode: 'blame', file: 'src/main.ts' }, 'show line authorship · src/main.ts'],
    ['json_query', { expression: '.items[]', input: '{"items":[]}' }, 'query inline JSON'],
    ['win_screenshot', { titleMatch: 'Editor', outPath: 'screen.png' }, 'capture window · Editor · screen.png'],
    ['win_type', { text: 'private text' }, 'type text'],
    ['ava', { command: 'announce', text: 'private announcement' }, 'announce text'],
    ['ava', { command: 'volume', level: 0.5 }, 'set volume · 0.5'],
    ['m365_mail', { action: 'read', messageId: 'mail-7' }, 'read mail · mail-7'],
    ['m365_teams_send', { chatId: 'chat-7', message: 'private message' }, 'send Teams message · chat-7'],
    ['m365_graph_query', { method: 'PATCH', path: '/me/events/7?$select=subject', body: 'private body' }, 'PATCH /me/events/7'],
    ['m365_todo_task', { action: 'complete', listId: 'list-1', taskId: 'task-7' }, 'complete task · list-1 · task-7'],
    ['write_stdin', { session_id: 7, chars: '' }, 'read session output · 7'],
    ['write_stdin', { session_id: 7, chars: 'secret' }, 'send input to session · 7'],
    ['apply_patch', { input: '*** Begin Patch\n*** Update File: src/main.ts\n@@\n-old\n+new\n*** End Patch' }, 'apply patch · src/main.ts'],
    ['code_rewrite', {}, 'preview code rewrite'],
    ['code_rewrite', { dry_run: false }, 'rewrite code'],
  ] as const) test(`${name}: ${expected}`, () => expect(summary(name, args)).toBe(expected));
});

test('sensitive fields and unrecognised operations never become captions', () => {
  const secret = 'DONOTPUBLISHTHISVALUE938475';
  const payload = { password: secret, pass: secret, username: secret, api_token_keychain: secret,
    headers: { Authorization: secret }, body: secret, config: { passwordRef: secret }, text: secret,
    draftBody: secret, thought: secret, markdown: secret, notes: secret, prompt: secret, result: secret,
    ticket: secret, confirmation: secret, command: secret, command_args: [secret], input_data: secret,
    stack_file_content: secret, query: secret, expression: secret, expr: secret, expectedEtag: secret, requestKey: secret };
  for (const [name, callback] of callbacks) {
    if (name === 'exec_command') continue; // An intentional shell-command preview.
    const args = { ...samples[name], ...payload }, before = JSON.stringify(args);
    const text = callback(Object.freeze(args));
    expect(text).not.toContain(secret); expect(JSON.stringify(args)).toBe(before);
  }
  for (const [name, operations] of Object.entries(inventory.operations)) expect(summary(name, { [operations.field]: secret })).not.toContain(secret);
  for (const name of ['proxmox', 'portainer', 'm365_graph_query', 'stealth_browser', 'm365_document_link_metadata']) {
    const url = `https://user:${secret}@example.com/path?token=${secret}#${secret}`;
    expect(summary(name, { action: name === 'stealth_browser' ? 'goto' : 'request', method: 'GET', path: url, url })).not.toContain(secret);
  }
  expect(summary('image_process', { action: 'info', input: `https://user:${secret}@example.com/photo.png?token=${secret}` })).not.toContain(secret);
  expect(summary('portainer', { action: 'workflow', workflow: 'image.pull', image: `user:${secret}@registry.example/image` })).not.toContain(secret);
});

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    if (['node_modules', 'vendor', 'compat', 'web', 'tests', 'skills', 'assets'].includes(entry.name) || entry.name.startsWith('.')) return [];
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : /\.tsx?$/.test(path) && !/\.(?:test|spec|d)\.tsx?$/.test(path) ? [path] : [];
  });
}
function walk(node: any, visit: (node: any, ancestors: any[]) => void, ancestors: any[] = []) {
  if (!node || typeof node !== 'object') return;
  visit(node, ancestors);
  for (const [key, value] of Object.entries(node)) {
    if (['loc', 'comments', 'leadingComments', 'trailingComments', 'innerComments', 'tokens'].includes(key)) continue;
    if (Array.isArray(value)) for (const child of value) walk(child, visit, [...ancestors, node]);
    else if (value && typeof value === 'object') walk(value, visit, [...ancestors, node]);
  }
}
const functionNode = (node: any) => ['ArrowFunctionExpression', 'FunctionExpression', 'FunctionDeclaration'].includes(node.type);

test('every legacy/native tool declaration carries its own package provider, including dynamic To Do names', () => {
  let declarations = 0;
  for (const addon of active) {
    const found = new Set<string>(), directory = join(root, 'addons', addon.addon);
    for (const file of sourceFiles(directory)) {
      const text = readFileSync(file, 'utf8');
      const ast: any = parse(text, { sourceType: 'module', plugins: ['typescript', ...(file.endsWith('.tsx') ? ['jsx' as const] : [])] });
      walk(ast.program, (node, ancestors) => {
        if (node.type !== 'ObjectExpression') return;
        const props = new Map(node.properties.filter((p: any) => p.type === 'ObjectProperty').map((p: any) => [p.key.name ?? p.key.value, p.value]));
        const name: any = props.get('name');
        if (!name || !props.has('parameters')) return;
        declarations++;
        const metadata = node.properties.find((p: any) => p.type === 'SpreadElement' && p.argument.type === 'CallExpression' && p.argument.callee.name === 'toolCallSummary');
        expect(metadata, relative(root, file)).toBeDefined();
        const selector = metadata.argument.arguments[0];
        expect(selector.type).toBe('MemberExpression'); expect(selector.object.name).toBe('callSummaries');
        if (name.type === 'StringLiteral') {
          expect(selector.property.value ?? selector.property.name).toBe(name.value); found.add(name.value);
        } else {
          expect(name.type).toBe('Identifier'); expect(selector.property.name).toBe(name.name);
          const at = ancestors.findLastIndex(functionNode), fn = ancestors[at], binding = ancestors[at - 1];
          expect(binding?.type).toBe('VariableDeclarator');
          const parameter = fn.params.findIndex((p: any) => p.type === 'Identifier' && p.name === name.name);
          expect(parameter).toBeGreaterThanOrEqual(0);
          const scope = ancestors.slice(0, at).findLast(functionNode) ?? ast.program;
          walk(scope, call => { if (call.type === 'CallExpression' && call.callee.name === binding.id.name && call.arguments[parameter]?.type === 'StringLiteral') found.add(call.arguments[parameter].value); });
        }
        const summaryImport = ast.program.body.find((n: any) => n.type === 'ImportDeclaration' && n.specifiers.some((s: any) => s.local.name === 'callSummaries'));
        expect(resolve(dirname(file), summaryImport.source.value.replace(/\.js$/, '.ts'))).toBe(join(directory, 'summary.ts'));
      });
    }
    expect([...found].sort(), addon.addon).toEqual([...addon.tools].sort());
  }
  expect(declarations).toBe(79);
}, 30000);

test('pure formatter modules and vendored helpers cannot import runtime services or Core', () => {
  const template = readFileSync(join(root, 'lib/compat/tool-call-summary.ts'), 'utf8');
  for (const addon of active) {
    const directory = join(root, 'addons', addon.addon);
    expect(readFileSync(join(directory, 'compat/tool-call-summary.ts'), 'utf8')).toBe(template);
    for (const basename of ['summary.ts', ...(inventory.apis[addon.addon as keyof typeof inventory.apis] ? ['workflow-capabilities.ts'] : [])]) {
      const file = join(directory, basename), ast: any = parse(readFileSync(file, 'utf8'), { sourceType: 'module', plugins: ['typescript'] });
      walk(ast.program, (node, ancestors) => {
        if (node.type === 'ImportDeclaration') expect(['./compat/tool-call-summary.js', './workflow-capabilities.js']).toContain(node.source.value);
        // An operation key such as { fetch: 'fetch page' } is not a global read.
        const parent = ancestors.at(-1);
        const propertyKey = parent?.type === 'ObjectProperty' && parent.key === node && !parent.computed && !parent.shorthand;
        if (node.type === 'Identifier' && !propertyKey) expect(['Bun', 'process', 'globalThis', 'fetch', 'console', 'Date', 'setTimeout', 'setInterval', 'require', 'eval', 'Function']).not.toContain(node.name);
        expect(node.type).not.toBe('ImportExpression');
        if (functionNode(node)) expect(node.async).not.toBe(true);
      });
    }
  }
}, 30000);

test('all standalone archives contain their pure provider and helper closure', async () => {
  const { mkdtempSync, rmSync, existsSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { pathToFileURL } = await import('node:url');
  const { packAddon } = await import('./scripts/lib/pack-addon.ts');
  const temporary = mkdtempSync(join(tmpdir(), 'tool-summary-archives-'));
  try {
    for (const addon of active) {
      const directory = join(temporary, addon.addon), archive = join(temporary, `${addon.addon}.tgz`);
      const { mkdirSync } = await import('node:fs'); mkdirSync(directory);
      packAddon(join(root, 'addons', addon.addon), archive);
      const extracted = Bun.spawnSync(['tar', '-xzf', archive, '-C', directory]);
      expect(extracted.exitCode, addon.addon).toBe(0);
      const packageRoot = existsSync(join(directory, 'package.json')) ? directory : join(directory, 'package');
      expect(existsSync(join(packageRoot, 'summary.ts')), addon.addon).toBe(true);
      expect(existsSync(join(packageRoot, 'compat/tool-call-summary.ts')), addon.addon).toBe(true);
      const imported = await import(pathToFileURL(join(packageRoot, 'summary.ts')).href);
      expect(Object.keys(imported.callSummaries).sort(), addon.addon).toEqual([...addon.tools].sort());
      for (const name of addon.tools) expect(typeof imported.callSummaries[name](samples[name] ?? {})).toBe('string');
    }
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}, 120000);

test('execution declarations match the original audit or an exact, documented successor', async () => {
  const { createHash } = await import('node:crypto');
  const updates: Readonly<Record<string, { purpose: string; sha256: string[] }>> = inventory.executionBodyUpdates;
  for (const [file, update] of Object.entries(updates)) {
    expect(Object.hasOwn(inventory.executionBodyHashes, file), file).toBe(true);
    expect(update.purpose.trim(), file).not.toBe('');
  }
  for (const [file, baseline] of Object.entries(inventory.executionBodyHashes)) {
    const expected = updates[file]?.sha256 ?? baseline;
    const source = readFileSync(join(root, file), 'utf8');
    const ast: any = parse(source, { sourceType: 'module', plugins: ['typescript'] });
    const declarations: { at: number; sha256: string }[] = [];
    walk(ast.program, node => {
      const key = node.key?.name ?? node.key?.value;
      if ((['ObjectMethod', 'ClassMethod'].includes(node.type) || node.type === 'ObjectProperty') && key === 'execute') {
        declarations.push({ at: node.start, sha256: createHash('sha256').update(source.slice(node.start, node.end)).digest('hex') });
      }
    });
    expect(declarations.sort((a, b) => a.at - b.at).map(item => item.sha256), file).toEqual(expected);
  }
}, 30000);
