// Cognos intelligence tool - provides industry briefs via the /brief endpoint

import type { Tool, ToolDefinition } from './types.js';

export class CognosTool implements Tool {
  private readonly apiKey: string;
  private readonly fetcher: Fetcher;

  constructor(apiKey: string, fetcher: Fetcher) {
    this.apiKey = apiKey;
    this.fetcher = fetcher;
  }

  definition: ToolDefinition = {
    name: 'get_industry_brief',
    description: 'Get a real-time industry intelligence briefing. Only use when the caller explicitly asks for a brief, news update, or "what\'s new" about a specific industry topic (contact centers, CX, AI, communications, vendors). Do NOT use for general knowledge questions or questions about your own capabilities.',
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
      // Call /brief via Service Binding (Worker-to-Worker internal routing).
      // Using the binding avoids same-account edge routing issues that cause
      // intermittent 404s when fetching workers.dev URLs from another Worker.
      const url = 'https://cognos/brief'; // host is ignored for service bindings
      const body = JSON.stringify({
        q: topic,
        category: 'communications',
        voice_mode: true,
        voice_detail: 2,
      });

      const RETRY_DELAYS_MS = [500, 2000];
      let lastErr: any = null;
      let response: Response | null = null;

      for (let attempt = 0; attempt < 1 + RETRY_DELAYS_MS.length; attempt++) {
        if (attempt > 0) await new Promise(r => setTimeout(r, RETRY_DELAYS_MS[attempt - 1]));
        try {
          response = await this.fetcher.fetch(url, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${this.apiKey}`,
            },
            body,
          });

          if (!response.ok && [429, 500, 502, 503, 504].includes(response.status) && attempt < RETRY_DELAYS_MS.length) {
            console.warn(`Cognos API transient status ${response.status}, retrying (attempt ${attempt + 1})`);
            continue;
          }

          break;
        } catch (err) {
          lastErr = err;
          console.warn('Cognos fetch error, will retry if attempts remain:', err);
          if (attempt === RETRY_DELAYS_MS.length) throw err;
        }
      }

      if (!response || !response.ok) {
        console.error('Cognos API error or no response', response?.status, lastErr);
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

      return data.answer || 'No briefing available for that topic right now.';

    } catch (error) {
      console.error('Cognos tool error:', error);
      return `Sorry, I encountered an error getting the industry brief on ${topic}.`;
    }
  }
}
