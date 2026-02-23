// Google Cloud Text-to-Speech integration (Chirp 3 HD)

export const GOOGLE_TTS_VOICE = 'en-US-Chirp3-HD-Despina';

/**
 * Available Google Chirp 3 HD voices (28 total):
 * Female: Achernar, Aoede, Autonoe, Callirrhoe, Despina, Erinome, Gacrux, Kore,
 *         Laomedeia, Leda, Pulcherrima, Sulafat, Vindemiatrix, Zephyr
 * Male:   Charon, Fenrir, Orus, Puck, (and others)
 * Format: en-US-Chirp3-HD-<Name>
 */

export async function callGoogleTTS(
  text: string,
  apiKey: string,
  voice = GOOGLE_TTS_VOICE,
): Promise<ArrayBuffer> {
  const response = await fetch(
    `https://texttospeech.googleapis.com/v1/text:synthesize?key=${encodeURIComponent(apiKey)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        input: { text },
        voice: { languageCode: 'en-US', name: voice },
        audioConfig: { audioEncoding: 'LINEAR16', sampleRateHertz: 8000 },
      }),
    },
  );

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Google TTS error ${response.status}: ${body}`);
  }

  const json = await response.json() as { audioContent: string };
  const binaryStr = atob(json.audioContent);
  const bytes = new Uint8Array(binaryStr.length);
  for (let i = 0; i < binaryStr.length; i++) {
    bytes[i] = binaryStr.charCodeAt(i);
  }
  return bytes.buffer;
}
