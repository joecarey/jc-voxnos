// FreeClimb TTS provider implementations

import type { TTSProvider, TTSEngineConfig, VoiceConfig } from './types.js';

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
 * AWS Polly TTS provider for FreeClimb
 * Uses AWS Polly voices through FreeClimb's Say command
 */
export class AWSPollyProvider implements TTSProvider {
  readonly name = 'AWSPolly';
  private voiceConfig: VoiceConfig;

  constructor(voiceConfig?: Partial<VoiceConfig>) {
    this.voiceConfig = {
      voiceId: voiceConfig?.voiceId ?? 'Joanna',  // Default AWS Polly voice
      languageCode: voiceConfig?.languageCode ?? 'en-US',
    };
  }

  getEngineConfig(_text: string): TTSEngineConfig {
    return {
      name: this.name,
      parameters: {
        voice_id: this.voiceConfig.voiceId,
        language_code: this.voiceConfig.languageCode ?? 'en-US',
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
