// FreeClimb TTS provider implementations

import type { TTSProvider, TTSEngineConfig, VoiceConfig } from './types.js';
import { computeTtsSignature, ELEVENLABS_VOICE_ID } from './elevenlabs.js';

/**
 * ElevenLabs TTS provider for FreeClimb
 * Uses ElevenLabs voices through FreeClimb's Say command
 */
export class ElevenLabsProvider implements TTSProvider {
  readonly name = 'ElevenLabs';
  private voiceConfig: VoiceConfig;

  constructor(voiceConfig?: Partial<VoiceConfig>) {
    this.voiceConfig = {
      voiceId: voiceConfig?.voiceId ?? 'EXAVITQu4vr4xnSDxMaL',  // Sarah voice (default)
      languageCode: voiceConfig?.languageCode ?? 'en',
    };
  }

  getEngineConfig(_text: string): TTSEngineConfig {
    return {
      name: this.name,
      parameters: {
        voice_id: this.voiceConfig.voiceId,
        language_code: this.voiceConfig.languageCode ?? 'en',
        apply_text_normalization: 'on',
      },
    };
  }
}

/**
 * Default FreeClimb TTS provider (uses FreeClimb's built-in voices)
 * No custom engine - falls back to FreeClimb default
 */
export class FreeClimbDefaultProvider implements TTSProvider {
  readonly name = 'FreeClimbDefault';

  getEngineConfig(_text: string): null {
    // Return null to use FreeClimb's default voice (no custom engine)
    return null;
  }
}

/**
 * Direct ElevenLabs TTS provider — bypasses FreeClimb's engine integration.
 * Generates a signed Play URL pointing to our /tts endpoint.
 * FreeClimb fetches the URL; our Worker calls ElevenLabs directly.
 *
 * Security: URL contains an HMAC signature — only our Worker (which holds
 * TTS_SIGNING_SECRET) can produce a valid signed URL. Random internet
 * callers cannot forge a valid URL and burn ElevenLabs credits.
 */
export class DirectElevenLabsProvider implements TTSProvider {
  readonly name = 'DirectElevenLabs';
  private readonly voiceId: string;
  private readonly signingSecret: string;

  constructor(config: { voiceId?: string; signingSecret: string }) {
    this.voiceId = config.voiceId ?? ELEVENLABS_VOICE_ID;
    this.signingSecret = config.signingSecret;
  }

  getEngineConfig(_text: string): null {
    return null; // not used in direct mode
  }

  async getPlayUrl(text: string, origin: string): Promise<string> {
    const sig = await computeTtsSignature(text, this.signingSecret);
    return `${origin}/tts?text=${encodeURIComponent(text)}&voice=${this.voiceId}&sig=${sig}`;
  }
}
