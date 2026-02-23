// Shared speech utilities — pure functions, zero project dependencies.

/** HTTP status codes safe to retry for Anthropic API calls. */
export const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

/**
 * Fetch with exponential backoff retry for transient Anthropic API failures.
 * Uses shorter delays than cognos (500ms, 2s) to minimize caller wait time.
 */
export async function fetchWithRetry(url: string, init: RequestInit): Promise<Response> {
  const RETRY_DELAYS_MS = [500, 2000]; // 2 retries: 0.5s, 2s
  for (let attempt = 0; attempt < 1 + RETRY_DELAYS_MS.length; attempt++) {
    if (attempt > 0) {
      await new Promise<void>(resolve => setTimeout(resolve, RETRY_DELAYS_MS[attempt - 1]));
    }
    try {
      const response = await fetch(url, init);
      if (!response.ok && RETRYABLE_STATUSES.has(response.status) && attempt < RETRY_DELAYS_MS.length) {
        continue;
      }
      return response;
    } catch (networkErr) {
      if (attempt < RETRY_DELAYS_MS.length) continue;
      throw networkErr;
    }
  }
  throw new Error('Anthropic API max retries exceeded');
}

/**
 * Extract complete sentences from a text buffer.
 * A sentence ends at . ! ? followed by whitespace (or end of string for the remainder).
 */
export function extractCompleteSentences(buffer: string): { complete: string[]; remainder: string } {
  const sentences: string[] = [];
  const re = /[.!?][\s]+/g;
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(buffer)) !== null) {
    const sentence = buffer.slice(last, match.index + 1).trim();
    if (sentence) sentences.push(sentence);
    last = match.index + match[0].length;
  }
  return { complete: sentences, remainder: buffer.slice(last) };
}

/** Detect goodbye intent from caller speech. */
export function isGoodbye(text: string): boolean {
  const lower = text.toLowerCase();
  return lower.includes('goodbye') ||
         lower.includes('bye') ||
         lower.includes('see you') ||
         lower.includes('hang up') ||
         lower === 'exit' ||
         lower === 'quit';
}
