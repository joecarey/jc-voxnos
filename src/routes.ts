// HTTP route handlers for voxnos platform

import { registry } from './core/registry.js';
import type { Env, AppContext, SpeechInput } from './core/types.js';
import { buildPerCL, sanitizeForTTS } from './percl/builder.js';
import { ElevenLabsProvider, DirectElevenLabsProvider, ELEVENLABS_VOICE_ID, callElevenLabs } from './tts/index.js';

function getTTSProvider(env: Env) {
  if (env.TTS_MODE === 'direct') {
    return new DirectElevenLabsProvider({
      voiceId: ELEVENLABS_VOICE_ID,
      signingSecret: env.TTS_SIGNING_SECRET,
    });
  }
  return new ElevenLabsProvider({ voiceId: 'EXAVITQu4vr4xnSDxMaL', languageCode: 'en' });
}

/**
 * FreeClimb call webhook - handles incoming calls
 */
export async function handleIncomingCall(request: Request, env: Env): Promise<Response> {
  try {
    const body = await request.json() as {
      callId: string;
      from: string;
      to: string;
      callStatus: string;
    };

    console.log(JSON.stringify({ event: 'call_incoming', callId: body.callId, from: body.from, to: body.to, timestamp: new Date().toISOString() }));

    // Route to appropriate app based on phone number
    const app = registry.getForNumber(body.to);

    if (!app) {
      console.log(JSON.stringify({ event: 'call_no_app', to: body.to, timestamp: new Date().toISOString() }));
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

    const response = await app.onStart(context);

    // Convert app response to FreeClimb PerCL
    const percl = await buildPerCL(response, request.url, getTTSProvider(env));

    return Response.json(percl, {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('Error in handleIncomingCall:', error);
    console.error('Error stack:', error instanceof Error ? error.stack : 'No stack trace');
    return Response.json([
      { Say: { text: 'Sorry, an error occurred. Please try again later.' } },
      { Hangup: {} },
    ], { status: 500 });
  }
}

/**
 * Background processor for sentences 2+ in the V2 streaming path.
 * Runs inside ctx.waitUntil() after routes.ts returns the first-sentence response.
 * Stores each sentence's audio in KV and marks the stream as done when finished.
 */
async function processRemainingStream(
  sentenceStream: AsyncGenerator<string, void, undefined>,
  callKey: string,
  env: Env,
  startIndex: number,
): Promise<void> {
  let n = startIndex;
  try {
    for await (const sentence of sentenceStream) {
      n++;
      const safeSentence = sanitizeForTTS(sentence);
      if (!safeSentence) continue;
      const audio = await callElevenLabs(safeSentence, env.ELEVENLABS_API_KEY);
      const id = crypto.randomUUID();
      await env.RATE_LIMIT_KV.put(`tts:${id}`, audio, { expirationTtl: 120 });
      await env.RATE_LIMIT_KV.put(`${callKey}:${n}`, id, { expirationTtl: 120 });
    }
  } catch (err) {
    console.error('processRemainingStream error:', err);
  } finally {
    await env.RATE_LIMIT_KV.put(`${callKey}:done`, '1', { expirationTtl: 120 });
  }
}

/**
 * FreeClimb conversation webhook - handles each turn of dialogue
 */
export async function handleConversation(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
  const body = await request.json() as {
    callId: string;
    from: string;
    to: string;
    recordingId?: string;
    recordingUrl?: string;
    transcript?: string;
    transcribeReason?: string;
    transcriptionDurationMs?: number;
  };

  console.log(JSON.stringify({ event: 'conversation_turn', callId: body.callId, transcript_length: body.transcript?.length ?? 0, timestamp: new Date().toISOString() }));

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
    text: body.transcript ?? '',
    confidence: undefined,  // FreeClimb doesn't provide confidence in TranscribeUtterance
  };

  // If no transcription, ask to repeat
  if (!input.text || input.text.trim() === '') {
    return Response.json([
      { Say: { text: "I didn't catch that. Could you please repeat?" } },
      {
        TranscribeUtterance: {
          actionUrl: `${new URL(request.url).origin}/conversation`,
          playBeep: false,
          record: {
            maxLengthSec: 25,
            rcrdTerminationSilenceTimeMs: 4000,
          },
        },
      },
    ], {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // V2: streaming path — first sentence TTS'd immediately, rest processed in background
  if (env.TTS_MODE === 'direct' && ctx && app.streamSpeech) {
    const origin = new URL(request.url).origin;
    const callKey = `stream:${context.callId}`;

    try {
      const sentenceStream = app.streamSpeech(context, input);
      const { value: sentence1, done: done1 } = await sentenceStream.next();

      const safeSentence1 = sentence1 ? sanitizeForTTS(sentence1) : '';

      if (safeSentence1) {
        const s1Audio = await callElevenLabs(safeSentence1, env.ELEVENLABS_API_KEY);
        const s1Id = crypto.randomUUID();
        await env.RATE_LIMIT_KV.put(`tts:${s1Id}`, s1Audio, { expirationTtl: 120 });

        const transcribeUtterance = {
          TranscribeUtterance: {
            actionUrl: `${origin}/conversation`,
            playBeep: false,
            record: { maxLengthSec: 25, rcrdTerminationSilenceTimeMs: 4000 },
          },
        };

        if (done1) {
          // Only one sentence — no redirect needed
          return Response.json(
            [{ Play: { file: `${origin}/tts-cache?id=${s1Id}` } }, transcribeUtterance],
            { headers: { 'Content-Type': 'application/json' } },
          );
        }

        // Multiple sentences: return s1 + redirect, process rest in background
        await env.RATE_LIMIT_KV.put(`${callKey}:1`, s1Id, { expirationTtl: 120 });
        ctx.waitUntil(processRemainingStream(sentenceStream, callKey, env, 1));

        return Response.json(
          [
            { Play: { file: `${origin}/tts-cache?id=${s1Id}` } },
            { Redirect: { actionUrl: `${origin}/continue?callId=${context.callId}&n=1` } },
          ],
          { headers: { 'Content-Type': 'application/json' } },
        );
      }
    } catch (streamErr) {
      console.error('Streaming path error, falling back to non-streaming:', streamErr);
    }
  }

  // Standard (non-streaming) path
  const response = await app.onSpeech(context, input);

  // Convert to PerCL
  const percl = await buildPerCL(response, request.url, getTTSProvider(env));

  return Response.json(percl, {
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Health check endpoint
 */
export function handleHealthCheck(): Response {
  return new Response('voxnos platform running', { status: 200 });
}

/**
 * List registered apps endpoint
 */
export function handleListApps(): Response {
  const apps = registry.list().map(app => ({
    id: app.id,
    name: app.name,
  }));
  return Response.json(apps);
}

/**
 * Debug FreeClimb account endpoint
 */
export async function handleDebugAccount(env: Env): Promise<Response> {
  const accountId = env.FREECLIMB_ACCOUNT_ID;
  const apiKey = env.FREECLIMB_API_KEY;
  const auth = btoa(`${accountId}:${apiKey}`);
  const apiBase = 'https://www.freeclimb.com/apiserver';

  try {
    // Try different API paths
    const tests = [
      { name: 'Account', url: `${apiBase}/Accounts/${accountId}` },
      { name: 'IncomingPhoneNumbers (with account)', url: `${apiBase}/Accounts/${accountId}/IncomingPhoneNumbers` },
      { name: 'Applications (with account)', url: `${apiBase}/Accounts/${accountId}/Applications` },
      { name: 'IncomingPhoneNumbers (no account)', url: `${apiBase}/IncomingPhoneNumbers` },
      { name: 'Applications (no account)', url: `${apiBase}/Applications` },
      { name: 'Calls', url: `${apiBase}/Calls` },
    ];

    const results = [];

    for (const test of tests) {
      const response = await fetch(test.url, {
        headers: {
          'Authorization': `Basic ${auth}`,
        },
      });

      const data = await response.text();
      results.push({
        endpoint: test.name,
        status: response.status,
        response: data.substring(0, 200), // First 200 chars
      });
    }

    return Response.json({
      accountId: accountId.substring(0, 8) + '...',
      results,
    });

  } catch (error) {
    return Response.json({ error: String(error) }, { status: 500 });
  }
}

/**
 * List FreeClimb phone numbers endpoint
 */
export async function handleListPhoneNumbers(env: Env): Promise<Response> {
  const accountId = env.FREECLIMB_ACCOUNT_ID;
  const apiKey = env.FREECLIMB_API_KEY;
  const auth = btoa(`${accountId}:${apiKey}`);
  const apiBase = 'https://www.freeclimb.com/apiserver';

  try {
    const response = await fetch(`${apiBase}/Accounts/${accountId}/IncomingPhoneNumbers`, {
      headers: {
        'Authorization': `Basic ${auth}`,
      },
    });

    if (!response.ok) {
      const error = await response.text();
      return Response.json({ error: 'Failed to fetch phone numbers', details: error }, { status: 500 });
    }

    const data = await response.json() as {
      incomingPhoneNumbers: Array<{
        phoneNumberId: string;
        phoneNumber: string;
        alias: string;
        voiceUrl?: string;
        applicationId?: string;
      }>;
    };

    const phoneNumbers = data.incomingPhoneNumbers || [];

    return Response.json({
      count: phoneNumbers.length,
      phoneNumbers: phoneNumbers.map(n => ({
        id: n.phoneNumberId,
        number: n.phoneNumber,
        alias: n.alias,
        voiceUrl: n.voiceUrl,
        applicationId: n.applicationId,
      })),
    });

  } catch (error) {
    console.error('Error fetching phone numbers:', error);
    return Response.json({ error: 'Failed to fetch phone numbers', details: String(error) }, { status: 500 });
  }
}

/**
 * Setup FreeClimb application and phone number endpoint
 */
export async function handleSetup(request: Request, env: Env): Promise<Response> {
  const body = await request.json() as { phoneNumber?: string };
  const baseUrl = new URL(request.url).origin;

  const accountId = env.FREECLIMB_ACCOUNT_ID;
  const apiKey = env.FREECLIMB_API_KEY;
  const auth = btoa(`${accountId}:${apiKey}`);
  const apiBase = 'https://www.freeclimb.com/apiserver';

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
        voiceUrl: `${baseUrl}/call`,
        voiceFallbackUrl: `${baseUrl}/call`,
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
        application: { id: application.applicationId, voiceUrl: `${baseUrl}/call` },
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
        application: { id: application.applicationId, voiceUrl: `${baseUrl}/call` },
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
        voiceUrl: `${baseUrl}/call`,
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

/**
 * Update phone number alias endpoint
 */
export async function handleUpdatePhoneNumber(request: Request, env: Env): Promise<Response> {
  const body = await request.json() as { phoneNumberId: string; alias?: string };

  const accountId = env.FREECLIMB_ACCOUNT_ID;
  const apiKey = env.FREECLIMB_API_KEY;
  const auth = btoa(`${accountId}:${apiKey}`);
  const apiBase = 'https://www.freeclimb.com/apiserver';

  try {
    const updateResponse = await fetch(
      `${apiBase}/Accounts/${accountId}/IncomingPhoneNumbers/${body.phoneNumberId}`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Basic ${auth}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          alias: body.alias,
        }),
      }
    );

    if (!updateResponse.ok) {
      const error = await updateResponse.text();
      return Response.json({ error: 'Failed to update phone number', details: error }, { status: 500 });
    }

    const updated = await updateResponse.json();

    return Response.json({
      success: true,
      phoneNumber: updated,
    });

  } catch (error) {
    console.error('Update error:', error);
    return Response.json({ error: 'Update failed', details: String(error) }, { status: 500 });
  }
}

/**
 * Get FreeClimb logs endpoint
 */
export async function handleGetLogs(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const callId = url.searchParams.get('callId');

  const accountId = env.FREECLIMB_ACCOUNT_ID;
  const apiKey = env.FREECLIMB_API_KEY;
  const auth = btoa(`${accountId}:${apiKey}`);
  const apiBase = 'https://www.freeclimb.com/apiserver';

  try {
    let logsUrl: string;

    if (callId) {
      // Get logs for specific call
      logsUrl = `${apiBase}/Accounts/${accountId}/Calls/${callId}/Logs`;
    } else {
      // Get recent logs (last 50)
      logsUrl = `${apiBase}/Accounts/${accountId}/Logs`;
    }

    const response = await fetch(logsUrl, {
      headers: {
        'Authorization': `Basic ${auth}`,
      },
    });

    if (!response.ok) {
      const error = await response.text();
      return Response.json({
        error: 'Failed to fetch logs',
        details: error,
        url: logsUrl
      }, { status: response.status });
    }

    const logs = await response.json();

    return Response.json(logs);

  } catch (error) {
    console.error('Error fetching logs:', error);
    return Response.json({ error: 'Failed to fetch logs', details: String(error) }, { status: 500 });
  }
}

/**
 * Update FreeClimb application URLs endpoint
 */
export async function handleUpdateApplication(request: Request, env: Env): Promise<Response> {
  const baseUrl = new URL(request.url).origin;
  const accountId = env.FREECLIMB_ACCOUNT_ID;
  const apiKey = env.FREECLIMB_API_KEY;
  const auth = btoa(`${accountId}:${apiKey}`);
  const apiBase = 'https://www.freeclimb.com/apiserver';

  try {
    // Step 1: List all applications to find the Voxnos one
    console.log('Fetching applications...');
    const appsResponse = await fetch(`${apiBase}/Accounts/${accountId}/Applications`, {
      headers: {
        'Authorization': `Basic ${auth}`,
      },
    });

    if (!appsResponse.ok) {
      const error = await appsResponse.text();
      return Response.json({ error: 'Failed to fetch applications', details: error }, { status: 500 });
    }

    const appsData = await appsResponse.json() as {
      applications: Array<{
        applicationId: string;
        alias: string;
        voiceUrl: string;
        voiceFallbackUrl?: string;
      }>;
    };

    const apps = appsData.applications || [];
    const voxnosApp = apps.find(app => app.alias === 'Voxnos Platform');

    if (!voxnosApp) {
      return Response.json({
        error: 'Voxnos Platform application not found',
        availableApps: apps.map(a => ({ id: a.applicationId, name: a.alias })),
      });
    }

    console.log(`Found Voxnos app: ${voxnosApp.applicationId}, current voiceUrl: ${voxnosApp.voiceUrl}`);

    // Step 2: Update the application's voiceUrl
    const newVoiceUrl = `${baseUrl}/call`;

    if (voxnosApp.voiceUrl === newVoiceUrl) {
      return Response.json({
        message: 'Application already configured correctly',
        application: {
          id: voxnosApp.applicationId,
          voiceUrl: voxnosApp.voiceUrl,
        },
      });
    }

    console.log(`Updating voiceUrl to: ${newVoiceUrl}`);
    const updateResponse = await fetch(
      `${apiBase}/Accounts/${accountId}/Applications/${voxnosApp.applicationId}`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Basic ${auth}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          voiceUrl: newVoiceUrl,
          voiceFallbackUrl: newVoiceUrl,
        }),
      }
    );

    if (!updateResponse.ok) {
      const error = await updateResponse.text();
      return Response.json({ error: 'Failed to update application', details: error }, { status: 500 });
    }

    const updated = await updateResponse.json();

    return Response.json({
      success: true,
      message: 'Application updated successfully',
      before: {
        voiceUrl: voxnosApp.voiceUrl,
      },
      after: {
        voiceUrl: newVoiceUrl,
      },
      application: updated,
    });

  } catch (error) {
    console.error('Update application error:', error);
    return Response.json({ error: 'Update failed', details: String(error) }, { status: 500 });
  }
}
