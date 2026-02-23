// Echo App - Simple demo that repeats what the caller says

import type { VoxnosApp, AppContext, SpeechInput, AppResponse } from '../engine/types.js';

export class EchoApp implements VoxnosApp {
  id = 'echo';
  name = 'Echo App';

  async onStart(context: AppContext): Promise<AppResponse> {
    return {
      speech: {
        text: 'Welcome to the Echo app. Say something, and I will repeat it back to you.',
      },
      prompt: true,  // Listen for caller's response
    };
  }

  async onSpeech(context: AppContext, input: SpeechInput): Promise<AppResponse> {
    // Simple echo - repeat what they said
    return {
      speech: {
        text: `You said: ${input.text}. Say something else, or say goodbye to end the call.`,
      },
      prompt: true,  // Keep listening
      hangup: input.text.toLowerCase().includes('goodbye'),  // Hang up if they say goodbye
    };
  }

  async onEnd(context: AppContext): Promise<void> {
    console.log(`Echo app call ended: ${context.callId}`);
  }
}
