import { AsyncLocalStorage } from "node:async_hooks";

export interface RemotePeerAcceptedOperation {
  readonly chatJid: string;
  readonly cwd: string;
  assertCurrent(): void;
}
/** Application lifetime, not a saved tool callback. Each call must accept a NEW
 * host operation, bind its real source/session/incarnation, and settle it after body. */
export interface RemotePeerApplicationPorts {
  acceptOperation<T>(source: { kind: "incoming" | "application"; peer?: string; revision?: string; operation: string },
    body: (operation: RemotePeerAcceptedOperation) => Promise<T>): Promise<T>;
}

export class RemotePeerAuthorityScope {
  private readonly current = new AsyncLocalStorage<Pick<RemotePeerAcceptedOperation, "assertCurrent">>();
  private readonly peer = new AsyncLocalStorage<{ peer: string; revision: string }>();
  verifiedPeer() { this.assertCurrent(); const peer = this.peer.getStore(); if (!peer) throw Error("Authenticated peer required"); return peer; }
  constructor(private readonly ports: RemotePeerApplicationPorts | { assertCurrent(): void; assertPeerCurrent?(source: { peer: string; revision: string; operation: string }): void }, private readonly scopedRoot?: <T>(assertCurrent: () => void, body: () => T) => T) {}
  assertCurrent = () => {
    const operation = this.current.getStore();
    if (!operation) throw Error("Remote Peer accepted operation required");
    operation.assertCurrent();
  };
  run<T>(operation: RemotePeerAcceptedOperation, body: () => T): T {
    operation.assertCurrent();
    return this.current.run(operation, () => this.scopedRoot ? this.scopedRoot(this.assertCurrent, body) : body());
  }
  incoming<T>(source: { peer: string; revision: string; operation: string }, body: () => Promise<T>): Promise<T> {
    // Do not inherit an outbound invocation's async context on loopback ingress.
    return this.peer.run(source, () => this.current.exit(() => {
      if (!("acceptOperation" in this.ports)) {
        const owner = this.ports; owner.assertCurrent();
        return this.run({ chatJid: "", cwd: "", assertCurrent() { owner.assertCurrent(); owner.assertPeerCurrent?.(source); } }, body);
      }
      return this.ports.acceptOperation({ kind: "incoming", ...source }, operation => this.run(operation, body));
    }));
  }
  application<T>(operation: string, body: () => Promise<T>): Promise<T> {
    return this.current.exit(() => {
      if (!("acceptOperation" in this.ports)) { const owner = this.ports; owner.assertCurrent(); return this.run({ chatJid: "", cwd: "", assertCurrent: () => owner.assertCurrent() }, body); }
      return this.ports.acceptOperation({ kind: "application", operation }, accepted => this.run(accepted, body));
    });
  }
  /** Checks at actual dependency invocation, including after service awaits.
   * Bind methods to the real receiver (SQLite/transport private fields). */
  guard<T extends object>(target: T): T {
    const cache = new Map<PropertyKey, unknown>();
    return new Proxy(target, { get: (object, key) => {
      const value = Reflect.get(object, key, object);
      if (typeof value === "function") return (...args: unknown[]) => {
        this.assertCurrent();
        const result = Reflect.apply(value, object, args);
        return ["query", "prepare", "transaction"].includes(String(key)) && result
          ? this.guard(result) : result;
      };
      if (value && typeof value === "object" && !Array.isArray(value) && !(value instanceof Uint8Array) && !(value instanceof Promise)) {
        if (!cache.has(key)) cache.set(key, this.guard(value));
        return cache.get(key);
      }
      return value;
    }});
  }
}
