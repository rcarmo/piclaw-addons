# Remote Peer 0.2.0 three-instance MVP evidence

Date: 2026-08-29

## Test group

Three independent Piclaw 2.15.0 services ran Remote Peer 0.2.0 with separate workspaces, identities, message databases, add-on databases and agent sessions:

| Instance | Endpoint | Public alias | Fingerprint |
|---|---|---|---|
| peer-a | `192.168.1.236:8081` | `alpha` | `tw46ex-99l96L-Z53GKf` |
| peer-b | `192.168.1.151:8080` | `beta` | `3cC1Cq-5IQqAX-zMgwzM` |
| peer-c | `192.168.1.80:8080` | `gamma` | `1Ku4pH-tiYzwK-G7qGRW` |

Peer B and C were disposable clones of the clean microVM template. Peer A was an isolated second service on the existing test VM; the existing soak service was not replaced. All pair acceptances used the immutable fingerprint confirmation. Receiver-owned policy granted only the selected alias, queue/auto modes and files up to 16 MiB each.

External hosted providers available to this test environment could not accept Piclaw's full startup context: Cerebras returned quota/billing errors and Groq's 8k TPM tier rejected about 79k input tokens. The agent-behaviour portion therefore used a deterministic local OpenAI-compatible provider. It drove the real Piclaw model/session loop and emitted real `activate_tools` and `chat` calls; it did not bypass Remote Peer, chat transport validation, signatures, queues, media storage or receipts.

## Results

| Case | Evidence | Result |
|---|---|---|
| Independent agents | Each service completed a separate model turn with `AGENT_READY alpha`, `AGENT_READY beta` and `AGENT_READY gamma`. | Pass |
| Discovery | After agents existed and signed rosters refreshed, every peer directory contained both remote inboxes and the permitted `peer!@alias` entries. | Pass |
| Lazy tool activation | A fresh alpha session called `activate_tools(["chat"])` and then `chat` in the same turn. | Pass |
| Named-agent queue | Alpha sent `UNIQUE_ALPHA_BETA_FINAL` to `peer-b!@beta`; beta stored exactly one authenticated peer message. | Pass |
| Inbox queue | Beta sent `INBOX_BETA_GAMMA_FINAL` to `peer-c!inbox`; gamma stored exactly one message. | Pass |
| Auto mode | Gamma sent `AUTO_GAMMA_BETA_FINAL` to `peer-b!@beta` with `mode=auto`; beta stored exactly one message. | Pass |
| File chat | Alpha sent `evidence.txt` to `peer-c!@gamma`; gamma received one ordinary media attachment. Sender and receiver SHA-256 were both `9652020e04089cfad7851b1421e4c7a225f1a272e73550cc08229f57aae4c293`. | Pass |
| Opaque reply | Gamma received a `peer-a!reply.<capability>` address containing no `web:` JID. After all three services restarted, gamma reused that capability and alpha received `OPAQUE_REPLY_GAMMA_ALPHA_FIXED2` in the original `web:agent-file-final` chat. | Pass |
| Text idempotency | Two independent source chats sent `IDEMPOTENT_TEXT_NORMALIZED_FINAL` with the same stable key; beta retained one timeline row. | Pass |
| File idempotency | Two independent source chats sent `IDEMPOTENT_FILE_NORMALIZED_FINAL` with the same stable key; gamma retained one timeline row/media attachment. | Pass |
| Restart persistence | Pair identities, trust, receiver policies, roster cache, messages, files and the pre-restart opaque reply capability survived restart. | Pass |
| 1 MiB transfer | Agent-driven 1,048,576-byte transfer completed in 1,059 ms (0.944 MiB/s observed end to end). Sender and receiver SHA-256 were both `bf63d8a95fcc2e64619813aae35fdcbe871fdd9264caa3f365eb3aed0f679129`. | Pass |

## Live-found fixes

The trial found and fixed two directory-validator defects before release:

1. Named-agent discovery was incorrectly gated by the sender's local policy record. The sender now requests the receiver's signed roster and uses receiver-owned policy.
2. Opaque reply capabilities were rejected because they are intentionally absent from the public directory. Validation now checks them against the paired peer's advertised inbox policy; the receiver still verifies capability authenticity and expiry.

Both fixes have automated regression coverage in `messaging/service.test.ts`.

## Deferred work

- Multi-hop federation.
- Direct remote execution.
- Automatic file-content deduplication across different logical messages.
- Rich transfer progress/resume for individual files.
- Hosted-provider quality/performance benchmarking; this run proves Piclaw agent orchestration and Remote Peer behavior, not an external model SLA.
