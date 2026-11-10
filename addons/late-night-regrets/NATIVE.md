# Native Regrets wiring

Regrets requires the native durable host. `index.ts` registers declarations and resources only; unbound execution rejects. The host supplies invocation-local ports through `createLateNightRegrets` from `native.ts`.

## Host bindings

`createHostRegretsBindings` receives the application's active Root database for configuration, an owned history handle, workspace-scoped file access, current chat/source/owner checks, access mode and explicit permission for all-chat history. Configuration mutation shares the host's checked SQL transaction. No independent configuration store is created.

`createHostRegretsTool` captures the actual SDK tool source and binds those ports for that invocation. Discovery-time bindings cannot authorise execution. Use `createHostRegretsPromptExtension` for per-request section rendering and `createHostRegretsSettings` for each authenticated settings action.

The `accountedDecision` port name is retained for API compatibility. It supplies current provider/model approval, cancellation/source checks and passive usage reporting. It has no financial admission or settlement authority. The old ledger-based decision helper is removed. Missing model capability prevents a nested model request; it does not prevent disabling or changing unrelated settings.

## Inputs, prompts and settings

For `/regrets`, derive chat and authority from the host's accepted command. `admitConversationInput` returns the existing normal-input admission result. Do not construct another SDK session/context, call `sendUserMessage`, invent another operation or discard the admission result.

Bind prompt sections through public `render(PromptInput, Context)` with current conversation/configuration checks. Disabling Regrets removes the section on the next request, including recovery. No legacy prompt-injection fallback is installed.

Authenticated `/config` and `/models` actions use current native settings bindings. Model catalogues come from the host's ModelRuntime snapshot. Loading settings does not require history access or model execution; new model selections still require current availability and approval.

## Observation and recovery

Model/token/price/provider-cost observations are passive. Old caps, reservations, uncertain monetary records and unavailable valuation cannot admit or deny Regrets work. There is no reserve/dispatch/charge lifecycle, financial readiness test or unaccounted fallback.

Keep genuine access, history scope, source/owner, SQL, cancellation, deadline and resource-cleanup checks. Reopening historical SDK results must preserve their identities without another provider/tool call. An uncertain old action is not resubmitted to repair an observation. Historical monetary records remain opaque and unchanged.

## Qualification boundary

Native binding, tool, prompt, settings and real default-factory tests cover current authority, atomic configuration writes, cancellation, errors, close/reopen and no replay. Settings browser tests use the same native methods. Source copies and dependency graphs must be isolated; never mutate frozen fixture provenance, installed profiles or live databases for qualification. Full delivered-source qualification belongs to the coordinating Core change.
