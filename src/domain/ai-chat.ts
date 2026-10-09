import type { ModelProtocol } from './models';

export const MAX_AI_PROMPT_BYTES = 64 * 1024;
export const MAX_AI_OUTPUT_BYTES = 256 * 1024;
export const MAX_AI_TURNS = 30;
export const MAX_AI_HISTORY_MESSAGES = 20;
export const MAX_AI_CONTEXT_BYTES = 512 * 1024;
export const MAX_AI_API_KEY_BYTES = 2048;

/** Sending binds the message and its conversation to the exact saved target. */
export interface AiChatAuthorization {
  scope: 'conversation' | 'userTextOnly';
  protocol: ModelProtocol;
  endpoint: string;
  modelId: string;
}

/** Complete earlier exchanges, in user/assistant pairs, belonging to this target only. */
export interface AiChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface AiChatRequest {
  requestId: string;
  modelProfileId: string;
  prompt: string;
  authorization: AiChatAuthorization;
  history?: readonly AiChatMessage[];
  /** Optional single-use bearer credential, never stored in a profile or transcript. */
  apiKey?: string;
}

export interface AiChatCancelRequest {
  requestId: string;
  modelProfileId: string;
}

/** Text-only events travel on a per-invocation Tauri channel, not a global event bus. */
export interface AiChatDelta {
  requestId: string;
  modelProfileId: string;
  sequence: number;
  text: string;
}

export type AiChatOutcome = 'complete' | 'length' | 'filtered';

export interface AiChatResponse {
  requestId: string;
  modelProfileId: string;
  protocol: ModelProtocol;
  endpoint: string;
  modelId: string;
  actualModelId: string | null;
  sequence: number;
  text: string;
  outcome: AiChatOutcome;
}

export interface AiChatBackend {
  readonly available: boolean;
  chat(request: AiChatRequest, onDelta: (delta: AiChatDelta) => void): Promise<AiChatResponse>;
  cancel(request: AiChatCancelRequest): Promise<boolean>;
}
