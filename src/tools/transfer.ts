// Transfer tool — allows intent-routing apps (e.g. River) to hand off a call
// to another registered app mid-call via a per-call KV override.

import type { Tool, ToolDefinition, ToolContext } from './types.js';
import { registry } from '../engine/registry.js';

export class TransferTool implements Tool {
  definition: ToolDefinition = {
    name: 'transfer_to_app',
    description:
      'Transfer this call to another person. When the caller has a specific request, include caller_intent so the target can respond immediately without re-asking. Leave caller_intent empty when the caller just wants to speak with someone by name.',
    input_schema: {
      type: 'object',
      properties: {
        app_id: {
          type: 'string',
          description: 'The ID of the target app to transfer the call to.',
        },
        caller_intent: {
          type: 'string',
          description: 'Brief summary of what the caller wants, e.g. "weather in Phoenix" or "technology industry brief". Omit when the caller has no specific request.',
        },
      },
      required: ['app_id'],
    },
  };

  async execute(
    input: Record<string, any>,
    context?: ToolContext,
  ): Promise<string> {
    const appId = input.app_id as string;

    if (!context) {
      return 'Error: transfer_to_app requires call context.';
    }

    const target = registry.get(appId);
    if (!target) {
      return `Error: app "${appId}" not found. Check available app IDs.`;
    }

    // Write per-call KV override (two keys to avoid KV eventual-consistency races):
    // 1. Durable app override — written once, never modified, read on every subsequent turn
    // 2. One-shot pending flag — signals the route handler to deliver the target app's greeting
    await context.env.RATE_LIMIT_KV.put(
      `call-app:${context.callId}`,
      appId,
      { expirationTtl: 15 * 60 },
    );
    await context.env.RATE_LIMIT_KV.put(
      `call-app:${context.callId}:pending`,
      '1',
      { expirationTtl: 15 * 60 },
    );

    // If caller has a specific request, store it so the target app can respond directly (warm transfer)
    const callerIntent = (input.caller_intent as string | undefined)?.trim();
    if (callerIntent) {
      await context.env.RATE_LIMIT_KV.put(
        `call-transfer-context:${context.callId}`,
        JSON.stringify({ intent: callerIntent }),
        { expirationTtl: 15 * 60 },
      );
    }

    return `Transfer initiated. The caller will be connected to ${target.name} on the next turn.`;
  }
}
