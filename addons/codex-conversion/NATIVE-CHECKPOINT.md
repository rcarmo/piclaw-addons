# Executable continuation checkpoint (partial, not cutover-ready)

## New completed slice

- Separate entry `src/native-patch.ts`: `createNativeApplyPatchFactory(files)`.
- Reuses the actual patch parser/matcher/executor, not legacy ToolDefinition.execute.
- `src/patch/paths.ts` now exposes invocation-local `createPatchPaths(ports)`.
- `src/patch/core.ts` now exposes `createPatchExecutor(ports)`; the legacy export
  retains its original move-only `patchFsOps` injection behavior.
- Every exists/read/mkdir/write/unlink (including move destination/source) is checked
  immediately before the synchronous port call. No global authority replacement.
- Invocation disposal permanently rejects subsequent execution. No async filesystem
  work may escape these synchronous ports; host supplies path policy and authority.
- No host adapter exists yet: authority must eventually come from captured host
  source/current operation, not caller-provided model arguments. Synthetic tests
  qualify the port boundary only, NOT real persisted host provenance.
- A revoked multi-effect patch can leave already-admitted partial changes, matching
  existing patch partial-failure semantics; this is not filesystem rollback.

## Exact remaining executable work

1. `exec_command` and `write_stdin`: factor actual process/PTY allocation, poll,
   stdin and cleanup ports from existing shell/session implementation. Introduce
   opaque operation/session-owned handles, replay rejection, exit retention,
   cancellation registration and separate owner cleanup/reap authority.
2. `image_generation` and `web_search`: factor actual provider dispatch and image
   output persistence from legacy implementations with inner admission/cancellation.
3. `view_image`: factor actual stat/read/decode/resize effects from the read-tool
   path, preserving original-detail and image-only output behavior.
4. Native provider lifecycle registration/replacement/disposal and output observer:
   preserve registrations and decode actual provider events; save images/publish
   activity only via operation-owned ports. Pure hooks remain unchanged.
5. New `host-codex-*.ts` adapter(s) capturing `captureToolSource` and currentOperation,
   then creating invocation authority. None added in this continuation.
6. Host qualification tests with real captured persisted source/harness provenance;
   synthetic process/provider/image tests covering revocation at each inner effect,
   wrong-session/replay, parity, cancellation and zero leftover handles/listeners.
7. Parent owns final wiring; no default factory/catalog/host-models/package changes.

## Exact test receipt

`bun test addons/codex-conversion/native-patch.test.ts addons/codex-conversion/native.test.ts`
**12 pass, 0 fail, 49 assertions** (5 executable patch tests + 7 pure-hook tests).
Patch tests cover real temporary owned filesystem parity, revocation between
mkdir/write, before read/delete, between move write/unlink, wrong session and
post-disposal replay. All temporary directories are removed in finally blocks.

`bun test addons/codex-conversion/index.test.ts`: **0 pass, 1 fail, 1 load error**,
existing linked pi-ai missing `getCurrentTools`, before legacy tests execute.
No dependency installation, network/model authentication, process CLI or restart.

---

# Native boundary checkpoint

## Implemented slice

Import `createNativeCodexHooks` from `src/native.ts` directly (not the legacy entry).
It exports detached model/profile, immutable header transformation, request rewriting,
context filtering, prompt building and stateless tool selection. Legacy tool modules
re-export the exact shared request rewrites from `src/native-request.ts`; legacy
registration remains intact. No AgentSession/ExtensionContext object is constructed.

This is NOT a native executable-tool factory or native output observer yet.
No provider registration is consumed, queued, or silently discarded by these hooks.

## Required parent wiring (not implemented)

The RootModelRuntime physical dispatch boundary must explicitly accept native provider
registration/replacement, including queued openai-codex registrations, and return an
owned disposal handle. `host-models.ts` currently qualifies model data/options and
uses host stream dispatch: pure request payload/header hooks must run inside that
physical provider dispatch, not be smuggled through its JSON option allowlist.
Provider lifecycle initialization, replacement and shutdown must be explicit ports;
loading this module must not imply they occurred.

A host adapter should capture `captureToolSource` and create
`createHostOperationAuthority` per invocation. Never store a mutable current handler.
Each actual file read/write, spawn/PTY allocation, stdin write, provider send and
image output write needs that authority at the inner effect boundary. An outer
before/after check is not sufficient. Async effect implementations must provide
atomic admission plus cancellation; SQLite transactions cannot wrap async I/O.

Process handles must be operation/session-owned capabilities, not numeric IDs usable
across sessions. Retain cancellation until exit, reject stale/replayed stdin access,
and dispose/kill/reap owned handles on operation revocation and shutdown. Cleanup
needs a separate owner grant so revocation cannot strand a process.

Native output observation must decode provider events as data, then use explicit
operation-owned save-image and publish-activity ports. Do NOT reuse the legacy
observer's global provider registration or unguarded image persistence.

## Remaining qualification

Native factories for apply_patch, exec_command, write_stdin, image_generation,
web_search and view_image; provider lifecycle and output observation; synthetic
inner-effect revocation/wrong-session/replay/cancellation/no-leftover tests. No
claims of native effect safety are made by this pure-only slice.

## Validation

`bun test addons/codex-conversion/native.test.ts`: isolated pure fixtures.
Legacy index.test.ts cannot load with the existing linked dependency installation:
pi-ai does not export getCurrentTools (before any tests execute). No dependencies
were installed or changed. Versions/catalog/package metadata intentionally untouched.
