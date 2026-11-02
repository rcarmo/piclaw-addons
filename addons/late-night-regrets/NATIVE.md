# Native Regrets wiring

Regrets0.3 requires the native durable host. `index.ts` registers SDK declarations and resources only. Its unbound tool and command reject execution. Ambient KV storage, direct history discovery, SDK model-registry fallback, `sendUserMessage` admission and legacy prompt injection have been removed.

Import `native.ts` for `createLateNightRegrets`, `regretsToolDeclaration`, `regretsResources` and `readExchanges`. The factory exposes tool, command, prompt and settings methods through invocation-local ports. It does not register global handlers or construct an SDK extension context.

## Host ownership

Supply the active Root database, an owned history handle, cwd, current chat, current source/owner checks, access mode and explicit all-chat permission. File reads must remain workspace-scoped. Configuration writes must share a transaction with their authority checks. No independent configuration store is created.

Use the existing host adapters:

- `createHostRegretsBindings` supplies fenced RootKV, history, file, input and model ports.
- `createHostRegretsTool` captures actual tool source and creates operation authority. Its `bind(captured, authority, call)` callback composes the bindings for that invocation. Pass the exact SDK tool scope/checkpoint to the existing accounted model transport; discovery-time bindings are insufficient.
- `createHostRegretsAccountedDecision` owns reserve/dispatch/settle/abandon through the existing host ledger. If the parent already owns accounting, pass that port directly instead. Never double-wrap it.
- `createHostRegretsPromptExtension` binds fresh configuration for each native section render.
- `createHostRegretsSettings` rebinds the current authenticated request for each settings action.

The removed `createBoundHostRegretsTool` and command-forwarding helper are unnecessary layers. Use the same direct binding and native command path as the production factory.

## Commands and prompts

For `/regrets`, derive genuine chat and authority from the host's accepted command, then call `createLateNightRegrets(bindings).command()`. Its `admitConversationInput` port must return the existing normal source admission result. Do not call `sendUserMessage`, create another operation or discard the admission result.

Public pi-durable1.4 renders prompt sections with `render(PromptInput, Context)`. Bind the actual conversation and current owner/configuration on every render. Disabling configuration removes the section on the next request, including recovery. No legacy `before_agent_start` lifecycle binding remains.

Register authenticated `/config` and `/models` actions using the native settings methods. Model catalogues come from the host's native `ModelRuntime` snapshot. History and model execution are never needed to load settings. An unavailable saved decision model must not prevent disabling or changing unrelated settings; new selections still require an available model.

## Accounting and recovery

`actualRoot` must be the application's active `getDb()` connection. A separate SQLite ledger is not a substitute: admission and settlement must refer to the same owner. History may use another owned read handle. Erased rows and cross-chat context remain excluded.

The accounted decision port must retain failed/uncertain cost evidence, observe cancellation and source revocation, and settle original terminal facts. Exact recovered terminals return through the existing recovery path without another preview, authentication or provider request. Unknown pricing/output metadata is not permission for an unaccounted fallback. Expense-policy retirement belongs to its separate host workstream; token, price and provider-cost observations remain.

## Qualification

Focused tests cover native tool/settings/prompt/command ports, owned SQLite history, source revocation, atomic settings rollback, real default-factory execution, exact settlement, cancellation and reopen without replay. Offline provided-fetch tests exercise actual SDK payloads. Chromium and WebKit settings tests use the native settings methods.

The installed-source gate must pin the exact0.3 source before evaluation. Older execution paths are rejected rather than kept as a compatibility mode. Test source copies and dependency graphs must be isolated; never mutate frozen fixture provenance, the installed profile or a live database to obtain qualification.
