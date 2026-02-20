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
   * Get TTS engine configuration for FreeClimb Say command
   * @param text - Text to speak
   * @returns FreeClimb engine configuration object or null for default voice
   */
  getEngineConfig(text: string): TTSEngineConfig | null;
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
