// Voxnos - Platform for building speech-enabled voice applications

import { registry } from './core/registry.js';
import { EchoApp } from './apps/echo.js';
import type { Env, AppContext, SpeechInput } from './core/types.js';

// Register apps
registry.register(new EchoApp(), true);  // Default app

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // FreeClimb voice webhook - handles incoming calls
    if (url.pathname === '/voice' && request.method === 'POST') {
      return handleIncomingCall(request, env);
    }

    // FreeClimb transcription webhook - handles transcribed speech
    if (url.pathname === '/transcription' && request.method === 'POST') {
      return handleTranscription(request, env);
    }

    // Health check
    if (url.pathname === '/') {
      return new Response('voxnos platform running', { status: 200 });
    }

    // List registered apps
    if (url.pathname === '/apps') {
      const apps = registry.list().map(app => ({
        id: app.id,
        name: app.name,
      }));
      return Response.json(apps);
    }

    return new Response('Not Found', { status: 404 });
  },
};

async function handleIncomingCall(request: Request, env: Env): Promise<Response> {
  const body = await request.json() as {
    callId: string;
    from: string;
    to: string;
    callStatus: string;
  };

  console.log(`Incoming call: ${body.callId} from ${body.from}`);

  // Route to appropriate app based on phone number
  const app = registry.getForNumber(body.to);

  if (!app) {
    return Response.json([
      { Say: { text: 'No application configured for this number.' } },
      { Hangup: {} },
    ]);
  }

  // Initialize app context
  const context: AppContext = {
    env,
    callId: body.callId,
    from: body.from,
    to: body.to,
  };

  // Call app's onStart handler
  const response = await app.onStart(context);

  // Convert app response to FreeClimb PerCL
  const percl = buildPerCL(response, request.url);

  return Response.json(percl, {
    headers: { 'Content-Type': 'application/json' },
  });
}

async function handleTranscription(request: Request, env: Env): Promise<Response> {
  const body = await request.json() as {
    callId: string;
    from: string;
    to: string;
    recordingId: string;
    recordingUrl: string;
    digits?: string;
    reason: string;
    recognitionResult?: {
      transcript: string;
      confidence: number;
    };
  };

  console.log(`Transcription for call ${body.callId}:`, body.recognitionResult?.transcript);

  // Route to app
  const app = registry.getForNumber(body.to);

  if (!app) {
    return Response.json([{ Hangup: {} }]);
  }

  // Build context
  const context: AppContext = {
    env,
    callId: body.callId,
    from: body.from,
    to: body.to,
  };

  // Build speech input from transcription
  const input: SpeechInput = {
    text: body.recognitionResult?.transcript ?? '',
    confidence: body.recognitionResult?.confidence,
  };

  // Call app's onSpeech handler
  const response = await app.onSpeech(context, input);

  // Convert to PerCL
  const percl = buildPerCL(response, request.url);

  return Response.json(percl, {
    headers: { 'Content-Type': 'application/json' },
  });
}

// Convert app response to FreeClimb PerCL commands
function buildPerCL(response: any, baseUrl: string): any[] {
  const percl: any[] = [];

  // Say the response text
  if (response.speech?.text) {
    percl.push({
      Say: {
        text: response.speech.text,
        voice: response.speech.voice,
        language: response.speech.language,
      },
    });
  }

  // If we should prompt for more speech, use RecordUtterance
  if (response.prompt) {
    percl.push({
      RecordUtterance: {
        prompts: [
          // RecordUtterance will automatically wait for speech
        ],
        actionUrl: `${new URL(baseUrl).origin}/transcription`,
        autoStart: true,
        maxLengthSec: 30,
        grammarType: 'URL',
        grammarFile: 'builtin:speech/transcribe',  // FreeClimb's transcription grammar
      },
    });
  }

  // Hang up if requested
  if (response.hangup) {
    percl.push({ Hangup: {} });
  }

  // Transfer if requested
  if (response.transfer) {
    percl.push({
      OutDial: {
        destination: response.transfer,
        callConnectUrl: `${new URL(baseUrl).origin}/transfer`,
      },
    });
  }

  return percl;
}
