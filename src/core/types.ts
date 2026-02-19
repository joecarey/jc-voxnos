// Core types for voxnos platform

export interface Env {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  FREECLIMB_ACCOUNT_ID: string;
  FREECLIMB_API_KEY: string;
}

export interface AppContext {
  env: Env;
  callId: string;
  from: string;
  to: string;
  sessionId?: string;
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
  speech: SpeechOutput;  // What to say to caller
  prompt?: boolean;      // Whether to listen for another response
  hangup?: boolean;      // Whether to end the call
  transfer?: string;     // Phone number to transfer to
}

// Base interface that all apps must implement
export interface VoxnosApp {
  id: string;            // Unique app identifier
  name: string;          // Human-readable name

  // Handle start of new call
  onStart(context: AppContext): Promise<AppResponse>;

  // Handle transcribed speech from caller
  onSpeech(context: AppContext, input: SpeechInput): Promise<AppResponse>;

  // Handle end of call
  onEnd?(context: AppContext): Promise<void>;
}
