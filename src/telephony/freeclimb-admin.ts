// FreeClimb API admin wrappers — account debug, phone numbers, app setup, logs.
// Separated from call-processing routes for clarity and maintenance.

import { registry } from '../engine/registry.js';
import type { Env } from '../engine/types.js';

function freeclimbAuth(env: Env): { auth: string; apiBase: string } {
  return {
    auth: btoa(`${env.FREECLIMB_ACCOUNT_ID}:${env.FREECLIMB_API_KEY}`),
    apiBase: 'https://www.freeclimb.com/apiserver',
  };
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
  const { auth, apiBase } = freeclimbAuth(env);

  try {
    // Try different API paths
    const tests = [
      { name: 'Account', url: `${apiBase}/Accounts/${env.FREECLIMB_ACCOUNT_ID}` },
      { name: 'IncomingPhoneNumbers (with account)', url: `${apiBase}/Accounts/${env.FREECLIMB_ACCOUNT_ID}/IncomingPhoneNumbers` },
      { name: 'Applications (with account)', url: `${apiBase}/Accounts/${env.FREECLIMB_ACCOUNT_ID}/Applications` },
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
      accountId: env.FREECLIMB_ACCOUNT_ID.substring(0, 8) + '...',
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
  const { auth, apiBase } = freeclimbAuth(env);

  try {
    const response = await fetch(`${apiBase}/Accounts/${env.FREECLIMB_ACCOUNT_ID}/IncomingPhoneNumbers`, {
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

  const { auth, apiBase } = freeclimbAuth(env);

  try {
    // Step 1: Create FreeClimb Application
    console.log('Creating FreeClimb application...');
    const appResponse = await fetch(`${apiBase}/Accounts/${env.FREECLIMB_ACCOUNT_ID}/Applications`, {
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
    const numbersResponse = await fetch(`${apiBase}/Accounts/${env.FREECLIMB_ACCOUNT_ID}/IncomingPhoneNumbers`, {
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
      `${apiBase}/Accounts/${env.FREECLIMB_ACCOUNT_ID}/IncomingPhoneNumbers/${targetNumber.phoneNumberId}`,
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

  const { auth, apiBase } = freeclimbAuth(env);

  try {
    const updateResponse = await fetch(
      `${apiBase}/Accounts/${env.FREECLIMB_ACCOUNT_ID}/IncomingPhoneNumbers/${body.phoneNumberId}`,
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

  const { auth, apiBase } = freeclimbAuth(env);

  try {
    let logsUrl: string;

    if (callId) {
      // Get logs for specific call
      logsUrl = `${apiBase}/Accounts/${env.FREECLIMB_ACCOUNT_ID}/Calls/${callId}/Logs`;
    } else {
      // Get recent logs (last 50)
      logsUrl = `${apiBase}/Accounts/${env.FREECLIMB_ACCOUNT_ID}/Logs`;
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
  const { auth, apiBase } = freeclimbAuth(env);

  try {
    // Step 1: List all applications to find the Voxnos one
    console.log('Fetching applications...');
    const appsResponse = await fetch(`${apiBase}/Accounts/${env.FREECLIMB_ACCOUNT_ID}/Applications`, {
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
      `${apiBase}/Accounts/${env.FREECLIMB_ACCOUNT_ID}/Applications/${voxnosApp.applicationId}`,
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
