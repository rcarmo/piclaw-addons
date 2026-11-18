# Tool call summaries

Every active first-party tool declares a synchronous `callSummary(args)` callback on its tool definition. The add-on owns the wording, action interpretation and selection of safe fields. Piclaw Core carries that callback through the native bridge and renders its text in live status, historical activity and nested calls.

## Declare the callback

Put pure formatters in the package’s `summary.ts`. Import only the vendored text helpers or other pure package-local metadata.

```ts
// summary.ts
import {
  summaryArgs, summaryJoin, summaryValue, type ToolCallSummary,
} from './compat/tool-call-summary.js';

export const callSummaries: Readonly<Record<string, ToolCallSummary>> = Object.freeze({
  inspect_widget(input) {
    const args = summaryArgs(input);
    return summaryJoin('inspect widget', summaryValue(args.widget_id));
  },
});
```

Attach the callback alongside the schema and execution function:

```ts
import { toolCallSummary } from './compat/tool-call-summary.js';
import { callSummaries } from './summary.js';

pi.registerTool({
  ...toolCallSummary(callSummaries.inspect_widget),
  name: 'inspect_widget',
  label: 'Inspect widget',
  description: 'Read one widget.',
  parameters: WidgetSchema,
  async execute(_id, args) {
    // Existing execution and authority checks stay here.
  },
});
```

`toolCallSummary()` adds an ordinary `callSummary` data property. The spread helper allows TypeScript callers to attach Piclaw metadata without modifying the upstream SDK interface. JavaScript tools can provide the property directly.

Use the same formatter module in legacy and native factories. Piclaw snapshots the callback with the actual registered tool and checks its identity within each binding. Native and legacy imports may be separate module instances; matching function source text is not an identity proof.

## Callback contract

```ts
type ToolCallSummary = (args: unknown) => string | null | undefined;
```

- Return the detail text only. Core adds the stable tool-name prefix.
- Accept missing, partial and malformed arguments. Core may be displaying a failed call or an older stored call. `summaryArgs()` safely reads object arguments and JSON-encoded objects; a scalar `input` field remains an ordinary tool argument.
- Be pure, synchronous and deterministic. Do not execute a tool, read configuration/keychain/files, contact services, start asynchronous work, use a clock/random source, or capture an execution/session context.
- Do not mutate arguments. Core supplies a deeply readonly copy and may reuse a caption while the arguments and selected provider stay unchanged.
- Select fields explicitly. Do not serialise the argument object, request bodies/headers, full configuration, message/Markdown/notes content, arbitrary scripts, typed text, credentials, pairing tickets or request keys.
- Validate an operation against its known vocabulary before turning it into prose. Unknown operations receive a neutral label. The helpers remove credentials, query strings and fragments from displayed URLs; API-path helpers also remove query strings and fragments.
- Return `null` or `undefined` to decline. Exceptions and invalid output produce a safe tool-name caption. Core does not substitute an argument preview after a declared provider fails.

Core treats the result as plain text, removes control/ANSI sequences, folds whitespace and bounds the detail to 120 characters. It does not interpret add-on-specific actions or infer their meaning from field names.

A tool’s deliberate payload preview belongs in its own policy. For example, `exec_command` intentionally previews the shell command; `write_stdin` shows only the input/output intent and session ID, never the typed bytes.

## Resolution and history

Core resolves providers from the conversation’s selected tools, including its callable and deferred tools. There is no process-global name-to-formatter registry. A same-named tool in an unselected extension cannot supply a caption.

Historical reads project bounded text facts from the currently available registered providers. No callback or caption is inserted into the model transcript, tool result, or a new storage ledger. Stored arguments/results remain unchanged. If a provider is unavailable, the existing generic compatibility fallback applies; historical captions can change after an add-on update.

The metadata grants no execution or adoption authority. Qualified native loading requires the callback, while all existing source, ownership, operation and cancellation fences remain in force.

## Repository checks

The active catalogue has 46 entries. Its 27 tool-exposing add-ons provide 77 distinct names; the retired Plan and Delegate packages remain immutable and their current Core-owned tools use the same metadata contract.

```sh
bun run sync:tool-summary-helpers --write
bun run typecheck:tool-summaries
bun test tool-call-summaries.test.ts
```

The tests import pure formatter modules, not device/browser/account entrypoints. They check every active tool name, all 97 infrastructure workflows, documented operation variants, privacy cases and the metadata on every legacy/native declaration, including factory-registered To Do tools. Core separately tests the native bridge, conversation scoping, live/historical/nested projection and exclusion from model declarations.

Bump the add-on version for functional changes, keep the standalone package’s `files` list complete, and run `sync:catalog`. Do not modify retired release bytes or overwrite an already-published archive.
