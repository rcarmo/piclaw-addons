export class NonceReplayCache {
  private readonly entries = new Map<string, Map<string, number>>();

  constructor(
    private readonly ttlMs = 5 * 60_000,
    private readonly maxPerPeer = 10_000,
  ) {}

  checkAndStore(peerInstanceId: string, nonce: string, now = Date.now()): boolean {
    let peer = this.entries.get(peerInstanceId);
    if (!peer) {
      peer = new Map();
      this.entries.set(peerInstanceId, peer);
    }
    const cutoff = now - this.ttlMs;
    for (const [key, timestamp] of peer) {
      if (timestamp <= cutoff) peer.delete(key);
    }
    if (peer.has(nonce)) return false;
    while (peer.size >= this.maxPerPeer) {
      const oldest = peer.keys().next().value;
      if (oldest === undefined) break;
      peer.delete(oldest);
    }
    peer.set(nonce, now);
    return true;
  }

  clear(): void {
    this.entries.clear();
  }
}
