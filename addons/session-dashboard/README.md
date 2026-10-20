# Session Dashboard

A roll-down dashboard for recent Piclaw sessions. Requires Piclaw `>=2.0.0`.

## Install

Open **Settings → Add-Ons** and install **session-dashboard** from the catalog, then reload Piclaw.

## Use

Open the dashboard from the small tab at the top centre of the web UI, or press backtick when focus is outside an editor or form. Press Escape to close it.

The dashboard shows:

- recent and active session handles
- current activity state
- the latest saved assistant output
- live draft or thinking previews for active sessions
- the current tool invocation when an active session has no draft or thinking text
- context-window usage
- a footer with visible capacity, active count, current chat, and update age

Click a tile to switch through Piclaw's in-app navigation. Ctrl/Cmd-click opens the session in a new tab.

## Live preview priority

For active sessions, the dashboard displays the first available source in this order:

1. assistant draft
2. thinking text
3. current `tool_call` or `tool_status` from `/agent/status`
4. latest saved session summary

Generic `Working...` text is omitted. A specific ongoing state such as `Streaming output...` appears after the tool title. Tool activity uses the interface's monospace font. When a tool finishes, fails, is cancelled, or is aborted, the tile restores the latest non-empty draft or thought from the same turn before falling back to the saved session summary. Transient status-request failures preserve the last live preview. If the runtime omits a precomputed title, the dashboard derives one from common tool arguments such as `command`, `path`, `file`, `url`, or `query`.

## Responsive layout

The panel always uses two rows when enough sessions exist:

- below 760 px: 2 columns, 4 sessions
- 760–1079 px: 3 columns, 6 sessions
- 1080 px and above: 4 columns, 8 sessions

## Refresh behaviour

- full session/context refresh: every 15 seconds while open
- draft/thinking/tool status refresh: every 3 seconds for visible active sessions
- footer age: local DOM update every second
- live event bursts: coalesced before a full refresh

The dashboard does not query model or provider catalogues and makes no external requests.

## Native Root binding

`native-resources.ts` exports `nativeResources` and the actual
`createNativeSessionDashboard(options): () => void` service factory. The source
qualifier resolves installed files and this export; it does not register anything.
The parent binds its authenticated direct settings service once:

```ts
const reader = createRootDashboardReader({
  root: bunSQLiteRoot, scope, isCurrent,
  sessionTargets: () => corebundle.sessionTargets,
  canReadTarget, // synchronous current observer permission for each native target
});
const { factory } = await qualifyNativeResourceSource("session-dashboard", sourceUrl);
const dispose = factory({ scope, reader, isCurrent, authorize, register });
```

`scope` contains `ownerId` and `authScope`. `isCurrent` must check the current
application owner, not a captured startup boolean. `authorize(req, scope)` checks
current authenticated observer authority. `register(addon, action, { get })`
is the parent's direct settings-service registration and returns its unregister
function. Keep the registrar stable for the service lifecycle; duplicate binding
is rejected. Dispose before replacing the owner/service; stale handlers reject.
No slash-command bridge, database path, fallback reader, model drive, network,
or static-resource registration is involved.

The reader performs SELECTs against the passed Root in one read transaction:
canonical targets come from the current native list/resolve API; timeline counts,
latest readable assistant output (including blocks), timestamps and branch metadata
come from application tables; task IDs/status come from native tasks; conversation
usage is reconstructed from the actual `pi.usage` document revisions. Retired or
absent usage is `null`, never a fabricated zero ledger. Zero message count means
only that the Root timeline has no messages for that chat.

### Remaining UI limits

The existing tiles preserve their saved-summary fields. Native conversation/session
IDs, task statuses and usage are additionally returned by the settings endpoint;
the current tiles do not render those extra fields. Live activity, drafts, thinking,
tool previews and context-window occupancy still depend on the existing native
status/context endpoints and events. Cumulative Root usage is not active context,
and imported history is not an original leaf/session claim. No original leaf or
active-context estimate is synthesized by this projection.
