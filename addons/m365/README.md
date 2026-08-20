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
- Microsoft To Do tasks and flagged emails through `m365_todo`

Eleven bundled skills document the main Graph, Outlook, Teams, OneDrive, and SharePoint workflows.

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
- A fresh sign-in shows an explicit consent interstitial unless `PICLAW_M365_YOLO=1`.
- Existing browser sessions may provide cached tokens and follow their configured MFA and access policies.
- The add-on supports one active account or browser session at a time.
- State-changing and send actions require `confirm`; supported flows provide `dryRun` previews.
- Mail send flows create drafts rather than sending directly.

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

Partial list failures are tolerated and returned in `details.errors`.

## Validation

From the `piclaw-addons` repository root:

```bash
bun x tsc --noEmit -p addons/m365/tsconfig.json
bun test addons/m365/tests/*.test.ts
bun run addons/m365/tests/validate.ts
bun test standalone-import.test.ts
```

These checks do not require live Microsoft authentication. Live operations require a suitable signed-in browser session.
