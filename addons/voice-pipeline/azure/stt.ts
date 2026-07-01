/** Azure Speech STT — raw REST, no SDK. */
import { ensureWav } from "../audio.ts";

export interface SttConfig {
  region: string;
  key: string;
  language: string;
  /** Fetch timeout (ms). Default 15s. */
  timeoutMs?: number;
  sampleRate?: number;
  /** External abort signal (combined with the timeout). */
  signal?: AbortSignal;
}

/** Truncate long/opaque provider error bodies before they reach logs/devices. */
function truncate(s: string, max = 2048): string {
  return s.length > max ? `${s.slice(0, max)}… (+${s.length - max} bytes)` : s;
}

function combineSignals(timeoutMs: number, external?: AbortSignal): AbortSignal {
  const t = AbortSignal.timeout(timeoutMs);
  return external ? AbortSignal.any([t, external]) : t;
}

/**
 * Transcribe PCM (or WAV) audio. The buffer is wrapped in a RIFF/WAVE header if
 * it is raw PCM, so the declared `audio/wav` content type is honest (#1).
 */
export async function transcribe(audio: Uint8Array, cfg: SttConfig): Promise<string> {
  const rate = cfg.sampleRate ?? 16000;
  const wav = ensureWav(audio, rate, 1, 16);

  const url =
    `https://${cfg.region}.stt.speech.microsoft.com` +
    `/speech/recognition/conversation/cognitiveservices/v1` +
    `?language=${encodeURIComponent(cfg.language)}&format=detailed`;

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Ocp-Apim-Subscription-Key": cfg.key,
        "Content-Type": `audio/wav; codecs=audio/pcm; samplerate=${rate}`,
        "Accept": "application/json",
      },
      body: wav as unknown as BodyInit,
      signal: combineSignals(cfg.timeoutMs ?? 15_000, cfg.signal),
    });
  } catch (err) {
    const e = err as Error;
    if (e.name === "TimeoutError" || e.name === "AbortError") {
      throw new Error(`Azure STT timed out after ${cfg.timeoutMs ?? 15_000}ms`);
    }
    throw new Error(`Azure STT request failed: ${e.message}`);
  }
  if (!res.ok) throw new Error(`Azure STT ${res.status}: ${truncate(await res.text())}`);

  const json = (await res.json()) as {
    RecognitionStatus: string;
    NBest?: Array<{ Display: string }>;
    DisplayText?: string;
  };
  if (json.RecognitionStatus !== "Success") throw new Error(`Azure STT: ${json.RecognitionStatus}`);

  return json.NBest?.[0]?.Display ?? json.DisplayText ?? "";
}
