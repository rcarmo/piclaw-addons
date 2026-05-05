import { inflateRawSync } from "node:zlib";

function debugSuppressedError(_logger: unknown, _msg: string, _err: unknown, _ctx?: unknown) {}


export function decodeZipEntryText(name: string, method: number, data: Buffer): string | null {
  try {
    if (method === 0) return data.toString("utf-8");
    if (method === 8) return inflateRawSync(data).toString("utf-8");
  } catch (error) {
    debugSuppressedError(null, "Failed to decode an Office zip entry; skipping it.", error, {
      name,
      method,
      byteLength: data.length,
    });
  }
  return null;
}
