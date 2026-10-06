import { isAbsolute, normalize, relative } from 'node:path';
import type { ApprovedFileExport, ApprovedRuntimeFile } from './confinement.ts';
import type { ChildRequestScopeV1 } from './contracts.ts';

export type HostAdmissionErrorCode = 'UNSUPPORTED_DOMAIN' | 'INVALID_POLICY' | 'DENIED' | 'CANCELLED' | 'FAILED' | 'CLEANUP_FAILED';
export class HostAdmissionError extends Error {
  constructor(readonly code: HostAdmissionErrorCode) { super(code); this.name = 'HostAdmissionError'; }
}
/** No default limits. A qualified provider must enforce these for the whole
 * descendant tree, including staging storage, before executing any child code. */
export interface ResourceLimitsV1 {
  cpuQuotaMicros: number;
  cpuPeriodMicros: number;
  cpuTimeMs: number;
  memoryBytes: number; // aggregate memory; swapping must be disabled
  pids: number; // includes threads, init and detached descendants
  writableBytes: number; // /work + private /tmp + /home, including staging
  writableInodes: number;
}
export interface FiniteLaunchPolicyV1 {
  helper: string;
  helperSha256: string;
  runtime: readonly ApprovedRuntimeFile[];
  files: readonly ApprovedFileExport[];
  profile: 'read_only' | 'workspace_write';
  tools: readonly ('read' | 'bash')[];
  entrypoint: string;
  args: readonly string[];
  limits: ResourceLimitsV1;
}
/** Captured by core at an already-admitted tool invocation; never IPC input.
 * authorise is a synchronous revocation/policy check against captured authority. */
export interface AdmittedInvocationV1 {
  addonId: string;
  workId: string;
  chatJid: string;
  toolCallId: string;
  model: { provider: string; id: string };
  deadlineAt: number;
  signal: AbortSignal;
  authorise(): void;
}
export type InvocationBindingV1 = Readonly<Omit<AdmittedInvocationV1, 'authorise' | 'signal'>>;
export interface HostOwnedTask<T> {
  /** Allocation result must return every allocated handle, even after cancel,
   * or clean it up before rejection. Never hide an allocation behind an abort race. */
  result: Promise<T>;
  settled: Promise<void>;
  cancel(): void;
}
export interface DomainResultV1 { exitCode: number; output: string; }
export interface ProvisionedDomainV1 {
  /** Snapshot staging, namespace/bootstrap and every descendant must stay in the
   * already provisioned resource domain. No parent-default /tmp or spawn fallback.
   * scope is guarded; binding/policy are host-only and must never be sent to child. */
  execute(input: {
    binding: InvocationBindingV1;
    policy: Readonly<FiniteLaunchPolicyV1>;
    scope: ChildRequestScopeV1;
    signal: AbortSignal;
    authorise(): void; // recheck immediately before admitting child code
  }): HostOwnedTask<DomainResultV1>;
  /** Stop admission, kill/drain all descendants and storage cleanup, then release
   * OS resource ownership. A timeout or failed cleanup must not fake this ACK. */
  close(): Promise<void>;
}
export interface HostDomainProvisionerV1 {
  /** This discriminator is descriptive, not proof. Only trusted host composition
   * may supply a qualified provider. No concrete production provider ships here. */
  kind: 'qualified-linux-resource-domain-v1' | 'synthetic-test-domain-v1';
  provision(input: {
    binding: InvocationBindingV1;
    limits: Readonly<ResourceLimitsV1>;
    signal: AbortSignal;
  }): HostOwnedTask<ProvisionedDomainV1>;
}
export interface AdmittedLaunchV1 {
  run(): Promise<DomainResultV1>; // one-shot; no caller-selected paths, IDs or args
  close(): Promise<void>;
}
function invalid(): never { throw new HostAdmissionError('INVALID_POLICY'); }
function keys(value: unknown, allowed: string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    || Reflect.ownKeys(value).some(k => typeof k !== 'string' || !allowed.includes(k))) invalid();
}
function text(value: unknown, max = 4096): asserts value is string {
  if (typeof value !== 'string' || !value || value.length > max || value.includes('\0')) invalid();
}
function absolute(path: unknown): asserts path is string {
  text(path); if (!isAbsolute(path) || normalize(path) !== path) invalid();
}
function target(path: unknown): asserts path is string {
  text(path); if (isAbsolute(path) || normalize(path) !== path || path.split('/').some(p => !p || p === '.' || p === '..')) invalid();
}
function digest(value: unknown) { if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) invalid(); }
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { for (const item of Object.values(value)) freeze(item); Object.freeze(value); }
  return value;
}
/** Policy is a trusted, finite approved export list, not a file discovery rule.
 * Actual regular-file/owner/mode/hash checks remain mandatory at domain staging. */
