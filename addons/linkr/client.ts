import type { Profile } from "./config.js";
import { getKeychainEntry } from "./compat/keychain.js";
import { validate, type Event } from "./input.js";
export interface Transport {
  snapshot(signal?: AbortSignal): Promise<Buffer>;
  control(events: Event[], signal?: AbortSignal): Promise<void>;
}
export class LinkrClient implements Transport {
  constructor(
    readonly profile: Profile,
    private secret: () => string | Promise<string> = async () =>
      (await getKeychainEntry(profile.tokenKeychain)).secret,
    private fetcher: typeof fetch = fetch,
  ) {}
  private async request(
    path: string,
    body: unknown | undefined,
    signal?: AbortSignal,
  ): Promise<Buffer> {
    const token = await this.secret();
    if (!token || /[\r\n]/.test(token))
      throw new Error("Missing or invalid keychain token.");
    const signals = [AbortSignal.timeout(75000), ...(signal ? [signal] : [])];
    try {
      const r = await this.fetcher(this.profile.origin + path, {
        method: body ? "POST" : "GET",
        body: body ? JSON.stringify(body) : undefined,
        headers: {
          Authorization: `token ${token}`,
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        redirect: "error",
        signal: AbortSignal.any(signals),
      });
      if (!r.ok) throw new Error("HTTP failure");
      const reader = r.body?.getReader();
      if (!reader) throw new Error("No body");
      let size = 0;
      const chunks: Uint8Array[] = [];
      const limit = body ? 65536 : 10 * 1024 * 1024;
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.length;
        if (size > limit) {
          await reader.cancel();
          throw new Error("Response too large");
        }
        chunks.push(next.value);
      }
      return Buffer.concat(chunks);
    } catch {
      throw new Error(
        body
          ? "Control delivery uncertain or rejected. Observe before retrying; no automatic retry was made."
          : "Snapshot failed (network, HTTP, timeout or size limit).",
      );
    }
  }
  async snapshot(signal?: AbortSignal) {
    const b = await this.request("/api/public/snapshot", undefined, signal);
    if (b[0] !== 255 || b[1] !== 216 || b[2] !== 255)
      throw new Error("Snapshot is not a JPEG.");
    return b;
  }
  async control(events: Event[], signal?: AbortSignal) {
    const b = await this.request(
      "/api/public/control",
      validate({ events }),
      signal,
    );
    try {
      if (JSON.parse(b.toString()).code === 0) return;
    } catch {}
    throw new Error(
      "Invalid or unsuccessful control reply; observe before retrying.",
    );
  }
  /** Known pressed inputs only, bounded; used to reconcile an interrupted batch. */
  async release(keys: string[], mouse: boolean, signal?: AbortSignal) {
    if (
      keys.length > 64 ||
      keys.some((k) => !/^[A-Za-z][A-Za-z0-9]{0,39}$/.test(k))
    )
      throw new Error("Invalid release set.");
    const events: Event[] = [
      ...keys.map((k) => ["keyboard", k, false] as Event),
      ...(mouse ? [["mouse_rel", 0, 0, 0, 0, 0] as Event] : []),
    ];
    if (events.length) {
      const b = await this.request("/api/public/control", { events }, signal);
      try {
        if (JSON.parse(b.toString()).code === 0) return;
      } catch {}
      throw new Error("Release not acknowledged.");
    }
  }
}
