// TTS (Text-to-Speech) abstraction layer
// Allows swapping between different TTS providers (ElevenLabs, AWS Polly, etc.)

/**
 * TTS provider interface
 * Implementations must convert text into provider-specific TTS configuration
 */
export interface TTSProvider {
  /** Provider name (e.g., "ElevenLabs", "AWSPolly") */
  readonly name: string;

  /**
   * Get TTS engine configuration for FreeClimb Say command.
   * Used by the FreeClimb-mediated TTS path (TTS_MODE=freeclimb).
   * @returns FreeClimb engine configuration object or null for default voice
   */
  getEngineConfig(text: string): TTSEngineConfig | null;

  /**
   * Get a Play URL for direct TTS audio delivery.
   * Used by the direct ElevenLabs path (TTS_MODE=direct).
   * If implemented, buildPerCL will emit Play instead of Say.
   * @returns Signed Play URL, or null to fall back to Say
   */
  getPlayUrl?(text: string, origin: string): Promise<string | null>;
}

/**
 * FreeClimb TTS engine configuration
 */
export interface TTSEngineConfig {
  name: string;
  parameters: Record<string, string>;
}

/**
 * Voice configuration for a TTS provider
 */
export interface VoiceConfig {
  voiceId: string;
  languageCode?: string;
  gender?: 'male' | 'female' | 'neutral';
  style?: string;
}
