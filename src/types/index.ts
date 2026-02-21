/**
 * DaemonPulse — Shared Type Definitions
 * Sourced from: docs/LMStudioDaemon.md (master technical spec)
 *               docs/The LMS Remote Control Plane.MD
 *               docs/The Remote Orchestrator1.md
 */

// ---------------------------------------------------------------------------
// Daemon & Node
// ---------------------------------------------------------------------------

export type NodeStatus = 'online' | 'offline' | 'unreachable' | 'booting';
export type DaemonState = 'running' | 'stopped' | 'stalled';
export type OS = 'linux' | 'windows' | 'macOS';
export type DaemonMode = 'local' | 'remote';

/**
 * A saved daemon target — one entry per LM Studio host the UI can control.
 * Stored in localStorage as JSON array under 'dp_targets'.
 */
export interface IDaemonTarget {
  id:      string;   // uuid-lite: Date.now() + random
  label:   string;   // display name e.g. "Local Dev", "AWS g6.2xlarge"
  url:     string;   // full base URL e.g. http://192.168.1.70:1234
  host?:   string;   // hostname/IP passed to lms --host flag (if different from URL host)
  key?:    string;   // per-target LM Studio Permission Key
  mode:    DaemonMode;
  os?:     OS;       // hint for lifecycle commands (systemctl vs net start)
}

export interface ILMSNode {
  readonly nodeId: string;
  label: string;
  ipAddress: string;
  port: number;
  status: NodeStatus;
  daemonState: DaemonState;
  hardware: IHardwareInfo;
  tags: string[];
  lastSeen: Date;
}

export interface IHardwareInfo {
  gpus: IGPUInfo[];
  totalVram: number;       // GB
  systemRam: number;       // GB
  os: OS;
  cudaVersion?: string;
  metalSupported?: boolean;
  vulkanVersion?: string;
}

export interface IGPUInfo {
  index: number;
  name: string;
  totalVram: number;       // GB
  usedVram: number;        // GB
  temperature?: number;    // Celsius
  utilisation?: number;    // 0–100 %
  driverStatus: 'ok' | 'error' | 'unknown';
}

// ---------------------------------------------------------------------------
// GPU Allocation
// ---------------------------------------------------------------------------

export type GPUAllocationStrategy = 'priority' | 'even' | 'dedicated';

export interface IAllocationConfig {
  strategy: GPUAllocationStrategy;
  gpuOffloadRatio: number;      // 0.0–1.0
  strictVramLimits: boolean;    // Prevent spillover to system RAM
}

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

export type ModelArchitecture = 'llama' | 'qwen2' | 'mistral' | 'phi' | string;
export type Quantisation = 'Q4_K_M' | 'Q8_0' | 'F16' | 'F32' | string;
export type ModelFormat = 'gguf' | 'mlx';
export type EngineType = 'llama.cpp' | 'mlx';

export interface IModel {
  readonly id: string;
  name: string;
  architecture: ModelArchitecture;
  params: string;          // e.g. "8B", "70B"
  quantisation: Quantisation;
  format: ModelFormat;
  sizeGb: number;
  path: string;
  modifiedAt: Date;
  badges: ModelBadge[];
  yamlConfig?: IModelYamlConfig;
}

export type ModelBadge = 'vision' | 'reasoning' | 'thinking';

export interface IModelYamlConfig {
  temperature?: number;
  topK?: number;
  contextLength?: number;
  enableThinking?: boolean;   // For DeepSeek R1 and similar reasoning models
  systemPrompt?: string;
}

// ---------------------------------------------------------------------------
// Model Load & Pre-flight
// ---------------------------------------------------------------------------

export interface IModelLoadConfig {
  modelId: string;
  nodeId: string;
  gpuOffloadRatio: number;
  contextLength: number;
  ttlSeconds?: number;        // Auto-evict after this period of inactivity
  speculativeDecoding?: ISpeculativeDecodingConfig;
}

export interface IVRAMEstimate {
  modelVramGb: number;
  kvCacheVramGb: number;
  totalRequiredGb: number;
  availableVramGb: number;
  willFit: boolean;
}

