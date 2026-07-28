import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRemotePeerIdentity } from "../identity.js";
import { openRemotePeerStore } from "../store/index.js";
import { ReplyTokenRepository } from "./reply-tokens.js";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));

describe("remote-peer opaque reply capabilities", () => {
  test("binds a signed capability to the intended peer and source context", () => {
    const root = mkdtempSync(join(tmpdir(), "remote-peer-reply-token-"));
    roots.push(root);
    const store = openRemotePeerStore(root);
    let time = Date.parse("2026-01-01T00:00:00.000Z");
    const tokens = new ReplyTokenRepository(store.db, createRemotePeerIdentity(), () => new Date(time));
    const createdAt = new Date(time).toISOString();
    store.db.query(`INSERT INTO peers (instance_id, peer_alias, public_key, fingerprint, status, created_at, updated_at)
      VALUES ('peer-instance', 'peer', 'public', 'fingerprint', 'paired', ?, ?)`)
      .run(createdAt, createdAt);
    const token = tokens.issue("peer-instance", "web:secret-source", "research");

    expect(token).not.toContain("web:secret-source");
    expect(tokens.resolve("other-peer", token)).toBeNull();
    expect(tokens.resolve("peer-instance", `${token.slice(0, -1)}x`)).toBeNull();
    expect(tokens.resolve("peer-instance", token)).toMatchObject({
      peer_instance_id: "peer-instance",
      target_chat_jid: "web:secret-source",
      source_agent_name: "research",
    });
    expect((store.db.query("SELECT token_hash FROM reply_tokens").get() as any).token_hash).not.toContain(token);

    time += 7 * 24 * 60 * 60_000 + 1;
    expect(tokens.resolve("peer-instance", token)).toBeNull();
    store.close();
  });
});
