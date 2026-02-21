/**
 * DaemonService — All communication with the llmster REST API.
 *
 * Implements the Interface Segregation Principle: this class is
 * only responsible for HTTP transport to/from the daemon.
 * It never touches the DOM or the Store directly.
 * Controllers consume it and decide what to do with results.
 *
 * Spec reference: docs/LMStudioDaemon.md sections 2, 3, 4
 */

import type {
  IApiResult, ILMSNode, IVRAMEstimate, IModelLoadConfig, DaemonState,
  ILMSChatRequest, ILMSChatResponse,
  ILMSv0ChatRequest, ILMSv0ChatResponse,
  ILMSv0CompletionRequest, ILMSv0CompletionResponse,
  ILMSv0EmbeddingRequest, ILMSv0EmbeddingResponse,
} from '@/types';
import { AuthService } from './AuthService';

/**
 * Flat record returned by GET /api/v0/models and GET /api/v0/models/:id
 * (LM Studio native REST API, introduced alongside v0.4)
 */
export interface LMSModelRecord {
  id:                 string;
  object?:            string;       // "model"
  type:               string;       // "llm" | "vlm" | "embeddings"
  publisher?:         string;       // e.g. "lmstudio-community"
  arch?:              string;       // e.g. "llama" | "qwen2_vl"
  compatibility_type?: string;      // "gguf" | "mlx"
  quantization?:      string;       // e.g. "Q4_K_M" | "4bit"
  state:              string;       // "loaded" | "not-loaded"
  max_context_length?: number;
}

export class DaemonService {
  constructor(private readonly baseUrl: string) {}

  // --- Lifecycle (spec section 2) ---

  async daemonUp(): Promise<IApiResult<void>> {
    return this.post('/api/proxy/daemon/up');
  }

  async daemonDown(): Promise<IApiResult<void>> {
    return this.post('/api/proxy/daemon/down');
  }

  async serverStart(): Promise<IApiResult<void>> {
    return this.post('/api/proxy/server/start');
  }

  async serverStop(): Promise<IApiResult<void>> {
    return this.post('/api/proxy/server/stop');
  }

  // --- Hardware discovery (spec section 4) ---

  async runtimeSurvey(): Promise<IApiResult<ILMSNode['hardware']>> {
    return this.get('/api/proxy/runtime/survey');
  }

  async getDaemonState(): Promise<IApiResult<DaemonState>> {
    // /api/v0/models is the canonical liveness probe in LM Studio (native REST API).
    return this.get('/api/proxy/models');
  }

  // --- Pre-flight VRAM estimate (spec section 5) ---

  async estimateVram(config: IModelLoadConfig): Promise<IApiResult<IVRAMEstimate>> {
    return this.post('/api/proxy/models/estimate', config);
  }

  // --- Model load / eject ---

  /** Full load config (context length, GPU offload, etc.) */
  async loadModel(config: IModelLoadConfig): Promise<IApiResult<void>> {
    return this.post('/api/proxy/models/load', config);
  }

  /**
   * JIT-style load — minimal body; LM Studio will use its defaults.
   * Triggers in-VRAM load for a model that is currently "on-disk / JIT-loadable".
   */
  async jitLoad(identifier: string): Promise<IApiResult<unknown>> {
    return this.post('/api/proxy/models/load', { identifier });
  }

  /** Unload a model from VRAM by identifier (model ID string). */
  async ejectModel(identifier: string): Promise<IApiResult<void>> {
    return this.post('/api/proxy/models/eject', { identifier });
  }

  /** GET /api/v0/models — list all downloaded + loaded models */
  async listModels(): Promise<IApiResult<{ object: string; data: LMSModelRecord[] }>> {
    return this.get('/api/proxy/models');
  }

  /** GET /api/v0/models/:id — single model detail */
  async getModel(id: string): Promise<IApiResult<LMSModelRecord>> {
    return this.get(`/api/proxy/models/${encodeURIComponent(id)}`);
  }

  /**
   * Ping — cheapest possible liveness check.
   * Uses GET /api/v0/models — native REST API, does NOT spam the LM Studio log.
   */
  async ping(): Promise<IApiResult<void>> {
    return this.get('/api/proxy/models');
  }

  /** GET /api/v0/models (alias kept for compatibility) */
  async loadedModels(): Promise<IApiResult<{ data: LMSModelRecord[] }>> {
    return this.get('/api/proxy/models');
  }

  // --- Inference ---

  /**
   * POST /api/v0/chat/completions — OpenAI-compatible messages format.
   * Returns choices[] + enhanced stats (tokens_per_second, time_to_first_token).
   */
  async chatCompletions(request: ILMSv0ChatRequest): Promise<IApiResult<ILMSv0ChatResponse>> {
    return this.post('/api/proxy/chat/completions', request);
  }

  /**
   * POST /api/v0/completions — Text Completions (prompt → completion).
   * Returns choices[] + enhanced stats.
   */
  async textCompletion(request: ILMSv0CompletionRequest): Promise<IApiResult<ILMSv0CompletionResponse>> {
    return this.post('/api/proxy/completions', request);
  }

  /**
   * POST /api/v0/embeddings — Text Embeddings (text → vector).
   */
  async embeddings(request: ILMSv0EmbeddingRequest): Promise<IApiResult<ILMSv0EmbeddingResponse>> {
    return this.post('/api/proxy/embeddings', request);
  }

  /**
   * POST /api/v1/chat — LM Studio’s MCP-native chat API.
   * Supports integrations[] and returns a structured output[] array
   * (message / reasoning / tool_call items). Different from /api/v0/chat/completions.
   */
  async chat(request: ILMSChatRequest): Promise<IApiResult<ILMSChatResponse>> {
    return this.post('/api/proxy/chat', request);
  }

  // --- Log streaming (spec section 9) ---

  openLogStream(nodeId: string, onLine: (line: string) => void): EventSource {
    const es = new EventSource(`${this.baseUrl}/api/proxy/logs/stream?nodeId=${encodeURIComponent(nodeId)}`);
    es.onmessage = (e) => onLine(e.data as string);
    return es;
  }

  // --- Transport helpers ---

  private async get<T>(path: string): Promise<IApiResult<T>> {
    const start = performance.now();
    try {
      const res = await fetch(`${this.baseUrl}${path}`, { headers: this.authHeaders() });
      const latencyMs = performance.now() - start;
      if (res.ok) return { success: true, data: await res.json() as T, latencyMs };
      return { success: false, latencyMs };
    } catch (err) {
      return { success: false, error: String(err), latencyMs: performance.now() - start };
    }
  }

  private async post<T>(path: string, body?: unknown): Promise<IApiResult<T>> {
    const start = performance.now();
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...this.authHeaders() },
        ...(body !== undefined && { body: JSON.stringify(body) }),
      });
      const latencyMs = performance.now() - start;
      if (res.ok) return { success: true, data: await res.json() as T, latencyMs };
      return { success: false, latencyMs };
    } catch (err) {
      return { success: false, error: String(err), latencyMs: performance.now() - start };
    }
  }

  private authHeaders(): Record<string, string> {
    const token = AuthService.getToken();
    return token ? { Authorization: `Bearer ${token}` } : {};
  }
}
