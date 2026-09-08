import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PeerService } from "./service.js";
import { requireOwnedFixtureRoot, writeEvidence } from "./fixture-ownership.js";
if (
  process.env.PICLAW_E2E_DISPOSABLE !== "1" ||
  !process.env.PICLAW_IROH_REMOTE_ID ||
  !process.env.PICLAW_IROH_RESULT_DIR
)
  throw new Error("Explicit disposable remote ID/result directory required.");
const remote = process.env.PICLAW_IROH_REMOTE_ID,
  resultDir = requireOwnedFixtureRoot(
    process.env.PICLAW_IROH_RESULT_DIR,
    "iroh-two-host-",
  );
const root = mkdtempSync(join(tmpdir(), "iroh-local-"));
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
try {
  await service.configure({
    enabled: true,
    addressLookup: false,
    mdnsEnabled: true,
    mdnsInterface: "192.168.1.152",
    instanceName: "Disposable Smith peer",
    relayMode: "n0",
  });
  const until = Date.now() + 60000;
  let candidate;
  while (Date.now() < until) {
    candidate = service.discovery?.candidates().find((c) => c.id === remote);
    if (candidate) break;
    await Bun.sleep(250);
  }
  if (!candidate) throw new Error("Remote mDNS candidate not discovered.");
  await service.pair({ clientId: remote, alias: "vm-peer" });
  writeEvidence(
    resultDir,
    "pair-requested.json",
    JSON.stringify({
      local: service.identity(),
      candidate,
      localCandidatePort: service.transport.port(),
    }),
  );
  const pairedUntil = Date.now() + 60000;
  while (Date.now() < pairedUntil) {
    if (service.state.peer(remote)?.status === "paired") break;
    await Bun.sleep(250);
  }
  if (service.state.peer(remote)?.status !== "paired")
    throw new Error("Remote did not approve pairing.");
  const request: any = {
    source_chat_jid: "web:disposable",
    address: {
      kind: "bang",
      raw: "vm-peer!inbox",
      peer: "vm-peer",
      target: "inbox",
    },
    content: "TWO_HOST_MDNS_IROH_OK",
    mode: "queue",
    idempotency_key: "two-host-proof",
  };
  await service.validate(request);
  await service.send(request);
  writeEvidence(
    resultDir,
    "final.json",
    JSON.stringify({
      mdnsCandidate: candidate,
      transport: service.transport.status(),
      peer: service.state.peer(remote),
      received: received.length,
    }),
  );
  console.log(
    JSON.stringify({
      event: "complete",
      transport: service.transport.status(),
      candidate,
    }),
  );
} finally {
  await service.close();
  rmSync(root, { recursive: true, force: true });
}
