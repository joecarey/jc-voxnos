// Voxnos - Platform for building speech-enabled voice applications

import { registry } from './core/registry.js';
import { EchoApp } from './apps/echo.js';
import { ClaudeAssistant } from './apps/claude-assistant.js';
import type { Env, AppContext, SpeechInput } from './core/types.js';

// Register apps
registry.register(new EchoApp());                // Simple echo demo
registry.register(new ClaudeAssistant(), true);  // Default: Claude-powered assistant

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

    // Setup FreeClimb application and phone number
    if (url.pathname === '/setup' && request.method === 'POST') {
      return handleSetup(request, env);
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

async function handleSetup(request: Request, env: Env): Promise<Response> {
  const body = await request.json() as { phoneNumber?: string };
  const baseUrl = new URL(request.url).origin;

  const accountId = env.FREECLIMB_ACCOUNT_ID;
  const apiKey = env.FREECLIMB_API_KEY;
  const auth = btoa(`${accountId}:${apiKey}`);
  const apiBase = 'https://api.freeclimb.com/apiserver';

  try {
    // Step 1: Create FreeClimb Application
    console.log('Creating FreeClimb application...');
    const appResponse = await fetch(`${apiBase}/Accounts/${accountId}/Applications`, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        alias: 'Voxnos Platform',
        voiceUrl: `${baseUrl}/voice`,
        voiceFallbackUrl: `${baseUrl}/voice`,
      }),
    });

    if (!appResponse.ok) {
      const error = await appResponse.text();
      return Response.json({ error: 'Failed to create application', details: error }, { status: 500 });
    }

    const application = await appResponse.json() as { applicationId: string };
    console.log('Application created:', application.applicationId);

    // Step 2: Get phone numbers
    console.log('Fetching phone numbers...');
    const numbersResponse = await fetch(`${apiBase}/Accounts/${accountId}/IncomingPhoneNumbers`, {
      headers: {
        'Authorization': `Basic ${auth}`,
      },
    });

    if (!numbersResponse.ok) {
      const error = await numbersResponse.text();
      return Response.json({ error: 'Failed to fetch phone numbers', details: error }, { status: 500 });
    }

    const numbersData = await numbersResponse.json() as {
      incomingPhoneNumbers: Array<{
        phoneNumberId: string;
        phoneNumber: string;
        alias: string;
      }>;
    };

    const phoneNumbers = numbersData.incomingPhoneNumbers || [];

    if (phoneNumbers.length === 0) {
      return Response.json({
        error: 'No phone numbers found',
        application: { id: application.applicationId, voiceUrl: `${baseUrl}/voice` },
      });
    }

    // Step 3: Update phone number to use the application
    const targetNumber = body.phoneNumber
      ? phoneNumbers.find(n => n.phoneNumber === body.phoneNumber)
      : phoneNumbers[0]; // Use first number if none specified

    if (!targetNumber) {
      return Response.json({
        error: 'Phone number not found',
        available: phoneNumbers.map(n => n.phoneNumber),
        application: { id: application.applicationId, voiceUrl: `${baseUrl}/voice` },
      });
    }

    console.log(`Configuring phone number ${targetNumber.phoneNumber}...`);
    const updateResponse = await fetch(
      `${apiBase}/Accounts/${accountId}/IncomingPhoneNumbers/${targetNumber.phoneNumberId}`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Basic ${auth}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          applicationId: application.applicationId,
        }),
      }
    );

    if (!updateResponse.ok) {
      const error = await updateResponse.text();
      return Response.json({ error: 'Failed to update phone number', details: error }, { status: 500 });
    }

    return Response.json({
      success: true,
      application: {
        id: application.applicationId,
        name: 'Voxnos Platform',
        voiceUrl: `${baseUrl}/voice`,
      },
      phoneNumber: {
        id: targetNumber.phoneNumberId,
        number: targetNumber.phoneNumber,
        configured: true,
      },
      message: `Call ${targetNumber.phoneNumber} to test the Claude assistant!`,
    });

  } catch (error) {
    console.error('Setup error:', error);
    return Response.json({ error: 'Setup failed', details: String(error) }, { status: 500 });
  }
}
