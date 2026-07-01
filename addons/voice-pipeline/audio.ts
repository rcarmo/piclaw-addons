/**
 * audio.ts — WAV/PCM helpers shared across the voice pipeline.
 *
 * Centralises RIFF/WAVE handling so STT framing (#1) and TTS conversion (#10)
 * are robust rather than relying on a fixed 44-byte header slice.
 */

/** True if the buffer starts with a RIFF/WAVE magic. */
export function isWav(b: Uint8Array): boolean {
  return (
    b.length >= 12 &&
    b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && // "RIFF"
    b[8] === 0x57 && b[9] === 0x41 && b[10] === 0x56 && b[11] === 0x45 // "WAVE"
  );
}

/** Wrap raw PCM in a canonical 44-byte WAV header. */
export function addWavHeader(pcm: Uint8Array, rate: number, channels: number, bits: number): Uint8Array {
  const dataLen = pcm.length;
  const byteRate = (rate * channels * bits) / 8;
  const blockAlign = (channels * bits) / 8;
  const header = new ArrayBuffer(44);
  const view = new DataView(header);

  view.setUint32(0, 0x52494646, false); // "RIFF"
  view.setUint32(4, 36 + dataLen, true);
  view.setUint32(8, 0x57415645, false); // "WAVE"
  view.setUint32(12, 0x666d7420, false); // "fmt "
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bits, true);
  view.setUint32(36, 0x64617461, false); // "data"
  view.setUint32(40, dataLen, true);

  const out = new Uint8Array(44 + dataLen);
  out.set(new Uint8Array(header));
  out.set(pcm, 44);
  return out;
}

/** Return a WAV buffer, adding a header only if the input is not already RIFF/WAVE. */
export function ensureWav(b: Uint8Array, rate: number, channels: number, bits: number): Uint8Array {
  return isWav(b) ? b : addWavHeader(b, rate, channels, bits);
}

/**
 * Return the PCM payload of a WAV buffer by walking RIFF chunks to find `data`,
 * instead of blindly slicing 44 bytes (which corrupts audio when Azure inserts
 * metadata chunks). Non-WAV input is returned unchanged.
 */
export function stripWavHeader(b: Uint8Array): Uint8Array {
  if (!isWav(b)) return b;
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let offset = 12; // past "RIFF"<size>"WAVE"
  while (offset + 8 <= b.length) {
    const id = String.fromCharCode(b[offset], b[offset + 1], b[offset + 2], b[offset + 3]);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === "data") {
      const end = Math.min(body + size, b.length);
      return b.subarray(body, end);
    }
    offset = body + size + (size % 2); // chunks are word-aligned
  }
  // No data chunk found — fall back to the canonical header length.
  return b.subarray(Math.min(44, b.length));
}
