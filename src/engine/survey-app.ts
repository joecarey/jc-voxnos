// SurveyApp — scripted question-and-answer flow.
// Sequential questions with typed answer parsing. No LLM for the Q&A loop;
// Claude generates a structured summary after the last question for storage.

import type { AppContext, SpeechInput, AppResponse } from './types.js';
import type { ClaudeConfig } from '../services/claude-client.js';
import { BaseApp } from './base-app.js';
import { callClaude, CLAUDE_MODEL } from '../services/claude-client.js';
import { saveSurveyResult } from '../services/survey-store.js';

export interface SurveyQuestion {
  text: string;
  type: 'yes_no' | 'scale' | 'open';
  label: string;
}

export interface SurveyAnswer {
  label: string;
  question: string;
  type: SurveyQuestion['type'];
  raw: string;
  parsed: string | number | boolean | null;
}

interface SurveyState {
  currentQuestion: number;
  answers: SurveyAnswer[];
  /** Consecutive parse failures on the current question (reset on success). */
  retriesForQuestion: number;
  /** Total parse failures across all questions in this call. */
  totalErrors: number;
}

export interface SurveyConfig {
  id: string;
  name: string;
  greeting: string;
  closing: string;
  questions: SurveyQuestion[];
  retries?: string[];
  voice?: string;
}

const SURVEY_STATE_TTL = 15 * 60; // 15 minutes — same as conversation history
const SURVEY_RESULTS_TTL = 24 * 60 * 60; // 24 hours — completed results for later retrieval

/** Max consecutive parse failures per question before bailing. */
const MAX_RETRIES_PER_QUESTION = 3;
/** Max total parse failures across all questions before bailing. */
const MAX_TOTAL_ERRORS = 5;

const BAIL_MESSAGE = "I'm sorry, we seem to be having some trouble. Thank you for your time. Goodbye.";

export class SurveyApp extends BaseApp {
  private readonly surveyConfig: SurveyConfig;

  constructor(config: SurveyConfig) {
    super({ id: config.id, name: config.name, retryPhrases: config.retries, voice: config.voice });
    this.surveyConfig = config;
  }

  protected getGreeting(): string {
    return this.surveyConfig.greeting;
  }

  /** Override BaseApp.onStart to append the first question to the greeting. */
  async onStart(context: AppContext): Promise<AppResponse> {
    const response = await super.onStart(context);

    // Initialize state
    const state: SurveyState = { currentQuestion: 0, answers: [], retriesForQuestion: 0, totalErrors: 0 };
    await this.saveState(context, state);

    // Append first question to greeting
    const firstQ = this.surveyConfig.questions[0];
    response.speech.text += ` ${firstQ.text}`;
    return response;
  }

  async onSpeech(context: AppContext, input: SpeechInput): Promise<AppResponse> {
    const state = await this.loadState(context);
    if (!state) {
      return { speech: { text: 'Sorry, something went wrong. Goodbye.' }, hangup: true };
    }

    const { questions, closing } = this.surveyConfig;
    const currentQ = questions[state.currentQuestion];
    const raw = input.text.trim();

    // Parse answer based on question type
    const parsed = this.parseAnswer(raw, currentQ.type);

    if (parsed === null) {
      state.retriesForQuestion++;
      state.totalErrors++;

      // Bail: global error cap or per-question cap reached
      if (state.totalErrors >= MAX_TOTAL_ERRORS || state.retriesForQuestion >= MAX_RETRIES_PER_QUESTION) {
        return { speech: { text: BAIL_MESSAGE }, hangup: true };
      }

      await this.saveState(context, state);
      const reprompt = this.getReprompt(currentQ, state.retriesForQuestion);
      return { speech: { text: reprompt }, prompt: true };
    }

    // Record answer — reset per-question retry counter on success
    state.retriesForQuestion = 0;
    state.answers.push({
      label: currentQ.label,
      question: currentQ.text,
      type: currentQ.type,
      raw,
      parsed,
    });

    state.currentQuestion++;

    if (state.currentQuestion < questions.length) {
      // More questions — save state and ask next
      await this.saveState(context, state);
      const nextQ = questions[state.currentQuestion];
      const ack = this.getAcknowledgment(currentQ.type, parsed);
      return {
        speech: { text: `${ack} ${nextQ.text}` },
        prompt: true,
      };
    }

    // All questions answered — generate summary and store results
    const summary = await this.generateSummary(context, state.answers);
    await this.storeResults(context, state.answers, summary);

    return {
      speech: { text: closing },
      hangup: true,
    };
  }