export function captureLaunchPolicy(input: FiniteLaunchPolicyV1): Readonly<FiniteLaunchPolicyV1> {
  const policy = structuredClone(input);
  keys(policy, ['helper','helperSha256','runtime','files','profile','tools','entrypoint','args','limits']);
  absolute(policy.helper); digest(policy.helperSha256);
  if (!['read_only','workspace_write'].includes(policy.profile)) invalid();
  if (!Array.isArray(policy.tools) || !policy.tools.length || policy.tools.length > 2
    || new Set(policy.tools).size !== policy.tools.length || policy.tools.some(t => !['read','bash'].includes(t))) invalid();
  if (!policy.tools.includes('bash') && policy.profile !== 'read_only') invalid();
  absolute(policy.entrypoint); if (!policy.entrypoint.startsWith('/app/')) invalid();
  if (!Array.isArray(policy.args) || policy.args.length > 64) invalid();
  for (const arg of policy.args) text(arg, 8192);
  if (Buffer.byteLength(JSON.stringify(policy.args)) > 32768) invalid();
  if (!Array.isArray(policy.runtime) || !policy.runtime.length || policy.runtime.length > 128
    || !Array.isArray(policy.files) || policy.files.length > 256) invalid();
  const paths = new Set<string>();
  function unique(path: string) {
    if ([...paths].some(p => p === path || p.startsWith(path + '/') || path.startsWith(p + '/'))) invalid();
    paths.add(path);
  }
  for (const file of policy.runtime) {
    keys(file, ['source','target','sha256','executable']); absolute(file.source); target(file.target); digest(file.sha256);
    if (file.executable !== undefined && typeof file.executable !== 'boolean') invalid();
    const destination = file.target;
    if (!['app/','bin/','usr/bin/','lib/','lib64/'].some(prefix => destination.startsWith(prefix))) invalid();
    unique(file.target);
  }
  if (!policy.runtime.some(f => f.target === 'bin/bun' && f.executable)
    || !policy.runtime.some(f => '/' + f.target === policy.entrypoint)
    || policy.tools.includes('bash') && !policy.runtime.some(f => f.target === 'bin/bash' && f.executable)) invalid();
  const sources = new Set<string>();
  for (const file of policy.files) {
    keys(file, ['source','exportRoot','target','sha256']); absolute(file.source); absolute(file.exportRoot); target(file.target); digest(file.sha256);
    const rel = relative(file.exportRoot, file.source);
    if (!rel || rel.startsWith('../') || isAbsolute(rel) || file.exportRoot === '/' || sources.has(file.source)) invalid();
    sources.add(file.source); unique('work/' + file.target);
  }
  keys(policy.limits, ['cpuQuotaMicros','cpuPeriodMicros','cpuTimeMs','memoryBytes','pids','writableBytes','writableInodes']);
  for (const name of ['cpuQuotaMicros','cpuPeriodMicros','cpuTimeMs','memoryBytes','pids','writableBytes','writableInodes'] as const)
    if (!Number.isSafeInteger(policy.limits[name]) || policy.limits[name] <= 0) invalid();
  if (policy.limits.cpuQuotaMicros > policy.limits.cpuPeriodMicros || policy.limits.cpuPeriodMicros > 1000000
    || policy.limits.cpuTimeMs > 300000 || policy.limits.pids > 4096
    || policy.limits.memoryBytes > 64 * 1024 ** 3 || policy.limits.writableBytes > 64 * 1024 ** 3
    || policy.limits.writableInodes > 1000000) invalid();
  if (Buffer.byteLength(JSON.stringify(policy)) > 1024 * 1024) invalid();
  return freeze(policy);
}

