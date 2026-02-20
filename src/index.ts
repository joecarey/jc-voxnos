// Voxnos - Platform for building speech-enabled voice applications

import { registry } from './core/registry.js';
import { EchoApp } from './apps/echo.js';
import { ClaudeAssistant } from './apps/claude-assistant.js';
import type { Env } from './core/types.js';
import { validateEnv, getEnvSetupInstructions } from './core/env.js';
import { toolRegistry } from './tools/registry.js';
import { WeatherTool } from './tools/weather.js';
import { CognosTool } from './tools/cognos.js';
import {
  handleIncomingCall,
  handleConversation,
  handleHealthCheck,
  handleListApps,
  handleDebugAccount,
  handleListPhoneNumbers,
  handleSetup,
  handleUpdatePhoneNumber,
  handleGetLogs,
  handleUpdateApplication,
} from './routes.js';

// Register tools
toolRegistry.register(new WeatherTool());
toolRegistry.register(new CognosTool());

// Register apps
registry.register(new EchoApp());                // Simple echo demo
registry.register(new ClaudeAssistant(), true);  // Default: Claude-powered assistant

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Validate environment configuration
    const envValidation = validateEnv(env);
    if (!envValidation.valid) {
      console.error('Environment validation failed:', envValidation);
      return new Response(getEnvSetupInstructions(envValidation), {
        status: 500,
        headers: { 'Content-Type': 'text/plain' },
      });
    }

    const url = new URL(request.url);

    // FreeClimb call webhook - handles incoming calls
    if (url.pathname === '/call' && request.method === 'POST') {
      return handleIncomingCall(request, env);
    }

    // FreeClimb conversation webhook - handles each turn of dialogue
    if (url.pathname === '/conversation' && request.method === 'POST') {
      return handleConversation(request, env);
    }

    // Health check
    if (url.pathname === '/') {
      return handleHealthCheck();
    }

    // List registered apps
    if (url.pathname === '/apps') {
      return handleListApps();
    }

    // Debug FreeClimb account
    if (url.pathname === '/debug/account' && request.method === 'GET') {
      return handleDebugAccount(env);
    }

    // List FreeClimb phone numbers
    if (url.pathname === '/phone-numbers' && request.method === 'GET') {
      return handleListPhoneNumbers(env);
    }

    // Setup FreeClimb application and phone number
    if (url.pathname === '/setup' && request.method === 'POST') {
      return handleSetup(request, env);
    }

    // Update phone number alias
    if (url.pathname === '/update-number' && request.method === 'POST') {
      return handleUpdatePhoneNumber(request, env);
    }

    // Get FreeClimb logs
    if (url.pathname === '/logs' && request.method === 'GET') {
      return handleGetLogs(request, env);
    }

    // Update FreeClimb application URLs
    if (url.pathname === '/update-app' && request.method === 'POST') {
      return handleUpdateApplication(request, env);
    }

    return new Response('Not Found', { status: 404 });
  },
};
