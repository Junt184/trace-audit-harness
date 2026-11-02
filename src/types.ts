export type RunStatus =
  | "starting"
  | "running"
  | "stopping"
  | "compacting"
  | "completed"
  | "stopped"
  | "failed"
  | "interrupted";
export interface ModelConfig {
  provider: string;
  baseUrl: string;
  model: string;
  api: "openai-completions" | "openai-responses" | "anthropic-messages";
  apiKey?: string;
  contextWindow: number;
  maxTokens: number;
}
export interface AuditRun {
  id: string;
  workspaceId?: string;
  title: string;
  repository: string;
  goal: string;
  status: RunStatus;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  endedAt?: string;
  model: string;
  provider: string;
  modelConfig: Omit<ModelConfig, "apiKey">;
  sessionFile?: string;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
  error?: string;
}
export interface AuditWorkspace {
  id: string;
  name: string;
  repository: string;
  createdAt: string;
}
export interface ContextSnapshot {
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
  remainingTokens: number | null;
  autoCompactionEnabled: boolean;
  isCompacting: boolean;
  source: "sdk" | "unavailable";
  sampledAt: string;
  sessionVersion?: string;
  lastCompaction?: {
    at: string;
    reason: string;
    tokensBefore: number;
    estimatedTokensAfter?: number;
  };
  compactionError?: string;
}
export interface RunEvent {
  seq: number;
  at: string;
  type: string;
  data: Record<string, unknown>;
}
export interface Finding {
  id: string;
  title: string;
  severity: string;
  status: string;
  location?: string;
  description: string;
  evidence?: string;
  preconditions?: string;
  reproduction?: string;
  recommendation?: string;
  createdAt: string;
  updatedAt: string;
}
