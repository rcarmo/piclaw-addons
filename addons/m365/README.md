# piclaw-addon-m365

Experimental Microsoft 365 tools for Piclaw.

## Install

Requires Piclaw `>=2.13.3`.

Open **Settings → Add-Ons** and install **m365** from the catalog. The add-on loads after installation; the former `PICLAW_ENABLE_M365_EXPERIMENTAL` core gate is not used.

## Capabilities

The add-on exposes tools for:

- Teams chats, messages, sending, and file-card helpers
- Microsoft Graph profile, people, and mail operations
- OneDrive browse, upload, and sharing flows
- SharePoint browse, search, download, upload, sync, and move flows
- Calendar queries and calendar SVG rendering
- Microsoft To Do list/task/checklist management and read-only flagged email tasks

Twelve bundled skills document the main Graph, Outlook, Teams, OneDrive, SharePoint and To Do workflows.

## Account support

Graph-backed operations support consumer Microsoft accounts through an Outlook Live browser session and the consumer OAuth flow.

The following operations still require a work or school Microsoft 365 account:

- Teams chat tools (`m365_teams_*`)
- SharePoint and enterprise document flows that require Teams or SharePoint work context

Consumer accounts are detected through the Microsoft consumer tenant ID. When a consumer session is visible, Graph authentication prefers the Outlook Live PKCE flow before enterprise Teams-based token recovery.

## Browser and platform support

The add-on supports Windows, macOS, and Linux. Browser discovery always prefers:

1. Edge
2. Chrome
3. Chromium

Set `M365_EDGE_PATH` when automatic browser discovery is not sufficient.

Stale browser and CDP cleanup is platform-aware:

- Windows uses PowerShell process filtering and `taskkill`.
- macOS and Linux use `ps` enumeration and process-group signals.

Most validation has been performed on Windows.

## Authentication and safety

- Authentication, token, and cookie caches remain in RAM only.
- Hosts may provide Graph and Teams chat-service credentials through the optional versioned callback described below.
- A fresh sign-in shows an explicit consent interstitial unless `PICLAW_M365_YOLO=1`.
- Existing browser sessions may provide cached tokens and follow their configured MFA and access policies.
- The add-on supports one active account or browser session at a time.
- State-changing and send actions require `confirm`; supported flows provide `dryRun` previews.
- Mail send flows create drafts rather than sending directly.

### Host-provided credential callback

A managed host can register `globalThis.__piclaw_m365CredentialProviderV1` before the add-on first requests authentication:

```ts
globalThis.__piclaw_m365CredentialProviderV1 = async ({ resource, minRemainingSeconds }) => {
  // resource is "graph" or "teams_chatsvc".
  // Return null when the host has no suitable credential.
  return {
    token: await broker.getAccessToken(resource, minRemainingSeconds),
    expiresAt: 1_800_000_000, // Unix epoch seconds; optional when the JWT has exp.
    tenantId: "00000000-0000-0000-0000-000000000000", // optional
  };
};
```

The add-on checks this callback after its RAM cache and before browser/CDP acquisition. It waits at most five seconds for each call. Missing providers, `null`, failures, timeouts, stale credentials, tenant mismatches, and wrong audiences fall through to the existing browser flow. Provider errors and token values are never logged, stored in metadata, or written to configuration.

Accepted tokens must be JWTs with at least five minutes remaining and an audience suitable for Microsoft Graph or Teams chat service. For `teams_chatsvc`, include region claims in the token or set `M365_CHATSVC_REGION`. Tenant, client, and scope selection remain the host's responsibility.

## Configuration

| Variable | Purpose |
|---|---|
| `M365_EDGE_PATH` | Explicit Edge, Chrome, or Chromium executable |
| `M365_USE_TEMP_EDGE_PROFILE=true` | Use a temporary browser profile instead of the normal signed-in profile |
| `PICLAW_M365_YOLO=1` | Skip the explicit consent interstitial before authentication navigation |
| `M365_TENANT_ID` | Force a tenant ID instead of starting from `common` and auto-discovering it |
| `M365_CHATSVC_REGION` | Force the Teams chat-service region instead of auto-discovering it |

## `m365_todo`

`m365_todo` provides a read-only task view that combines Microsoft To Do task lists and flagged email tasks.

```ts
m365_todo({ action: "list" })
m365_todo({ sources: ["flaggedEmails"] })
m365_todo({ search: "contract", dueBefore: "2026-05-01" })
m365_todo({ includeCompleted: true, top: 100 })
```

The reader follows pagination within a total `maxPages` request budget (default 20, maximum 50), avoids `$select` on To Do endpoints, and retains full notes and Graph date/time-zone objects. `complete=false` marks partial coverage or result truncation. Partial list failures appear in `errors`; if every selected list fails, the tool throws instead of reporting zero tasks. Due filters use inclusive `YYYY-MM-DD` calendar dates and exclude undated tasks.

### Task, list and checklist writes

| Tool | Actions |
|---|---|
| `m365_todo_lists` | list, get, create, rename, delete |
| `m365_todo_task` | get, create, update, complete, reopen, delete |
| `m365_todo_step` | list, create, update, delete |

These tools reuse the existing Graph transport. Reads need appropriate task-read permission; writes need delegated `Tasks.ReadWrite`. They do not change sign-in configuration or request additional permissions.

Writes require `confirmed=true` for an explicit user-approved target and payload. Deletion also requires `confirmDelete=true`. These flags are agent-policy checks, not cryptographic proof of human approval. Unattended reviews should remain read-only unless their writes are explicitly authorised.

Before an edit, read the item and supply its `@odata.etag` as `expectedEtag`. The tool checks freshness, sends `If-Match` for task/list updates and deletions, and reads the item back. Checklist writes check parent task freshness but do not provide an atomic compare-and-swap guarantee. List deletion checks that a custom list is empty; another writer could still add a task between that check and deletion.

Creates require a stable `requestKey`. Local account-scoped receipts prevent duplicate creates on retry; ambiguous outcomes stay blocked for reconciliation. Receipts contain hashes, resource IDs/paths and timestamps, never tokens or task notes. They live under `<workspace>/.piclaw/data/m365-todo-requests/`, using `PICLAW_WORKSPACE` or the current working directory. Do not remove a pending receipt and retry blindly.

Only owned, unshared lists allow writes. Built-in lists cannot be renamed/deleted. Flagged email tasks are read-only through these tools. Omitted update fields remain unchanged; `notes` replaces the notes body and `null` clears dates. Supply dates as `{ dateTime: "2026-10-03T00:00:00", timeZone: "UTC" }`; reminders require an explicit opt-in and date.

Recurrence, My Day, moves, sharing and linked-resource writes are outside this version. Existing source links are returned when Graph supplies them.

## Validation

From the `piclaw-addons` repository root:

```bash
bun x tsc --noEmit -p addons/m365/tsconfig.json
bun test addons/m365/tests/*.test.ts
bun run addons/m365/tests/validate.ts
bun test standalone-import.test.ts
```

These checks do not require live Microsoft authentication. Live operations require a suitable signed-in browser session.
