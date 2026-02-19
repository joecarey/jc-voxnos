// Claude-powered voice assistant app

import type { VoxnosApp, AppContext, SpeechInput, AppResponse } from '../core/types.js';

interface Message {
  role: 'user' | 'assistant';
  content: string;
}

// Simple in-memory conversation storage (callId -> messages)
// TODO: Move to Supabase for persistence
const conversations = new Map<string, Message[]>();

export class ClaudeAssistant implements VoxnosApp {
  id = 'claude-assistant';
  name = 'Claude Voice Assistant';

  async onStart(context: AppContext): Promise<AppResponse> {
    // Initialize conversation history
    conversations.set(context.callId, []);

    return {
      speech: {
        text: this.getTimeBasedGreeting(),
      },
      prompt: true,
    };
  }

  async onSpeech(context: AppContext, input: SpeechInput): Promise<AppResponse> {
    const userMessage = input.text.trim();

    // Check for goodbye intent
    if (this.isGoodbye(userMessage)) {
      return {
        speech: {
          text: 'Goodbye! Have a great day.',
        },
        hangup: true,
      };
    }

    // Get conversation history
    const history = conversations.get(context.callId) || [];

    // Add user message to history
    history.push({
      role: 'user',
      content: userMessage,
    });

    // Call Claude API
    const assistantResponse = await this.callClaude(context, history);

    // Add assistant response to history
    history.push({
      role: 'assistant',
      content: assistantResponse,
    });

    // Update conversation
    conversations.set(context.callId, history);

    return {
      speech: {
        text: assistantResponse,
      },
      prompt: true,  // Keep listening
    };
  }

  async onEnd(context: AppContext): Promise<void> {
    // Clean up conversation history
    conversations.delete(context.callId);
    console.log(`Claude assistant call ended: ${context.callId}`);
  }

  private async callClaude(context: AppContext, history: Message[]): Promise<string> {
    const systemPrompt = `You are a helpful voice assistant. Your responses will be converted to speech, so:
- Keep responses concise (2-3 sentences max)
- Use natural, conversational language
- Avoid special characters, URLs, or formatting
- If asked complex questions, summarize briefly and offer to elaborate
- Be friendly and helpful`;

    try {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': context.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-5-20250929',
          max_tokens: 200,  // Keep responses short for voice
          system: systemPrompt,
          messages: history,
        }),
      });

      if (!response.ok) {
        console.error('Claude API error:', response.status);
        return 'I\'m sorry, I\'m having trouble processing that right now. Could you try again?';
      }

      const data = await response.json() as {
        content: { type: string; text: string }[];
      };

      return data.content[0]?.text || 'I didn\'t catch that. Could you repeat?';

    } catch (error) {
      console.error('Error calling Claude API:', error);
      return 'I\'m experiencing technical difficulties. Please try again.';
    }
  }

  private getTimeBasedGreeting(): string {
    // Get current time in Central Time (America/Chicago)
    const now = new Date();
    const centralTime = new Date(now.toLocaleString('en-US', { timeZone: 'America/Chicago' }));
    const hour = centralTime.getHours();

    let greeting: string;
    if (hour >= 5 && hour < 12) {
      greeting = 'Good morning';
    } else if (hour >= 12 && hour < 18) {
      greeting = 'Good afternoon';
    } else {
      greeting = 'Good evening';
    }

    return `${greeting}! How can I help you today?`;
  }

  private isGoodbye(text: string): boolean {
    const lower = text.toLowerCase();
    return lower.includes('goodbye') ||
           lower.includes('bye') ||
           lower.includes('see you') ||
           lower.includes('hang up') ||
           lower === 'exit' ||
           lower === 'quit';
  }
}
