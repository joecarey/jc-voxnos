// TTS module exports

export type { TTSProvider, TTSEngineConfig, VoiceConfig } from './types.js';
export { ElevenLabsProvider, FreeClimbDefaultProvider, DirectElevenLabsProvider } from './freeclimb.js';
export { callElevenLabs, computeTtsSignature, ELEVENLABS_VOICE_ID } from './elevenlabs.js';
export { callGoogleTTS, GOOGLE_TTS_VOICE } from './google.js';