/** Trusted host factory only. No global registration and no cgroup/service mutation.
 * Production without a separately qualified provider is deliberately unsupported. */
export function createHostAdmission(input: {
  mode: 'production' | 'offline-test';
  policy: FiniteLaunchPolicyV1;
  provisioner?: HostDomainProvisionerV1;
}) {
  const policy = captureLaunchPolicy(input.policy), provisioner = input.provisioner;
  const supported = input.mode === 'production'
    ? provisioner?.kind === 'qualified-linux-resource-domain-v1'
    : input.mode === 'offline-test' && provisioner?.kind === 'synthetic-test-domain-v1';
  // Capture function identities; replacing a provider's methods later cannot redirect admission.
  const provision = supported ? provisioner!.provision.bind(provisioner) : undefined;
  const launches = new Set<AdmittedLaunchV1>(), ownedScopes = new WeakSet<ChildRequestScopeV1>();
  let stopping = false, shutdown: Promise<void> | undefined;
  return Object.freeze({
    admit(invocation: AdmittedInvocationV1, ownedScope: ChildRequestScopeV1): AdmittedLaunchV1 {
      if (!provision || stopping) throw new HostAdmissionError('UNSUPPORTED_DOMAIN');
      if (launches.size >= 64 || ownedScopes.has(ownedScope)) throw new HostAdmissionError('DENIED');
      const { authorise: authority, signal, ...rawBinding } = invocation;
      const authorise = typeof authority === 'function' ? authority.bind(invocation) : authority;
      const binding = freeze(structuredClone(rawBinding));
      keys(binding, ['addonId','workId','chatJid','toolCallId','model','deadlineAt']);
      for (const value of [binding.addonId,binding.workId,binding.chatJid,binding.toolCallId]) text(value, 256);
      keys(binding.model, ['provider','id']); text(binding.model.provider,256); text(binding.model.id,256);
      if (!(signal instanceof AbortSignal) || typeof authorise !== 'function'
        || !Number.isSafeInteger(binding.deadlineAt) || binding.deadlineAt <= Date.now() || binding.deadlineAt > Date.now()+300000) throw new HostAdmissionError('DENIED');
      const plan = freeze(structuredClone(ownedScope.plan));
      if (plan.version !== 1 || plan.execution !== 'parent-provider-proxy' || plan.mcp !== 'none'
        || plan.model.provider !== binding.model.provider || plan.model.id !== binding.model.id) throw new HostAdmissionError('DENIED');
      const scopeStream = ownedScope.stream.bind(ownedScope), scopeClose = ownedScope.close.bind(ownedScope);
      const controller = new AbortController(), lifetime = AbortSignal.any([signal, controller.signal]);
      let started = false, closing: Promise<void> | undefined, running: Promise<DomainResultV1> | undefined;
      let allocation: HostOwnedTask<ProvisionedDomainV1> | undefined, execution: HostOwnedTask<DomainResultV1> | undefined;
      let domain: ProvisionedDomainV1 | undefined, domainClose: (()=>Promise<void>) | undefined;
      let cleanupFailed = false, scopeClosed: Promise<void> | undefined, domainClosed: Promise<void> | undefined;
      const tails = new Set<Promise<void>>(), cancelledTasks = new Set<HostOwnedTask<unknown>>();
      function observe(task: HostOwnedTask<unknown>) {
        const tail = task.settled.then(() => {}, () => { cleanupFailed = true; });
        tails.add(tail); void tail.then(() => tails.delete(tail));
      }
      function closeScope() { return scopeClosed ??= Promise.resolve().then(scopeClose); }
      function closeDomain() { return domainClosed ??= Promise.resolve().then(() => domainClose?.()); }
      function stop() {
        controller.abort();
        for (const task of [allocation, execution]) {
          if (!task || cancelledTasks.has(task)) continue;
          cancelledTasks.add(task); try { task.cancel(); } catch { cleanupFailed = true; }
        }
        void closeScope().catch(() => { cleanupFailed = true; });
        if (domain) void closeDomain().catch(() => { cleanupFailed = true; });
      }
      function check() {
        if (stopping || closing || lifetime.aborted || Date.now() >= binding.deadlineAt) throw new HostAdmissionError('CANCELLED');
        const returned: unknown = authorise();
        if (returned && (typeof returned === 'object' || typeof returned === 'function') && 'then' in returned && typeof returned.then === 'function') {
          const tail = Promise.resolve(returned).then(() => {}, () => {}); tails.add(tail); void tail.then(()=>tails.delete(tail));
          throw new HostAdmissionError('DENIED');
        }
        if (stopping || closing || lifetime.aborted || Date.now() >= binding.deadlineAt) throw new HostAdmissionError('CANCELLED');
      }
      const guardedScope: ChildRequestScopeV1 = Object.freeze<ChildRequestScopeV1>({ plan,
        stream(context, options, request) { check(); if (scopeClosed) throw new HostAdmissionError('DENIED'); return scopeStream(context, options, request); }, close: closeScope });
      async function finish() {
        stop();
        const results = await Promise.allSettled([closeScope(), ...(domain ? [closeDomain()] : []), ...tails]);
        while (tails.size) await Promise.all([...tails]);
        clearTimeout(timer); signal.removeEventListener('abort', abort);
        if (results.some(r=>r.status==='rejected')) cleanupFailed = true;
        if (cleanupFailed) throw new HostAdmissionError('CLEANUP_FAILED');
      }
      const abort = () => { void handle.close().catch(()=>{}); };
      const timer = setTimeout(abort, Math.max(1, binding.deadlineAt-Date.now()));
      const handle: AdmittedLaunchV1 = Object.freeze({
        run() {
          if (started || closing) return Promise.reject(new HostAdmissionError('DENIED'));
          started = true;
          // Publish the operation before any provisioner/authority callback can re-enter.
          running = Promise.resolve().then(async () => {
            try {
              check();
              allocation = provision({ binding, limits: policy.limits, signal: lifetime }); observe(allocation);
              domain = await allocation.result; domainClose = domain.close.bind(domain);
              const execute = domain.execute.bind(domain);
              check(); await allocation.settled; check();
              execution = execute({ binding, policy, scope: guardedScope, signal: lifetime, authorise: check }); observe(execution);
              const result = await execution.result; await execution.settled;
              check();
              if (result.exitCode !== 0 || typeof result.output !== 'string' || Buffer.byteLength(result.output)>64000) throw new HostAdmissionError('FAILED');
              return { exitCode: 0, output: result.output };
            } catch { throw new HostAdmissionError(stopping || closing || lifetime.aborted ? 'CANCELLED' : 'FAILED'); }
            finally { await finish(); }
          });
          void running.then(() => launches.delete(handle), () => {}); // failures retained until explicit close/shutdown
          return running;
        },
        close() {
          if (!closing) {
            closing = Promise.resolve().then(async () => {
              stop();
              if (running) await running.catch(()=>{}); else await finish();
              if (cleanupFailed) throw new HostAdmissionError('CLEANUP_FAILED');
              launches.delete(handle);
            });
          }
          return closing;
        },
      });
      ownedScopes.add(ownedScope); launches.add(handle); signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      return handle;
    },
    close() {
      if (!shutdown) {
        stopping = true;
        shutdown = Promise.resolve().then(async () => {
          const outcomes = await Promise.allSettled([...launches].map(l=>l.close()));
          if (outcomes.some(o=>o.status==='rejected')) throw new HostAdmissionError('CLEANUP_FAILED');
        });
      }
      return shutdown;
    },
  });
}
