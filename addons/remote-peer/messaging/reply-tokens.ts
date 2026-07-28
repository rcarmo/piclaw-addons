import { createHash, randomBytes } from "node:crypto";
import type Database from "bun:sqlite";
import type { RemotePeerIdentity } from "../identity.js";
import { signCanonical, verifyCanonical } from "../protocol/canonical.js";

const REPLY_TTL_MS = 7 * 24 * 60 * 60_000;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,256}\.[A-Za-z0-9_-]{32,256}$/;

export interface ReplyTokenRecord {
  token_hash: string;
  peer_instance_id: string;
  target_chat_jid: string;
  source_agent_name: string | null;
  expires_at: string;
  created_at: string;
  used_at: string | null;
}

function tokenHash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function encodePayload(value: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

export class ReplyTokenRepository {
  constructor(
    private readonly db: Database,
    private readonly identity: RemotePeerIdentity,
    private readonly now: () => Date = () => new Date(),
  ) {}

  issue(peerInstanceId: string, targetChatJid: string, sourceAgentName?: string): string {
    const createdAt = this.now();
    const payload = encodePayload({ id: randomBytes(18).toString("base64url"), exp: createdAt.getTime() + REPLY_TTL_MS });
    const token = `${payload}.${signCanonical(this.identity, payload)}`;
    this.db.query(`INSERT INTO reply_tokens (
      token_hash, peer_instance_id, target_chat_jid, source_agent_name, expires_at, created_at, used_at
    ) VALUES (?, ?, ?, ?, ?, ?, NULL)`)
      .run(tokenHash(token), peerInstanceId, targetChatJid, sourceAgentName || null,
        new Date(createdAt.getTime() + REPLY_TTL_MS).toISOString(), createdAt.toISOString());
    return token;
  }

  resolve(peerInstanceId: string, token: string): ReplyTokenRecord | null {
    if (!TOKEN_PATTERN.test(token)) return null;
    const separator = token.indexOf(".");
    const payload = token.slice(0, separator);
    const signature = token.slice(separator + 1);
    if (!verifyCanonical(this.identity.public_key, payload, signature)) return null;
    const record = this.db.query("SELECT * FROM reply_tokens WHERE token_hash = ? AND peer_instance_id = ?")
      .get(tokenHash(token), peerInstanceId) as ReplyTokenRecord | null;
    if (!record || Date.parse(record.expires_at) <= this.now().getTime()) return null;
    this.db.query("UPDATE reply_tokens SET used_at = ? WHERE token_hash = ?").run(this.now().toISOString(), record.token_hash);
    return record;
  }
}

export function replyTarget(token: string): string {
  return `reply.${token}`;
}

export function parseReplyTarget(target: string): string | null {
  return target.startsWith("reply.") && TOKEN_PATTERN.test(target.slice(6)) ? target.slice(6) : null;
}
