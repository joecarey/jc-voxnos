// Direct ElevenLabs API integration
// Used by the /tts endpoint (on-demand) and V2 streaming pre-generation

export const ELEVENLABS_VOICE_ID = 'EXAVITQu4vr4xnSDxMaL'; // Sarah voice

/**
 * Call ElevenLabs TTS API and return raw MP3 audio bytes.
 * Uses eleven_turbo_v2_5 for lowest latency.
 *
 * @throws Error if ElevenLabs returns a non-200 response
 */
export async function callElevenLabs(
  text: string,
  apiKey: string,
  voiceId = ELEVENLABS_VOICE_ID,
  baseUrl = 'https://api.elevenlabs.io',
): Promise<ArrayBuffer> {
  const response = await fetch(
    `${baseUrl}/v1/text-to-speech/${voiceId}`,
    {
      method: 'POST',
      headers: {
        'xi-api-key': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        text,
        model_id: 'eleven_turbo_v2_5',
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.75,
        },
      }),
    },
  );

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`ElevenLabs error ${response.status}: ${body}`);
  }

  return response.arrayBuffer();
}

/**
 * Compute HMAC-SHA256 signature for TTS URL signing.
 * Returns first 16 hex chars (64-bit) — sufficient for URL signing.
 */
export async function computeTtsSignature(text: string, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(text));
  return Array.from(new Uint8Array(sig))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 16);
}
