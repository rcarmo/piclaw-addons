/**
 * Azure Speech TTS — raw REST, no SDK.
 *
 * Requests raw 16 kHz/16-bit/mono PCM directly from Azure (`raw-…-pcm`) so we
 * never strip a fixed 44-byte header (#10). The caller adds a WAV header for
 * device playback via audio.ts::addWavHeader.
 */
export interface TtsConfig {
  region: string;
  key: string;
  voice: string;
  language: string;
  /** Fetch timeout (ms). Default 15s. */
  timeoutMs?: number;
  /** External abort signal (combined with the timeout). */
  signal?: AbortSignal;
}

function truncate(s: string, max = 2048): string {
  return s.length > max ? `${s.slice(0, max)}… (+${s.length - max} bytes)` : s;
}

function combineSignals(timeoutMs: number, external?: AbortSignal): AbortSignal {
  const t = AbortSignal.timeout(timeoutMs);
  return external ? AbortSignal.any([t, external]) : t;
}

export function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Synthesize speech, returning raw PCM (16 kHz, 16-bit, mono). */
export async function synthesize(text: string, cfg: TtsConfig): Promise<Uint8Array> {
  const ssml =
    `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${cfg.language}">` +
    `<voice name="${cfg.voice}">${escapeXml(text)}</voice></speak>`;

  let res: Response;
  try {
    res = await fetch(`https://${cfg.region}.tts.speech.microsoft.com/cognitiveservices/v1`, {
      method: "POST",
      headers: {
        "Ocp-Apim-Subscription-Key": cfg.key,
        "Content-Type": "application/ssml+xml",
        "X-Microsoft-OutputFormat": "raw-16khz-16bit-mono-pcm",
        "User-Agent": "piclaw-voice/0.2",
      },
      body: ssml,
      signal: combineSignals(cfg.timeoutMs ?? 15_000, cfg.signal),
    });
  } catch (err) {
    const e = err as Error;
    if (e.name === "TimeoutError" || e.name === "AbortError") {
      throw new Error(`Azure TTS timed out after ${cfg.timeoutMs ?? 15_000}ms`);
    }
    throw new Error(`Azure TTS request failed: ${e.message}`);
  }
  if (!res.ok) throw new Error(`Azure TTS ${res.status}: ${truncate(await res.text())}`);

  return new Uint8Array(await res.arrayBuffer());
}
