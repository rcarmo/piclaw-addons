# piclaw-addon-voice-pipeline

ESPHome-only voice assistant extension for `piclaw`.

## What it does

- Connects to an ESPHome/Linux Voice Assistant node (Pi Zero 2 W + ReSpeaker 2-Mic / ThinkSmart style devices)
- Runs wake-word audio through Azure STT
- Sends transcriptions to the Flint chat runtime
- Synthesizes responses with Azure TTS
- Plays announcements back through the AV device
- Exposes an `ava` tool for direct device control (play/pause/scene/sensors/snapshot/announce)
- Persists conversation turns into `tts:default` in the local piclaw message DB

## Install

Set these environment variables in your piclaw environment:

- `AZURE_SPEECH_REGION` (default: `westeurope`)
- `AZURE_SPEECH_KEY` (required)
- `AZURE_SPEECH_STT_LANG` (default: `pt-PT`)
- `AZURE_SPEECH_TTS_VOICE` (default: `pt-PT-RaquelNeural`)
- `AZURE_SPEECH_TTS_LANG` (default: `pt-PT`)
- `ESPHOME_HOST` (required)
- `ESPHOME_PORT` (default: `6053`)
- `ESPHOME_PASSWORD` (optional)
- `ESPHOME_SERVER_HOST` (default: local host IP for device callbacks)
- `ESPHOME_TTS_PORT` (default: `11080`)
- `PICLAW_DB` (default: `/workspace/.piclaw/store/messages.db`)

Then start/reload piclaw.

## Commands

- `/voice-status` — current status
- `/voice-setup` — setup reminder when key is missing
