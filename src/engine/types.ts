// Core types for voxnos platform

export interface Env {
  FREECLIMB_ACCOUNT_ID: string;
  FREECLIMB_API_KEY: string;
  FREECLIMB_SIGNING_SECRET: string;
  ANTHROPIC_API_KEY: string;
  ADMIN_API_KEY: string;
  RATE_LIMIT_KV: KVNamespace;
  ELEVENLABS_API_KEY?: string;  // required when TTS_MODE=11labs
  ELEVENLABS_BASE_URL?: string;  // optional: override ElevenLabs API base (e.g. Cloudflare AI Gateway)
  TTS_SIGNING_SECRET: string;
  GOOGLE_TTS_API_KEY?: string;  // required when TTS_MODE=google
  TTS_MODE?: string;  // 'freeclimb' (default) | '11labs' | 'google'
  COGNOS_PUBLIC_KEY: string;
  COGNOS: Fetcher;  // Service binding to jc-cognos Worker
  DB?: D1Database;  // D1 database for persistent survey results (optional — KV fallback if absent)
}

export interface AppContext {
  env: Env;
  callId: string;
  from: string;
  to: string;
}

export interface SpeechInput {
  text: string;          // Transcribed text from caller
  confidence?: number;   // Transcription confidence
  language?: string;
}

export interface SpeechOutput {
  text: string;          // Text to synthesize
  voice?: string;        // TTS voice name
  language?: string;
}

export interface AppResponse {
  speech: SpeechOutput;    // What to say to caller
  audioUrls?: string[];    // Pre-generated audio URLs (V2 streaming path); if set, buildPerCL uses Play
  prompt?: boolean;        // Whether to listen for another response
  hangup?: boolean;        // Whether to end the call
}

// A single sentence chunk yielded by streamSpeech
export interface StreamChunk {
  text: string;
  hangup?: true;       // If set, the call should end after this sentence
  cacheKey?: string;   // If set, use this stable KV key (cache-first, long TTL) instead of a fresh UUID
}

// Base interface that all apps must implement
export interface VoxnosApp {
  id: string;            // Unique app identifier
  name: string;          // Human-readable name

  // Short acknowledgment phrases played immediately on receipt of caller speech.
  // Route layer picks one at random (coin flip) to fill dead air during API TTFB.
  fillerPhrases?: string[];

  // Phrases used when the caller says nothing (empty transcript).
  // Engine picks one at random. Falls back to default retry phrases if not set.
  retryPhrases?: string[];

  // Google TTS voice name (e.g. "en-US-Chirp3-HD-Leda"). When undefined, uses global default.
  voice?: string;

  // Handle start of new call
  onStart(context: AppContext): Promise<AppResponse>;

  // Handle transcribed speech from caller
  onSpeech(context: AppContext, input: SpeechInput): Promise<AppResponse>;

  // Handle end of call
  onEnd?(context: AppContext): Promise<void>;

  // Optional: stream sentences one at a time for lower-latency TTS (V2 path, TTS_MODE=11labs)
  streamSpeech?(context: AppContext, input: SpeechInput): AsyncGenerator<StreamChunk, void, undefined>;
}
