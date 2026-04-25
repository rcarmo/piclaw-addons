/** Azure Speech STT — raw REST, no SDK. */
export interface SttConfig { region: string; key: string; language: string }

export async function transcribe(pcm: Uint8Array, cfg: SttConfig): Promise<string> {
  const url =
    `https://${cfg.region}.stt.speech.microsoft.com` +
    `/speech/recognition/conversation/cognitiveservices/v1` +
    `?language=${encodeURIComponent(cfg.language)}&format=detailed`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Ocp-Apim-Subscription-Key": cfg.key,
      "Content-Type": "audio/wav; codecs=audio/pcm; samplerate=16000",
      "Accept": "application/json",
    },
    body: pcm,
  });
  if (!res.ok) throw new Error(`Azure STT ${res.status}: ${await res.text()}`);

  const json = await res.json() as {
    RecognitionStatus: string;
    NBest?: Array<{ Display: string }>;
    DisplayText?: string;
  };
  if (json.RecognitionStatus !== "Success")
    throw new Error(`Azure STT: ${json.RecognitionStatus}`);

  return json.NBest?.[0]?.Display ?? json.DisplayText ?? "";
}
