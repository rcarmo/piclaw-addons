# Native Remote Peer boundary

Exports from `native.ts`:

- `createRemotePeerTool({chatJid, cwd, assertCurrent, nativeHostPorts})`:
  invocation-local authority, shared action schema/dispatcher, all 21 actions.
- `await createRemotePeerNativeHostPorts(...)`: one application-owned service,
  not one service per invocation. No global runtime replacement.
- `createRemotePeerNativeRoutes(ports)`: config, dashboard, chat transport,
  start/close, and resource discovery for the parent's existing registrations.
- `remotePeerResources`, accepted-operation and application-port types.

The parent supplies the existing native messaging/session/media interfaces via
`createRuntime(assertCurrent)`. Its implementations MUST check that callback
immediately before actual exact-target resolution and queue/steer admission,
including after internal awaits. Passing a signal alone is not sufficient.
`localContext(operation)` must use the actual source's operator/session authority.
It is not an ExtensionContext or an emulated AgentSession.

`application.acceptOperation(source, body)` is REQUIRED. Every background ingress,
settings operation and chat-transport operation must accept a new host operation,
bind real source/session/incarnation, execute body, then settle/expire it. Never
capture the last tool invocation. Transport ingress is accepted around the whole
incoming connection, including response writes; packet authorization is rechecked
by the service. Preliminary synchronous transport authorization is read-only.

Parent wiring still required (not implemented by this add-on):

1. Provision a genuine core background accepted-operation admission port; the
   existing operation-authority checker alone does not create operations.
2. Bind native messaging/admission and exact-session services with inner fences.
3. Register the returned config/dashboard routes on the authenticated direct
   add-on API; dashboard requires its request's accepted operation. Register
   resources, chat transport and shutdown/start hooks once at application scope.
4. Provide application-lifetime discovery ownership if enabling mDNS: discovery
   has its own ongoing socket lifecycle, not retained invocation authority.

`host-remote-peer-tool.ts` captures actual `captureToolSource` evidence and creates
operation authority on each invocation. Catalog/default-factory/version changes
are deliberately left to the parent. This is a boundary and wiring contract,
not a claim that the unwired production application is qualified end-to-end.

Tests use owned fake interfaces only; no real service construction, pairings,
network connections, credential reads or live runtime changes.


## Public-bootstrap binding (current)

```ts
import { bindNativeRemotePeer } from "./addons/remote-peer/native.js";
const remote = await bindNativeRemotePeer({
  bundle, // actual createApplicationBootstrapBundle result
  nativeRootServiceOwner, // assertCurrent() checks application/root ownership
  dataDir: remotePeerDataDir,
});
// Register remote.chatTransport with the parent's existing transport registry.
// Mount remote.config on the existing authenticated direct add-on config API.
// Register remote.resources; invoke remote.start() once at application startup.
// Drain/close remote before retiring root ownership: await remote.close().
// Tool invocations use createRemotePeerTool({ ...acceptedOperation,
//   nativeHostPorts: remote }); never retain the accepted operation in the service.
```

`createHostRemotePeerService` in core is an optional typed composition helper:
pass the same bundle, owner, dataDir, and imported `bindNativeRemotePeer`.
No bootstrap, catalog or default-factory mutation is required by these files.

Ingress now uses application lifetime plus verified transport identity, not
`acceptOperation`. The S01 queued source owns the eventual new operation.
Native local selectors use chat JID and exact bootstrap target revision; there
is no AgentSession fallback. Native delivery is text/queue only; attachments,
steer and ambiguous/missing exact targets fail closed. Legacy agent-only/inbox
routes without an exact revision do not silently select a conversation.

Qualification: `native.test.ts` (9 tests), and core
`qualification/pi-durable-130/host-remote-peer-service.test.ts` (1 public-bootstrap
fixture, 47 assertions). The latter calls the exact delivery boundary used by
the factory with synthetic verified ingress, without constructing a transport
or peer identity keys. It checks queue source metadata, new S01 source (not Goal
continuation), replay conflict, wrong revision, revocation and retired owner.
This is not an end-to-end authenticated transport-pair fixture.
