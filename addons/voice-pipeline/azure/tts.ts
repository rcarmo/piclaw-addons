/** Azure Speech TTS — raw REST, no SDK. Returns raw PCM (WAV header stripped). */
export interface TtsConfig { region: string; key: string; voice: string; language: string }

export async function synthesize(text: string, cfg: TtsConfig): Promise<Uint8Array> {
  const ssml = `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${cfg.language}">` +
    `<voice name="${cfg.voice}">${escapeXml(text)}</voice></speak>`;

  const res = await fetch(
    `https://${cfg.region}.tts.speech.microsoft.com/cognitiveservices/v1`,
    {
      method: "POST",
      headers: {
        "Ocp-Apim-Subscription-Key": cfg.key,
        "Content-Type": "application/ssml+xml",
        "X-Microsoft-OutputFormat": "riff-16khz-16bit-mono-pcm",
        "User-Agent": "piclaw-voice/0.1",
      },
      body: ssml,
    },
  );
  if (!res.ok) throw new Error(`Azure TTS ${res.status}: ${await res.text()}`);

  const buf = new Uint8Array(await res.arrayBuffer());
  // Strip 44-byte RIFF/WAV header if present
  return isWav(buf) ? buf.slice(44) : buf;
}

function isWav(b: Uint8Array) {
  return b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46;
}

function escapeXml(s: string) {
  return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")
          .replace(/"/g,"&quot;").replace(/'/g,"&apos;");
}
