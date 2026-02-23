// Cognos intelligence tool - provides industry briefs via the /brief endpoint

import type { Tool, ToolDefinition } from './types.js';

export class CognosTool implements Tool {
  private readonly apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  definition: ToolDefinition = {
    name: 'get_industry_brief',
    description: 'Get a concise industry briefing on contact centers, CX, AI, communications, or specific vendors. Returns high-signal updates on company moves, product launches, and key developments.',
    input_schema: {
      type: 'object',
      properties: {
        topic: {
          type: 'string',
          description: 'What to brief on (e.g., "contact centers", "what\'s new in voice AI", "today\'s brief on communications")',
        },
      },
      required: ['topic'],
    },
  };

  async execute(input: Record<string, any>): Promise<string> {
    const topic = input.topic as string;

    try {
      // Call /brief endpoint with voice mode enabled
      const response = await fetch('https://jc-cognos.cloudflare-5cf.workers.dev/brief', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          q: topic,
          category: 'communications',  // Default to communications category
          voice_mode: true,            // Enable voice-optimized output
          voice_detail: 3,             // Balanced detail level (2-4 points, ~60 words each)
        }),
      });

      if (!response.ok) {
        console.error('Cognos API error:', response.status);
        return 'I\'m having trouble accessing the intelligence briefing right now. Could you try again?';
      }

      const data = await response.json() as {
        answer: string;
        sources: any[];
        source_type: 'items' | 'digest';
        voice_mode?: boolean;
        voice_detail?: number;
      };

      console.log(`Cognos brief: source_type=${data.source_type}, voice_mode=${data.voice_mode}, detail=${data.voice_detail}`);

      // Return the voice-optimized answer
      return data.answer || 'No briefing available for that topic right now.';

    } catch (error) {
      console.error('Cognos tool error:', error);
      return `Sorry, I encountered an error getting the industry brief on ${topic}.`;
    }
  }
}