/** Shape returned by `lms ps --json` (confirmed field names from LM Studio 0.4.x) */
export interface IRunningModel {
  instance_id:   string;
  model_path?:   string;
  state:         'loaded' | 'loading' | 'unloading' | string;
  vram_usage?:   number;   // GB
  ram_usage?:    number;   // GB
  context_length?: number;
}

/** One entry from `lms runtime survey --json` */
export interface ISurveyGpu {
  index:        number;
  name:         string;
  architecture: 'CUDA' | 'Metal' | 'Vulkan' | string;
  totalVramGb:  number;
  freeVramGb?:  number;
  driver?:      string;
  supported:    boolean;
}

// ---------------------------------------------------------------------------
// Speculative Decoding (spec section 7)
// ---------------------------------------------------------------------------

export interface ISpeculativeDecodingConfig {
  draftModelId: string;
  enabled: boolean;
}

export interface ISpeculativeDecodingStats {
  acceptedDraftTokens: number;
  rejectedDraftTokens: number;
  acceptanceRate: number;      // 0.0–1.0 derived field
}

// ---------------------------------------------------------------------------
// Inference & Batching (spec section 6)
// ---------------------------------------------------------------------------

export interface IBatchingConfig {
  maxConcurrentPredictions: number;   // n_parallel, default 4
  unifiedKvCache: boolean;            // Must default true
  engine: EngineType;
}

export interface IInferenceSlot {
  readonly slotId: number;
  status: 'idle' | 'prefill' | 'generating';
  currentRequestId?: string;
  tokensPerSecond?: number;
  timeToFirstTokenMs?: number;
}

// ---------------------------------------------------------------------------
// Performance KPIs (spec section 9)
// ---------------------------------------------------------------------------

export interface IPerformanceKPIs {
  tokensPerSecond: number;
  timeToFirstTokenMs: number;
  kernelExecutionMs?: number;
  timestamp: Date;
}

// ---------------------------------------------------------------------------
// MCP / Toolchain (spec section 8)
// ---------------------------------------------------------------------------

export interface IMCPServer {
  readonly id: string;
  name: string;
  url: string;
  headers?: Record<string, string>;
  trusted: boolean;
  permissions: IMCPPermissions;
}

export interface IMCPPermissions {
  filesystem: 'none' | 'read' | 'read-write';
  network: boolean;
  codeExecution: boolean;
}

export interface IMCPToolCall {
  readonly id: string;
  serverId: string;
  toolName: string;
  params: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: string;
  timestamp: Date;
}

// ---------------------------------------------------------------------------
// LM Studio /api/v0/ REST API — Chat Completions, Text Completions, Embeddings
// ---------------------------------------------------------------------------

/** Stats block present on /api/v0/chat/completions and /api/v0/completions responses */
export interface ILMSv0Stats {
  tokens_per_second:    number;
  time_to_first_token:  number;   // seconds
  generation_time:      number;   // seconds
  stop_reason:          string;   // "eosFound" | "maxPredictedTokensReached" | …
}

/** model_info block in /api/v0/ responses */
export interface ILMSv0ModelInfo {
  arch:            string;
  quant:           string;
  format:          string;
  context_length:  number;
}

/** runtime block in /api/v0/ responses */
export interface ILMSv0Runtime {
  name:               string;
  version:            string;
  supported_formats:  string[];
}

export interface ILMSv0ChatMessage {
  role:    'system' | 'user' | 'assistant';
  content: string;
}

/** POST /api/v0/chat/completions — OpenAI-compat messages format */
export interface ILMSv0ChatRequest {
  model:        string;
  messages:     ILMSv0ChatMessage[];
  temperature?: number;
  max_tokens?:  number;
  stream?:      boolean;
}

export interface ILMSv0ChatResponse {
  id:      string;
  object:  'chat.completion';
  created: number;
  model:   string;
  choices: Array<{
    index:         number;
    finish_reason: string;
    logprobs:      null;
    message:       ILMSv0ChatMessage;
  }>;
  usage: {
    prompt_tokens:     number;
    completion_tokens: number;
    total_tokens:      number;
  };
  stats:       ILMSv0Stats;
  model_info:  ILMSv0ModelInfo;
  runtime:     ILMSv0Runtime;
}

