# Native Regrets wiring

`native.ts` exports `createLateNightRegrets`, `regretsResources`, `readExchanges`.
The instance exposes `tool`, `command`, `prompt`, `resources`, `getConfig`,
`setConfig`, `models`, and direct `settings.config.{get,set}` /
`settings.models.get` handlers. No global registration or SDK context is used.

Host sibling exports:
- `host-regrets-bindings.ts`: `createHostRegretsBindings(options)` supplies the
  canonical root extension_kv config reader/writer, owned SQLite history reader,
  explicit all-chat opt-in and single-user guard, fenced file/admission/model ports.
- `host-regrets-tool.ts`: `createBoundHostRegretsTool(addon, options)` captures
  tool source and fences against owner, operation, source and watch changes.
- `host-regrets-model.ts`: `createHostRegretsAccountedDecision(options)` uses
  existing reserveHostRequest, dispatch, settle and abandon. No second ledger.
  Missing stored account/cost evidence fails closed. Alternatively provide a
  parent controller-owned `accountedDecision` callback; never double wrap it.

Parent must supply root/historyDatabase handles, cwd, current chat authority,
accessMode, allowAllChats, workspace-scoped readFile, and accepted normal input
admission callback. For the tool wrapper, chat/authority come from captured
operation; accountedDecision is created per captured operation. For command,
settings and prompt, create fresh request-scoped bindings and route command to
`native.command()`, system prompt to `native.prompt()`, resources to native
resources, config/models routes to native.settings. Do not use sendUserMessage,
reuse an expired tool snapshot, or substitute a private/live history database.

## Concrete parent instantiation contract

Import `* as addon` from the fixed installed `late-night-regrets/native.ts`
source, not its legacy default entry point. No side-effect registration occurs.
The parent factory (owned elsewhere) must instantiate all of these:

1. `createBoundHostRegretsTool(addon, { root: actualRoot, runtime,
   assertOwner, definition, bindings, accountedDecision })`. `definition` is
   discovery metadata only; do not execute a discovery instance. `bindings`
   provides actualRoot-backed history, cwd, mode, opt-in, readFile and admission.
   The wrapper captures `runtime().captureToolSource(conversationId, taskId,
   toolCallId)` and derives chat + operation/source/watch authority itself.
2. `accountedDecision(operation, authority)` returns
   `createHostRegretsAccountedDecision({ database: actualRoot,
   operationId: operation.operation.operationId,
   chatJid: operation.operation.chatJid, authPath,
   signal: currentOperationSignal, assertCurrent: authority.assertCurrent,
   getAvailable: boundModels.getAvailable,
   request: accountedTransportRequest })`. `request` is the parent's **raw**
   synthetic/provider transport, not an already-reserving callback. Alternatively
   return the parent's already-accounted controller port directly. Bind methods
   to their model controller where required. Missing identity/pricing rejects;
   configured supported models execute, rather than an always-reject placeholder.
3. Install `createHostRegretsPromptExtension(addon,
   { bindBeforeModelRequest })` in the native registry and select it for the
   conversation. Public pi-durable **1.3.0** exports `Extension.sections` with
   `render(PromptInput, Context)`, not an `on("beforeModelRequest")` callback or
   `Extension.beforeModelRequest` property. The named binding callback here is a
   host port, not a claimed SDK event. Every render must resolve the actual
   `input.conversationId` through the host's `currentOperation` path, validate
   owner/chat, and create fresh RootKV-backed bindings. No permanent instructions:
   disabling config returns no section on the next request, including recovery.
4. Register `/regrets` using `createHostRegretsCommand(addon, bindAccepted)`.
   `bindAccepted` receives the host's **accepted command**, derives genuine chat
   and current request authority, and creates fresh bindings whose
   `admitConversationInput(text)` returns the existing normal bundle admission
   (`bundle.dispatch(accepted.chat, text, normalOptions)`, using the parent's
   actual signature). Do not manufacture a message via `pi.sendUserMessage`.
   Command acceptance/authentication/deduplication remain host responsibilities.
5. Bind authenticated settings routes with
   `createHostRegretsSettings(addon, bindCurrentSettingsRequest)`:
   `getConfig`, `setConfig`, `getModels`. Each call rebinds current request
   authority. Expose `addon.regretsResources` to the normal resource loader.

`actualRoot` must be the active host application connection returned by `getDb()`:
request admission currently captures that connection globally, whereas settlement
uses the explicit database. The adapter rejects split-root wiring before a
reservation. A separately-created SQLite ledger is **not** a valid substitution.
History may be a separately owned history handle; no private/live database paths.
The reader supports host schemas both with and without `content_erased`; when
present, erased content is excluded from targets, context and references.

## Qualification and remaining boundary

Host scoped qualification: 21 passing tests. Positive tests invoke the actual
native addon through `createBoundHostRegretsTool` and `captureToolSource`, against
the initialized application-owned in-memory SQLite Root. Synthetic OAuth account
records and priced synthetic responses exercise the real `reserveHostRequest`
contract: reserved → dispatched → settled; provider exceptions retain unresolved
holds; cancellation/revocation after a response still settle original evidence;
undispatched abandonment releases once. Usage uses the same operation budget
parent and token_usage ledger; no extra source/operation is admitted. No network,
real provider, private DB, or extra execution ledger is used.

Native section/config/command tests prove fresh request binding and disabled
prompt removal; accepted-command tests verify the admission return is preserved.
They do **not** claim a running default-factory HTTP/router integration. The
parent still owns registry selection, currentOperation lookup, accepted-command
routing, direct settings route authorization, resource loading and normal bundle
admission. These are explicit integration boundaries, not unimplemented model
features. No factory/catalog/package/install/restart/commit changes were made.
