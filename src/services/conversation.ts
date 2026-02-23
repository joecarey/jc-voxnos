// Shared conversation history management — KV storage for multi-turn calls.

export interface ContentBlock {
  type: 'text' | 'tool_use' | 'tool_result';
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, any>;
  tool_use_id?: string;
  content?: string;
}

export interface Message {
  role: 'user' | 'assistant';
  content: string | ContentBlock[];
}

/** Conversation history TTL — longer than any realistic call. */
export const CONVERSATION_TTL_SECONDS = 15 * 60; // 15 minutes

/**
 * Compress tool_result blocks in conversation history before saving.
 * After Claude has consumed a tool result and generated its spoken summary,
 * the raw data (800+ char cognos briefs, weather payloads) is dead weight.
 * The assistant message that follows already captures what was communicated.
 * Replacing verbose results with a short marker keeps token count bounded
 * across many turns without losing conversational context.
 */
export function compressToolResults(messages: Message[]): void {
  for (const msg of messages) {
    if (msg.role === 'user' && Array.isArray(msg.content)) {
      for (const block of msg.content as ContentBlock[]) {
        if (block.type === 'tool_result' && typeof block.content === 'string' && block.content.length > 120) {
          block.content = block.content.slice(0, 80) + '… [truncated, see assistant summary above]';
        }
      }
    }
  }
}

export async function getMessages(kv: KVNamespace, callId: string): Promise<Message[]> {
  const data = await kv.get(`conv:${callId}`, 'json') as Message[] | null;
  return data ?? [];
}

export async function saveMessages(kv: KVNamespace, callId: string, messages: Message[]): Promise<void> {
  await kv.put(`conv:${callId}`, JSON.stringify(messages), { expirationTtl: CONVERSATION_TTL_SECONDS });
}