  /** Override BaseApp.onEnd to also clean up survey state. */
  async onEnd(context: AppContext): Promise<void> {
    await context.env.RATE_LIMIT_KV.delete(`survey:${context.callId}`);
    await super.onEnd(context);
  }

  // --- Answer parsing ---

  private parseAnswer(raw: string, type: SurveyQuestion['type']): string | number | boolean | null {
    const lower = raw.toLowerCase();

    switch (type) {
      case 'yes_no': {
        if (/\b(yes|yeah|yep|sure|absolutely|definitely|of course)\b/.test(lower)) return true;
        if (/\b(no|nope|nah|not really|negative)\b/.test(lower)) return false;
        return null; // unclear — re-prompt
      }
      case 'scale': {
        const match = lower.match(/\b([1-5])\b/);
        if (match) return parseInt(match[1], 10);
        // Try word forms
        const words: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5 };
        for (const [word, num] of Object.entries(words)) {
          if (lower.includes(word)) return num;
        }
        return null; // unclear — re-prompt
      }
      case 'open':
        return raw; // accept anything
    }
  }

  private getReprompt(question: SurveyQuestion, tier: number): string {
    if (tier === 1) {
      switch (question.type) {
        case 'yes_no':
          return `I didn't quite catch that. Could you answer yes or no? ${question.text}`;
        case 'scale':
          return `I need a number from 1 to 5. ${question.text}`;
        case 'open':
          return `Could you say that again? ${question.text}`;
      }
    }
    // Tier 2 — different phrasing, last chance before bail
    switch (question.type) {
      case 'yes_no':
        return `Let me try one more time. Just a simple yes or no. ${question.text}`;
      case 'scale':
        return `Once more, on a scale of 1 to 5, just the number. ${question.text}`;
      case 'open':
        return `Sorry about that. One more try. ${question.text}`;
    }
  }

  private getAcknowledgment(type: SurveyQuestion['type'], parsed: string | number | boolean): string {
    switch (type) {
      case 'yes_no':
        return parsed ? 'Got it, yes.' : 'Got it, no.';
      case 'scale':
        return `${parsed} out of 5, got it.`;
      case 'open':
        return 'Thank you.';
    }
  }

  // --- Summary generation ---

  private async generateSummary(context: AppContext, answers: SurveyAnswer[]): Promise<string> {
    const config: ClaudeConfig = {
      systemPrompt: 'You are a survey analysis assistant. Given a set of survey responses, produce a concise structured summary in 2-3 sentences. Focus on key sentiments and scores. Do not use formatting, lists, or special characters — plain text only.',
      model: CLAUDE_MODEL,
      fillerPhrases: [],
    };

    const formatted = answers.map(a => {
      const value = typeof a.parsed === 'boolean' ? (a.parsed ? 'Yes' : 'No') : String(a.parsed);
      return `${a.label}: ${value} (question: "${a.question}", verbatim: "${a.raw}")`;
    }).join('\n');

    const messages = [{ role: 'user' as const, content: `Summarize these survey responses:\n${formatted}` }];

    try {
      return await callClaude(config, context, messages);
    } catch {
      return 'Summary generation failed.';
    }
  }

  // --- State management ---

  private async loadState(context: AppContext): Promise<SurveyState | null> {
    return await context.env.RATE_LIMIT_KV.get(`survey:${context.callId}`, 'json') as SurveyState | null;
  }

  private async saveState(context: AppContext, state: SurveyState): Promise<void> {
    await context.env.RATE_LIMIT_KV.put(
      `survey:${context.callId}`,
      JSON.stringify(state),
      { expirationTtl: SURVEY_STATE_TTL },
    );
  }

  private async storeResults(context: AppContext, answers: SurveyAnswer[], summary: string): Promise<void> {
    const result = {
      callId: context.callId,
      from: context.from,
      completedAt: new Date().toISOString(),
      surveyId: this.id,
      answers,
      summary,
    };

    // D1-first: persistent storage. Falls back to KV if D1 is not bound.
    if (context.env.DB) {
      const saved = await saveSurveyResult(context.env.DB, result);
      if (saved) {
        console.log(JSON.stringify({ event: 'survey_complete', store: 'd1', callId: context.callId, app: this.id, answers: answers.length }));
        return;
      }
      // D1 write failed — fall through to KV
    }

    await context.env.RATE_LIMIT_KV.put(
      `survey-results:${context.callId}`,
      JSON.stringify(result),
      { expirationTtl: SURVEY_RESULTS_TTL },
    );
    console.log(JSON.stringify({ event: 'survey_complete', store: 'kv', callId: context.callId, app: this.id, answers: answers.length }));
  }
}
