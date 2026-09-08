import { PeerService } from "./service.js";
import { requireOwnedFixtureRoot } from "./fixture-ownership.js";
if (
  process.env.PICLAW_E2E_DISPOSABLE !== "1" ||
  !process.env.PICLAW_IROH_TWO_HOST_ROLE
)
  throw new Error("Explicit disposable two-host role required.");
const root = requireOwnedFixtureRoot(
  process.env.PICLAW_IROH_TWO_HOST_ROOT,
  "iroh-remote-peer-validation",
);
const iface = process.env.PICLAW_IROH_MDNS_INTERFACE || "";
const received: any[] = [];
const service = new PeerService({
  dataDir: root,
  runtime: {
    messaging: {
      version: 1,
      listAdvertisableAgents: async () => [],
      deliverPeerMessage: async (m: any) => {
        received.push(m);
        return {
          status: "ok",
          chat_jid: "test",
          row_id: received.length,
          thread_id: null,
          created: true,
        };
      },
    },
  } as any,
});
let closed = false;
async function close() {
  if (closed) return;
  closed = true;
  await service.close();
}
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => void close().finally(() => process.exit(0)));
try {
  const customRelay = process.env.PICLAW_IROH_CUSTOM_RELAY;
  await service.configure({
    enabled: true,
    addressLookup: process.env.PICLAW_IROH_ADDRESS_LOOKUP === "1",
    mdnsEnabled: process.env.PICLAW_IROH_MDNS === "1",
    mdnsInterface: process.env.PICLAW_IROH_MDNS === "1" ? iface : "",
    instanceName: process.env.PICLAW_IROH_TEST_NAME || "Disposable peer",
    relayMode: customRelay ? "custom" : "n0",
    ...(customRelay ? { relays: [{ url: customRelay }] } : {}),
  });
  const until = Date.now() + 45000;
  while (!service.transport.status().relay && Date.now() < until)
    await Bun.sleep(250);
  console.log(
    JSON.stringify({
      event: "ready",
      identity: service.identity(),
      ticket: service.transport.ticket(),
      transport: service.transport.status(),
    }),
  );
  const control = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      if (req.method !== "POST")
        return Response.json({ error: "POST required" }, { status: 405 });
      let command: any;
      try {
        command = await req.json();
      } catch {
        return Response.json({ error: "invalid command" }, { status: 400 });
      }
      try {
        if (command.action === "status")
          return Response.json({
            identity: service.identity(),
            ticket: service.transport.ticket(),
            candidates: service.discovery?.candidates() ?? [],
            received: received.length,
            transport: service.transport.status(),
            peers: service.state.peers(),
          });
        if (command.action === "pair") {
          const result = await service.pair({
            clientId: command.clientId,
            alias: command.alias || "remote",
            ...(command.ticket ? { ticket: String(command.ticket) } : {}),
          });
          return Response.json(result);
        }
        if (command.action === "send") {
          const peer = service.state.peers().find((p) => p.status === "paired");
          if (!peer) throw new Error("No paired peer");
          const result = await service.send({
            source_chat_jid: "test",
            address: {
              kind: "bang",
              raw: peer.alias + "!inbox",
              peer: peer.alias,
              target: "inbox",
            },
            content: String(command.content || "RELAY_ONLY_OK"),
            mode: "queue",
            idempotency_key: String(command.idempotency || "relay-proof"),
          });
          return Response.json(result);
        }
        if (command.action === "accept") {
          await service.accept(command.peer, command.confirmation);
          return Response.json({ accepted: true });
        }
        if (command.action === "policy") {
          service.setPolicy(command.peer, {
            scope: "inbox-only",
            modes: ["queue"],
            agents: [],
            files: false,
            confirmation: "",
          });
          return Response.json({ policy: true });
        }
        if (command.action === "close") {
          setTimeout(
            () =>
              void close().finally(() => {
                control.stop(true);
                process.exit(0);
              }),
            10,
          );
          return Response.json({ closing: true });
        }
        return Response.json({ error: "unknown action" }, { status: 400 });
      } catch (error) {
        return Response.json(
          { error: error instanceof Error ? error.message : String(error) },
          { status: 400 },
        );
      }
    },
  });
  console.log(JSON.stringify({ event: "control", port: control.port }));
  await new Promise(() => {});
} finally {
  await close();
}
