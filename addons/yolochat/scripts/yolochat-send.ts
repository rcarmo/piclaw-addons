#!/usr/bin/env bun
/**
 * yolochat-send.ts — POST a yolochat message to a remote Pi instance.
 *
 * Usage:
 *   echo "message" | bun yolochat-send.ts <jid@host:port>
 *   printf "line1\nline2" | bun yolochat-send.ts <jid@host:port>
 *   echo "one-liner" | bun yolochat-send.ts web:default@10.0.0.5:3000
 *
 * Address format: jid@host:port  (port defaults to 3000)
 *
 * The message body is always read from stdin.
 */

const [, , toAddr] = process.argv;

if (!toAddr) {
  console.error("Usage: echo 'message' | bun yolochat-send.ts <jid@host:port>");
  process.exit(1);
}

// Read message body from stdin
const chunks: Buffer[] = [];
for await (const chunk of Bun.stdin.stream()) {
  chunks.push(Buffer.from(chunk));
}
const message = Buffer.concat(chunks).toString("utf-8").trimEnd();

if (!message) {
  console.error("Error: empty message (pipe message body into stdin)");
  process.exit(1);
}

// Parse address
const atIndex = toAddr.indexOf("@");
if (atIndex < 1) {
  console.error(`Invalid address: ${toAddr} (expected jid@host:port)`);
  process.exit(1);
}

const jid = toAddr.slice(0, atIndex);
const hostPort = toAddr.slice(atIndex + 1);
const colonIndex = hostPort.lastIndexOf(":");
const host = colonIndex > 0 ? hostPort.slice(0, colonIndex) : hostPort;
const port = colonIndex > 0 ? parseInt(hostPort.slice(colonIndex + 1), 10) : 3000;

// Build local "from" address
const localHost = process.env.HOSTNAME || process.env.HOST || "localhost";
const localPort = process.env.PICLAW_PORT || process.env.PORT || "3000";
const fromAddr = `web:default@${localHost}:${localPort}`;

// Build envelope
const envelope = `From: ${fromAddr}\nTo: ${toAddr}\n\n${message}`;

// POST to remote
const url = `http://${host}:${port}/agent/default/message?chat_jid=${encodeURIComponent(jid)}`;

console.log(`→ POST ${url}`);
console.log(`  From: ${fromAddr}`);
console.log(`  To:   ${toAddr}`);
console.log(`  Body: ${message.length} bytes`);
console.log();

try {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: envelope }),
    signal: AbortSignal.timeout(15_000),
  });

  const body = await response.json().catch(() => null);

  if (response.ok) {
    console.log(`✓ Delivered (HTTP ${response.status})`);
    if (body?.queued) console.log(`  Queued as: ${body.queued}`);
  } else {
    console.error(`✗ Failed (HTTP ${response.status})`);
    if (body?.error) console.error(`  Error: ${body.error}`);
    process.exit(1);
  }
} catch (err: any) {
  console.error(`✗ ${err.message || err}`);
  process.exit(1);
}
