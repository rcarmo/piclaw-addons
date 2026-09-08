/** Explicit opt-in probe using fresh identities and n0 infrastructure, never live Piclaw state. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PeerService } from "./service.js";
if (
  process.env.PICLAW_E2E_DISPOSABLE !== "1" ||
  process.env.PICLAW_IROH_NETWORK_TEST !== "1"
)
  throw new Error(
    "Requires PICLAW_E2E_DISPOSABLE=1 and PICLAW_IROH_NETWORK_TEST=1; publishes ephemeral test endpoint addresses to n0.",
  );
const root = mkdtempSync(join(tmpdir(), "iroh-network-"));
const runtime: any = {
  messaging: {
    version: 1,
    listAdvertisableAgents: async () => [],
    deliverPeerMessage: async () => ({
      status: "ok",
      row_id: 1,
      created: true,
    }),
  },
};
const a = new PeerService({ dataDir: join(root, "a"), runtime }),
  b = new PeerService({ dataDir: join(root, "b"), runtime });
try {
  await a.configure({
    enabled: true,
    addressLookup: true,
    instanceName: "Disposable Iroh lookup test A",
  });
  await b.configure({
    enabled: true,
    addressLookup: true,
    instanceName: "Disposable Iroh lookup test B",
  });
  const until = Date.now() + 45000;
  while (
    (!a.transport.status().relay || !b.transport.status().relay) &&
    Date.now() < until
  )
    await Bun.sleep(250);
  if (!a.transport.status().relay || !b.transport.status().relay)
    throw new Error("Test endpoints did not connect to relays.");
  await Bun.sleep(3000);
  await a.pair({ clientId: b.identity().clientId, alias: "test-b" });
  await b.accept(a.identity().endpointId, a.identity().clientId);
  await a.ping("test-b");
  console.log(
    JSON.stringify({
      bun: Bun.version,
      bareClientIdPairing: true,
      mdnsEnabled: false,
      aRelay: a.transport.status().relay,
      bRelay: b.transport.status().relay,
      selectedPath: a.transport.status().lastPath,
      scope:
        "two ephemeral endpoints on one host using n0 address lookup; not internet-separated or forced relay-only",
    }),
  );
} finally {
  await a.close();
  await b.close();
  rmSync(root, { recursive: true, force: true });
}
