# piclaw-addon-voice-pipeline

ESPHome-only voice assistant extension for `piclaw`.

Requires Piclaw `>=1.8.0`.

## What it does

- Connects to an ESPHome/Linux Voice Assistant node (Pi Zero 2 W + ReSpeaker 2-Mic / ThinkSmart style devices)
- Runs wake-word audio through Azure STT
- Sends transcriptions to the active Piclaw chat runtime
- Synthesizes responses with Azure TTS
- Plays announcements back through the AV device
- Exposes an `ava` tool for direct device control (play/pause/scene/sensors/snapshot/announce)
- Persists conversation turns into `tts:default` in the local piclaw message DB

## Install

Open **Settings → Add-Ons** and install **voice-pipeline** from the catalog.

Then configure it via environment variables and reload piclaw.

### Secrets (keychain-backed)

This add-on reads secrets from environment variables. In the piclaw container,
keychain entries are automatically injected as env vars (names sanitised:
`/`, `-`, `.` → `_`, uppercased), so **prefer storing secrets in the keychain**
rather than in a plaintext `.env` file:

| Keychain entry | Injected env var | Purpose |
|---|---|---|
| `azure/speech-key` | `AZURE_SPEECH_KEY` | Azure Speech subscription key (**required**) |
| `esphome/password` | `ESPHOME_PASSWORD` | ESPHome API password (optional) |

### Configuration

| Env var | Default | Notes |
|---|---|---|
| `AZURE_SPEECH_KEY` | — | **required** (keychain: `azure/speech-key`) |
| `AZURE_SPEECH_REGION` | `westeurope` | |
| `AZURE_SPEECH_STT_LANG` | `pt-PT` | |
| `AZURE_SPEECH_TTS_VOICE` | `pt-PT-RaquelNeural` | |
| `AZURE_SPEECH_TTS_LANG` | `pt-PT` | |
| `AZURE_SPEECH_STT_TIMEOUT_MS` | `15000` | STT fetch timeout |
| `AZURE_SPEECH_TTS_TIMEOUT_MS` | `15000` | TTS fetch timeout |
| `ESPHOME_HOST` | — | required for device control |
| `ESPHOME_PORT` | `6053` | |
| `ESPHOME_PASSWORD` | — | see security note below |
| `ESPHOME_SERVER_HOST` | *auto-detected LAN IP* | address the device uses to fetch TTS audio |
| `ESPHOME_TTS_PORT` | `11080` | local TTS HTTP server port |
| `ESPHOME_TTS_TTL_MS` | `60000` | evict unfetched TTS clips after this long |
| `ESPHOME_TTS_MAX_ENTRIES` | `32` | hard cap on cached TTS clips |
| `VOICE_LLM_TIMEOUT_MS` | `120000` | LLM turn timeout |
| `VOICE_TURN_TIMEOUT_MS` | `180000` | overall turn watchdog |
| `VOICE_STORE_TURNS` | `1` | parsed and shown in diagnostics; current ESPHome turn handling still persists turns |
| `VOICE_DEBUG` | `0` | set `1` for verbose transcript/response logging |
| `PICLAW_DB` | `/workspace/.piclaw/store/messages.db` | |

`ESPHOME_SERVER_HOST` now **auto-detects the first non-internal LAN IPv4** when
unset. If detection is wrong (multi-homed host, VLANs), set it explicitly — the
detected/used value is shown in `/voice-status`.

## Security notes

- **Plaintext ESPHome API only.** This add-on speaks the *unencrypted* ESPHome
  native API and does **not** support the encrypted (Noise) transport. Set
  `ESPHOME_PASSWORD` and keep the device on a trusted LAN. A warning is logged
  and surfaced in `/voice-status` when no password is set.
- **TTS HTTP server** uses `ESPHOME_SERVER_HOST` as its explicit bind address when that value is not `127.0.0.1`; otherwise Bun uses its default listener binding. The server is `GET`-only, requires a per-process bearer
  token in the URL, evicts clips on a TTL, and is capped in size.

## Commands

- `/voice-status` — current status and configuration diagnostics
- `/voice-setup` — setup instructions and config diagnostics (always available)

## Development

```sh
bun test addons/voice-pipeline/
```
