# Remote Peer pairing protocol v1

Remote Peer pairing establishes mutual Ed25519 identity trust before messaging is enabled. It does not migrate or trust legacy Piclaw remote state.

## Identity

Each installation creates one Ed25519 key pair. Public identity fields are:

- `instance_id`: base64url SHA-256 of the DER SPKI public key;
- `fingerprint`: a short display form of `instance_id`;
- `public_key`: base64url DER SPKI;
- `protocol_version`: `1`.

The PKCS#8 private key remains in `identity.json` with mode `0600` where supported. It is never returned through routes, tools, commands, Settings, logs, or audit metadata.

## Pairing flow

1. The initiator validates the target URL and sends `POST /api/addons/remote-peer/v1/pair-request` with its public identity, callback URL, random challenge, and expiry.
2. The receiver validates the Ed25519 key/instance ID relationship, URL policy, expiry, duplicate state, and pairing rate limit. It stores a pending request and returns its public identity plus an opaque request ID.
3. An operator reviews the pending request and accepts or denies it with `remote_peer` or `/pair`.
4. On acceptance, the receiver calls the initiator's `pair-callback` endpoint with the request ID, challenge, and receiver ID. The initiator signs a proof over exactly those three newline-delimited values.
5. The receiver verifies that proof using the pending public key. This proves control of both the private key and advertised callback URL.
6. The receiver chooses a negotiated trust epoch greater than either stored epoch, stores the peer, and sends a signed `pair-confirm` request. The initiator verifies the exact received body bytes and stores the same epoch.

Pending requests expire after one hour. A failed URL proof is terminal. A failed confirmation revokes the receiver's provisional peer record and marks the inbound request failed; it does not leave a usable one-sided pairing.

## Signed requests

`pair-confirm`, `ping`, and `revoke` use these headers:

- `X-Instance-Id`
- `X-Timestamp`
- `X-Nonce`
- `X-Sig-Version: v1`
- `X-Signature`
- `X-Trust-Epoch`

The Ed25519 signature covers this UTF-8 canonical value:

```text
METHOD
/path?query
content-type
sha256(exact received body bytes)
timestamp
nonce
instance_id
v1
trust_epoch
```

Verification requires:

- a currently paired peer;
- exact instance ID and trust epoch;
- timestamp within 90 seconds;
- valid signature over exact body bytes and request path/query;
- a nonce not previously accepted for that peer.

Accepted nonces are held in a bounded five-minute replay cache. Signed endpoints have a per-peer rate limit. Revocation increments the trust epoch so previously signed traffic cannot regain trust. Re-pairing negotiates one new epoch that advances beyond the revoked records on both peers.

## URL and network policy

HTTPS and public DNS destinations are required by default. URLs containing credentials and hosts resolving to loopback, link-local, private, carrier-grade NAT, or benchmark ranges are rejected. If any resolved address is private, the URL is rejected.

`allowHttp` and `allowPrivateNetwork` are explicit development options. They weaken transport protections and should be enabled only for controlled private-network testing.

The receiver validates the callback URL before storing a request, then proves ownership by calling it. HTTP clients can still be exposed to DNS rebinding between validation and connection; production deployments should use HTTPS, stable public DNS, and egress filtering.

## Management surfaces

```text
remote_peer({ action: "list_peers" })
remote_peer({ action: "pending" })
remote_peer({ action: "pair_request", url: "https://peer.example" })
remote_peer({ action: "accept_pair", request_id: "pair_..." })
remote_peer({ action: "deny_pair", request_id: "pair_..." })
remote_peer({ action: "ping", peer: "peer-alias" })
remote_peer({ action: "set_alias", peer: "peer-alias", alias: "new-alias" })
remote_peer({ action: "revoke", peer: "peer-alias" })
```

`/pair` provides equivalent operator commands. Aliases are local, case-insensitively unique, and restricted to lowercase letters, digits, dots, underscores, and hyphens.
