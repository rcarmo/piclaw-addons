/**
 * ESPHome plaintext API framing (no Noise encryption).
 * Frame format: 0x00 | varint(data_length) | varint(message_type) | protobuf_bytes
 */

import { encodeVarint, readVarint } from "./proto.ts";

export interface EspFrame {
  msgType: number;
  data: Uint8Array;
}

// ── Message type IDs ─────────────────────────────────────────────────────────

export const MSG = {
  HELLO_REQUEST:                       1,
  HELLO_RESPONSE:                      2,
  AUTHENTICATION_REQUEST:              3,
  AUTHENTICATION_RESPONSE:             4,
  DISCONNECT_REQUEST:                  5,
  DISCONNECT_RESPONSE:                 6,
  PING_REQUEST:                        7,
  PING_RESPONSE:                       8,
  SUBSCRIBE_VOICE_ASSISTANT_REQUEST:   89,
  VOICE_ASSISTANT_REQUEST:             90,
  VOICE_ASSISTANT_RESPONSE:            91,
  VOICE_ASSISTANT_EVENT_RESPONSE:      92,
  VOICE_ASSISTANT_AUDIO:               106,
  VOICE_ASSISTANT_ANNOUNCE_REQUEST:    119,
  VOICE_ASSISTANT_ANNOUNCE_FINISHED:   120,
  VOICE_ASSISTANT_CONFIGURATION_REQUEST:  121,
  VOICE_ASSISTANT_CONFIGURATION_RESPONSE: 122,
} as const;

// VoiceAssistantEvent enum values
export const VA_EVENT = {
  ERROR:            0,
  RUN_START:        1,
  RUN_END:          2,
  STT_START:        3,
  STT_END:          4,
  INTENT_START:     5,
  INTENT_END:       6,
  TTS_START:        7,
  TTS_END:          8,
  WAKE_WORD_START:  9,
  WAKE_WORD_END:    10,
  STT_VAD_START:    11,
  STT_VAD_END:      12,
  TTS_STREAM_START: 98,
  TTS_STREAM_END:   99,
} as const;

// Entity / command message IDs
export const ENTITY_MSG = {
  LIST_ENTITIES_REQUEST:          11,
  LIST_ENTITIES_BINARY_SENSOR:    12,
  LIST_ENTITIES_SENSOR:           16,
  LIST_ENTITIES_SWITCH:           17,
  LIST_ENTITIES_TEXT_SENSOR:      18,
  LIST_ENTITIES_DONE:             19,
  SUBSCRIBE_STATES_REQUEST:       20,
  SENSOR_STATE:                   25,
  SWITCH_STATE:                   26,
  TEXT_SENSOR_STATE:              27,
  SWITCH_COMMAND:                 33,
  LIST_ENTITIES_CAMERA:           43,
  CAMERA_IMAGE_RESPONSE:          44,
  CAMERA_IMAGE_REQUEST:           45,
  LIST_ENTITIES_SELECT:           52,
  SELECT_STATE:                   53,
  SELECT_COMMAND:                 54,
  LIST_ENTITIES_MEDIA_PLAYER:     63,
  MEDIA_PLAYER_STATE:             64,
  MEDIA_PLAYER_COMMAND:           65,
  LIST_ENTITIES_TEXT:             70,
  TEXT_STATE:                     71,
  TEXT_COMMAND:                   73,
} as const;

// VoiceAssistantFeature flags
export const VA_FEATURE = {
  VOICE_ASSISTANT:    1,
  SPEAKER:            2,
  API_AUDIO:          4,
  TIMERS:             8,
  ANNOUNCE:           16,
  START_CONVERSATION: 32,
} as const;

// ── Framing ──────────────────────────────────────────────────────────────────

export function encodeFrame(msgType: number, data: Uint8Array): Uint8Array {
  const lenBytes  = encodeVarint(data.length);
  const typeBytes = encodeVarint(msgType);
  const out = new Uint8Array(1 + lenBytes.length + typeBytes.length + data.length);
  let off = 0;
  out[off++] = 0x00;
  out.set(lenBytes,  off); off += lenBytes.length;
  out.set(typeBytes, off); off += typeBytes.length;
  out.set(data,      off);
  return out;
}

export class FrameReader {
  private buf = new Uint8Array(0);

  push(chunk: Uint8Array) {
    const next = new Uint8Array(this.buf.length + chunk.length);
    next.set(this.buf);
    next.set(chunk, this.buf.length);
    this.buf = next;
  }

  *drain(): Generator<EspFrame> {
    while (this.buf.length >= 3) {
      if (this.buf[0] !== 0x00) {
        console.error("[esphome] bad preamble:", this.buf[0]);
        this.buf = this.buf.slice(1);
        continue;
      }
      let pos = 1;
      const lenR  = readVarint(this.buf, pos);
      pos = lenR.pos;
      const typeR = readVarint(this.buf, pos);
      pos = typeR.pos;

      const dataLen = lenR.value as number;
      if (this.buf.length < pos + dataLen) break; // wait for more

      const data = this.buf.slice(pos, pos + dataLen);
      this.buf = this.buf.slice(pos + dataLen);
      yield { msgType: typeR.value as number, data };
    }
  }
}
