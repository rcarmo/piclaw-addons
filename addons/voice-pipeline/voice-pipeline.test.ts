import { describe, expect, test } from "bun:test";

import { addWavHeader, ensureWav, isWav, stripWavHeader } from "./audio.ts";
import { escapeXml } from "./azure/tts.ts";
import { detectLanIp } from "./config.ts";
import { BusyError, VoiceQueue } from "./voice-queue.ts";
import { encodeFrame, FrameReader, MSG } from "./esphome/framing.ts";
import { putTts, TTS_TOKEN, ttsCacheSize, ttsUrl } from "./esphome/client.ts";

describe("audio WAV helpers (#1, #10)", () => {
  const pcm = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);

  test("addWavHeader produces a valid RIFF/WAVE frame", () => {
    const wav = addWavHeader(pcm, 16000, 1, 16);
    expect(wav.length).toBe(44 + pcm.length);
    expect(isWav(wav)).toBe(true);
    // "data" chunk size at offset 40 equals the PCM length
    const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
    expect(view.getUint32(40, true)).toBe(pcm.length);
    // sample rate at offset 24
    expect(view.getUint32(24, true)).toBe(16000);
  });

  test("isWav rejects raw PCM", () => {
    expect(isWav(pcm)).toBe(false);
  });

  test("ensureWav only wraps non-WAV input", () => {
    const wav = ensureWav(pcm, 16000, 1, 16);
    expect(isWav(wav)).toBe(true);
    // already-WAV input is returned unchanged (same reference)
    expect(ensureWav(wav, 16000, 1, 16)).toBe(wav);
  });

  test("stripWavHeader round-trips the PCM payload via the data chunk", () => {
    const wav = addWavHeader(pcm, 16000, 1, 16);
    expect([...stripWavHeader(wav)]).toEqual([...pcm]);
    // non-WAV passthrough
    expect(stripWavHeader(pcm)).toBe(pcm);
  });

  test("stripWavHeader skips extra chunks before data", () => {
    // Build RIFF with a bogus "LIST" chunk (4 bytes) before "data"
    const extra = new Uint8Array(4).fill(0xaa);
    const header = new Uint8Array(12 + 8 + extra.length + 8 + pcm.length);
    const dv = new DataView(header.buffer);
    header.set([0x52, 0x49, 0x46, 0x46], 0); // RIFF
    header.set([0x57, 0x41, 0x56, 0x45], 8); // WAVE
    header.set([0x4c, 0x49, 0x53, 0x54], 12); // LIST
    dv.setUint32(16, extra.length, true);
    header.set(extra, 20);
    let off = 20 + extra.length;
    header.set([0x64, 0x61, 0x74, 0x61], off); // data
    dv.setUint32(off + 4, pcm.length, true);
    header.set(pcm, off + 8);
    expect([...stripWavHeader(header)]).toEqual([...pcm]);
  });
});

describe("escapeXml (TTS SSML injection safety)", () => {
  test("escapes all XML-significant characters", () => {
    expect(escapeXml(`a & b < c > d " e ' f`)).toBe(
      "a &amp; b &lt; c &gt; d &quot; e &apos; f",
    );
  });
});

describe("VoiceQueue (#15)", () => {
  test("resolves with the assistant text on agent_end", async () => {
    const q = new VoiceQueue({ timeoutMs: 1000 });
    const p = q.chat(() => {}, "hi");
    expect(q.busy).toBe(true);
    q.onAgentEnd([
      { role: "user", content: [{ type: "text", text: "hi" }] },
      { role: "assistant", content: [{ type: "text", text: "hello there" }] },
    ]);
    expect(await p).toBe("hello there");
    expect(q.busy).toBe(false);
  });

  test("rejects concurrent requests with a BusyError", async () => {
    const q = new VoiceQueue({ timeoutMs: 1000 });
    const first = q.chat(() => {}, "one");
    await expect(q.chat(() => {}, "two")).rejects.toBeInstanceOf(BusyError);
    q.onAgentEnd([{ role: "assistant", content: [{ type: "text", text: "done" }] }]);
    await first;
  });

  test("times out and frees the queue", async () => {
    const q = new VoiceQueue({ timeoutMs: 20 });
    await expect(q.chat(() => {}, "slow")).rejects.toThrow(/timed out/);
    expect(q.busy).toBe(false);
  });

  test("propagates send errors and resets", async () => {
    const q = new VoiceQueue({ timeoutMs: 1000 });
    await expect(
      q.chat(() => { throw new Error("send failed"); }, "x"),
    ).rejects.toThrow("send failed");
    expect(q.busy).toBe(false);
  });
});

describe("FrameReader framing round-trip", () => {
  test("encodes and drains a single frame", () => {
    const data = new Uint8Array([9, 8, 7]);
    const frame = encodeFrame(MSG.PING_REQUEST, data);
    const reader = new FrameReader();
    reader.push(frame);
    const frames = [...reader.drain()];
    expect(frames).toHaveLength(1);
    expect(frames[0].msgType).toBe(MSG.PING_REQUEST);
    expect([...frames[0].data]).toEqual([9, 8, 7]);
  });

  test("waits for the rest of a split frame", () => {
    const frame = encodeFrame(MSG.HELLO_REQUEST, new Uint8Array([1, 2, 3, 4]));
    const reader = new FrameReader();
    reader.push(frame.slice(0, 2));
    expect([...reader.drain()]).toHaveLength(0); // incomplete
    reader.push(frame.slice(2));
    const frames = [...reader.drain()];
    expect(frames).toHaveLength(1);
    expect([...frames[0].data]).toEqual([1, 2, 3, 4]);
  });
});

describe("TTS cache hardening (#4)", () => {
  test("putTts enforces the max-entries cap and tokenised URL", () => {
    const before = ttsCacheSize();
    for (let i = 0; i < 5; i++) putTts(new Uint8Array([i]), 60_000, 3);
    expect(ttsCacheSize()).toBeLessThanOrEqual(3);
    const id = putTts(new Uint8Array([1]), 60_000, 3);
    const url = ttsUrl("192.168.1.10", 11080, id);
    expect(url).toBe(`http://192.168.1.10:11080/${id}?k=${TTS_TOKEN}`);
    expect(TTS_TOKEN.length).toBeGreaterThan(16);
    expect(before).toBeGreaterThanOrEqual(0);
  });

  test("putTts evicts expired entries", async () => {
    putTts(new Uint8Array([1]), 1, 100); // 1ms TTL
    await new Promise((r) => setTimeout(r, 5));
    const sizeAfterExpiry = (() => {
      putTts(new Uint8Array([2]), 60_000, 100); // triggers expired sweep
      return ttsCacheSize();
    })();
    expect(sizeAfterExpiry).toBeGreaterThanOrEqual(1);
  });
});

describe("config helpers (#7)", () => {
  test("detectLanIp returns an IPv4 string or null", () => {
    const ip = detectLanIp();
    expect(ip === null || /^\d+\.\d+\.\d+\.\d+$/.test(ip)).toBe(true);
  });
});
