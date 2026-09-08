# Iroh peer protocol 1

ALPN: `piclaw-remote-peer/iroh/1`. This protocol is incompatible with the removed HTTP protocol.

Each connection handles one bidirectional request/response stream. A four-byte big-endian header length precedes a JSON header (maximum 192 KiB), then up to 32 MiB of raw binary. The receiver rejects unauthorized binary bodies before allocation. Reads/writes use 64 KiB chunks. Inbound concurrency is capped at 16; outbound requests/dials at eight; requests time out after 30 seconds.

The signed header contains `v,id,op,from,to,time,nonce,size,hash,body,signature`. Identity is the Iroh endpoint public key. The receiver compares it to the authenticated QUIC peer, verifies destination, version, timestamp (90 seconds), body size/SHA-256 and Ed25519 signature, then rejects repeated nonces. Replies echo the request ID and are signed by the expected endpoint.

Operations: `pair`, `confirm`, `ping`, `roster`, `message`, `revoke`, `work`, `work-result`, `reply`. Only pairing operations accept unpaired clients, and cannot contain binary data. Other operations require a paired ID and matching random authorization epoch. Revocation changes the epoch and rejects later operations.

The initiating operator supplies the expected client ID. A signed pair request includes a one-hour request ID/epoch and an endpoint ticket matching the actual QUIC peer. The recipient must confirm the full client ID locally before sending confirmation. Repeated matching requests are idempotent. Concurrent reverse requests are rejected for operator resolution. A revoked ID remains blocked until explicitly removed.

Address records are routing hints, not authority. Manual tickets and mDNS candidates must agree with the expected key. Public Iroh lookup is a separately enabled setting used for bare-ID internet dialing. mDNS defaults off and never auto-pairs.