/** POST /api/v0/completions — Text Completions */
export interface ILMSv0CompletionRequest {
  model:        string;
  prompt:       string;
  temperature?: number;
  max_tokens?:  number;
  stream?:      boolean;
  stop?:        string | string[];
}

export interface ILMSv0CompletionResponse {
  id:      string;
  object:  'text_completion';
  created: number;
  model:   string;
  choices: Array<{
    index:         number;
    text:          string;
    logprobs:      null;
    finish_reason: string;
  }>;
  usage:       { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  stats:       ILMSv0Stats;
  model_info:  ILMSv0ModelInfo;
  runtime:     ILMSv0Runtime;
}

/** POST /api/v0/embeddings */
export interface ILMSv0EmbeddingRequest {
  model: string;
  input: string | string[];
}

export interface ILMSv0EmbeddingResponse {
  object: 'list';
  data: Array<{
    object:    'embedding';
    embedding: number[];
    index:     number;
  }>;
  model: string;
  usage: { prompt_tokens: number; total_tokens: number };
}

// ---------------------------------------------------------------------------
// LM Studio /api/v1/chat — MCP integration descriptors
export type IMCPIntegration =
  | string  // mcp.json server id, e.g. "mcp/playwright"
  | {
      type:          'ephemeral_mcp';
      server_label:  string;
      server_url:    string;
      allowed_tools?: string[];
      headers?:       Record<string, string>;
    };

export interface ILMSChatRequest {
  model:            string;
  input:            string;
  integrations?:    IMCPIntegration[];
  context_length?:  number;
  temperature?:     number;
}

export type ILMSOutputItemType = 'message' | 'reasoning' | 'tool_call';

export interface ILMSOutputItem {
  type:     ILMSOutputItemType;
  content?: string;
  // tool_call fields
  tool?:          string;
  arguments?:     Record<string, unknown>;
  output?:        string;
  provider_info?: { server_label?: string; plugin_id?: string; type: string };
}

export interface ILMSChatResponse {
  model_instance_id: string;
  output:  ILMSOutputItem[];
  stats:   {
    input_tokens:              number;
    total_output_tokens:       number;
    reasoning_output_tokens?:  number;
    tokens_per_second:         number;
    time_to_first_token_seconds: number;
  };
  response_id: string;
}

// ---------------------------------------------------------------------------
// Auth & Sessions
// ---------------------------------------------------------------------------

export type UserRole = 'admin' | 'viewer';

export interface IUser {
  readonly id: number;
  username: string;
  role: UserRole;
  createdAt: Date;
}

export interface ISession {
  userId: number;
  token: string;
  expiresAt: Date;
}

export interface INodeCredentials {
  nodeId: string;
  apiKey: string;
  lastHandshake: Date;
}

// ---------------------------------------------------------------------------
// Event Bus
// ---------------------------------------------------------------------------

export type AppEvent =
  | { type: 'DAEMON_STATE_CHANGED';   payload: { nodeId: string; state: DaemonState } }
  | { type: 'MODEL_LOADED';           payload: { nodeId: string; modelId: string } }
  | { type: 'MODEL_EJECTED';          payload: { nodeId: string; modelId: string } }
  | { type: 'VRAM_UPDATED';          payload: { nodeId: string; gpus: IGPUInfo[] } }
  | { type: 'LOG_LINE';              payload: { nodeId: string; line: string; source: 'runtime' | 'server' } }
  | { type: 'KPI_UPDATED';           payload: IPerformanceKPIs }
  | { type: 'HEARTBEAT_TICK';        payload: { nodeId: string; latencyMs: number } }
  | { type: 'AUTH_SUCCESS';          payload: IUser }
  | { type: 'AUTH_FAILED';           payload: { reason: string } }
  | { type: 'NAVIGATION';            payload: { route: string } }
  | { type: 'MCP_TOOL_CALLED';       payload: { tool: string; serverId: string; args: Record<string, unknown>; output: string; timestamp: Date } };

// ---------------------------------------------------------------------------
// API Response wrapper (used by DaemonService)
// ---------------------------------------------------------------------------

export interface IApiResult<T> {
  success: boolean;
  data?: T;
  error?: string;
  latencyMs: number;
}
