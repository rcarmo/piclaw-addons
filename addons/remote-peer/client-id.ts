import { createHash } from "node:crypto";
export function endpointId(value: string): string {
  const text = String(value || "").trim();
  if (/^[a-f0-9]{64}$/i.test(text)) return text.toLowerCase();
  const match = /^PCL1-([A-F0-9-]+)$/i.exec(text);
  if (!match)
    throw new Error(
      "Paste a Remote Peer client ID (PCL1-…) or a 64-character Iroh endpoint ID.",
    );
  const compact = match[1].replaceAll("-", "").toLowerCase();
  const id = compact.slice(0, 64);
  if (compact.length !== 72 || compact.slice(64) !== checksum(id))
    throw new Error("Client ID checksum mismatch.");
  return id;
}
function checksum(id: string) {
  return createHash("sha256")
    .update("piclaw-iroh-client/1:" + id)
    .digest("hex")
    .slice(0, 8);
}
export function clientId(id: string): string {
  id = endpointId(id);
  return "PCL1-" + (id + checksum(id)).toUpperCase().match(/.{8}/g)!.join("-");
}
