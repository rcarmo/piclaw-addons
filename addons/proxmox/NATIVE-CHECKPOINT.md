# Proxmox native checkpoint

## Exports / integration handoff
- `index.ts`: `createProxmoxTool(options)`, `getProxmoxPrompt()`, type `ProxmoxInvocationOptions`; all existing exports/default extension retained.
- Factory options require `chatJid: string`, `assertCurrent(): void`; optional invocation-local `transport` and `credentials` ports (see README). No ExtensionContext or AgentSession required.
- Core `runtime/durable-engine/src/host-proxmox-tool.ts`: `createHostProxmoxTool`, `ProxmoxNativeExports`. Captures source through `captureToolSource`, builds current operation authority, rejects foreign chat, checks host owner and call authority at each addon effect through the callback.
- Parent owns catalog/default-factory/package wiring. None edited here.

## Fences
Async-local scope covers credential resolution, production HTTP dispatch, profile KV, retry dispatch, workflow HTTP steps and output directory/file writes. Each batch attempt gets a separate child lease: timeout closes it even while a retry/parent stays live, preventing late credential continuations from dispatching. Completion closes the whole invocation. Native factories bypass legacy global test transport/handler overrides without swapping them. Already-dispatched HTTP cannot be undone.

## Verification
- `bun test addons/proxmox addons/portainer`: 40 pass, 0 fail (six files).
- Core `bun test qualification/pi-durable-130/host-proxmox-tool.test.ts qualification/pi-durable-130/host-portainer-tool.test.ts`: 16 pass, 0 fail.
- Focused strict TypeScript checks passed for both addon index/native tests and both core host adapters/qualification tests, using existing installed tsc with `--ignoreConfig --noEmit --strict --skipLibCheck --target esnext --moduleResolution bundler` (addon: `--module esnext --esModuleInterop --types bun-types`; core: `--module preserve --allowImportingTsExtensions --types bun`).
- Coverage: schema/all action parity, full workflow-help catalog parity, lifecycle prompt/resources, real local HTTP using production fetch/curl, credential-await revocation, HTTP-await revocation, independent retry timeout leases, retry-backoff revocation, multi-step workflow stop, foreign chat, concurrent scopes, aborted profile mutation; host owner/version/source/watch/capture-await invalidation.

## Remaining integration limits
Parent must wire exports into its integration. No live services, package manifests, catalogs/default factories, dependency installs or commits changed. No live Proxmox/Portainer qualification attempted; network tests use local/synthetic endpoints. Existing commands, direct settings and resources remain intact. No known owned-code test/typecheck failures.
