/**
 * ToolchainView — Module 4: The Toolchain (MCP & External Hooks)
 *
 * Spec reference: docs/LMStudioDaemon.md section 8
 * PRD reference:  docs/LMS Admin-PRD.txt Module 4
 *
 * Live MCP integration panel: ephemeral servers, mcp.json servers,
 * model-aware chat dispatch, structured output rendering, audit log.
 */

import { EventBus }        from '@/core/EventBus';
import { renderStatusBadge } from '@/views/components/StatusBadge';
import { AuthService }     from '@/services/AuthService';
import type { LMSModelRecord } from '@/services/DaemonService';
import type { ILMSChatResponse, ILMSOutputItem } from '@/types';

type IntegrationType = 'ephemeral' | 'plugin';

interface IAuditEntry {
  ts:       Date;
  tool:     string;
  serverId: string;
  args:     Record<string, unknown>;
  output:   string;
}

export class ToolchainView {
  private models:    LMSModelRecord[] = [];
  private modelsErr: string | null    = null;

  private intType: IntegrationType = 'ephemeral';
  private firing  = false;
  private lastResponse: ILMSChatResponse | null = null;
  private responseErr: string | null            = null;
  private auditLog: IAuditEntry[] = [];

  constructor(private readonly root: HTMLElement) {}

  mount(): void {
    this.render();
    void this.fetchModels();
    this.bindEvents();
  }

  unmount(): void { /* no persistent resources */ }

  // ---------------------------------------------------------------------------
  // Data fetching
  // ---------------------------------------------------------------------------

  private async fetchModels(): Promise<void> {
    try {
      const res = await AuthService.apiFetch('/api/proxy/models');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json() as { data?: LMSModelRecord[] };
      this.models  = (json.data ?? []).filter(m => m.type === 'llm');
      this.modelsErr = null;
    } catch (err) {
      this.modelsErr = String(err);
    }
    this.render();
    this.bindEvents();
  }

  // ---------------------------------------------------------------------------
  // Chat dispatch
  // ---------------------------------------------------------------------------

  private async fireRequest(): Promise<void> {
    const modelId  = (document.getElementById('tc-model')  as HTMLSelectElement | null)?.value ?? '';
    const prompt   = (document.getElementById('tc-prompt') as HTMLTextAreaElement | null)?.value?.trim() ?? '';
    const ctxLen   = parseInt((document.getElementById('tc-ctx') as HTMLInputElement | null)?.value ?? '4096', 10);

    if (!modelId || !prompt) return;

    // Parse custom headers JSON — silently ignore malformed input
    let customHeaders: Record<string, string> | undefined;
    const headersRaw = (document.getElementById('tc-headers') as HTMLTextAreaElement | null)?.value.trim() ?? '';
    if (headersRaw) {
      try {
        customHeaders = JSON.parse(headersRaw) as Record<string, string>;
      } catch {
        // invalid JSON — leave undefined, user sees nothing changed
      }
    }

    const allowedTools = ((document.getElementById('tc-tools') as HTMLInputElement | null)?.value ?? '')
      .split(',').map(t => t.trim()).filter(Boolean);

    const integration =
      this.intType === 'ephemeral'
        ? {
            type:          'ephemeral_mcp' as const,
            server_label:  (document.getElementById('tc-label') as HTMLInputElement | null)?.value.trim() || 'ephemeral',
            server_url:    (document.getElementById('tc-url')   as HTMLInputElement | null)?.value.trim() || '',
            ...(allowedTools.length > 0 && { allowed_tools: allowedTools }),
            ...(customHeaders            && { headers: customHeaders }),
          }
        : (document.getElementById('tc-plugin-id') as HTMLInputElement | null)?.value.trim() ?? 'mcp/filesystem';

    const body = {
      model:          modelId,
      input:          prompt,
      integrations:   [integration],
      context_length: ctxLen,
    };

    this.firing      = true;
    this.lastResponse = null;
    this.responseErr  = null;
    this.render();
    this.bindEvents();

    try {
      const res = await AuthService.apiFetch('/api/proxy/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
      const data = await res.json() as ILMSChatResponse;
      this.lastResponse = data;

      // Harvest tool_calls into audit log and emit events
      for (const item of data.output) {
        if (item.type === 'tool_call' && item.tool) {
          const entry: IAuditEntry = {
            ts:       new Date(),
            tool:     item.tool,
            serverId: item.provider_info?.server_label ?? item.provider_info?.plugin_id ?? 'unknown',
            args:     item.arguments ?? {},
            output:   typeof item.output === 'string' ? item.output : JSON.stringify(item.output),
          };
          this.auditLog.unshift(entry);
          EventBus.emit({
            type: 'MCP_TOOL_CALLED',
            payload: { tool: entry.tool, serverId: entry.serverId, args: entry.args, output: entry.output, timestamp: entry.ts },
          });
        }
      }
    } catch (err) {
      this.responseErr = String(err);
    }

    this.firing = false;
    this.render();
    this.bindEvents();
  }

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------

  private render(): void {
    this.root.innerHTML = `
      <div class="space-y-6 max-w-5xl">

        <div>
          <h2 class="text-lg font-bold text-white tracking-tight">The Toolchain</h2>
          <p class="text-xs text-slate-500 mt-0.5">MCP server integration · live dispatch · tool-call audit</p>
        </div>

        <!-- Security warning -->
        <div class="flex gap-3 bg-orange-500/10 border border-orange-500/20 rounded-xl p-4">
          <span class="text-orange-400 text-lg flex-shrink-0">⚠</span>
          <div>
            <p class="text-xs font-semibold text-orange-300">MCP Security Notice</p>
            <p class="text-[11px] text-orange-400/70 mt-0.5">
              MCP servers can run arbitrary code and access the filesystem.
              Network MCP servers send your prompt to a third-party URL.
              Ephemeral MCPs require "Allow per-request MCPs" to be enabled in LM Studio.
            </p>
          </div>
        </div>

        <!-- MCP Dispatch Panel -->
        <section class="bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-4">
          <div class="flex items-center justify-between">
            <h3 class="text-sm font-bold text-slate-200">MCP Dispatch</h3>
            <div class="flex rounded-lg overflow-hidden border border-slate-700 text-[11px] font-semibold">
              <button id="tc-tab-ephemeral"
                class="px-3 py-1.5 transition-all
                       ${this.intType === 'ephemeral' ? 'bg-indigo-600 text-white' : 'bg-slate-800 text-slate-400 hover:bg-slate-700'}">
                Ephemeral
              </button>
              <button id="tc-tab-plugin"
                class="px-3 py-1.5 transition-all
                       ${this.intType === 'plugin' ? 'bg-indigo-600 text-white' : 'bg-slate-800 text-slate-400 hover:bg-slate-700'}">
                mcp.json
              </button>
            </div>
          </div>

          <!-- Model selector -->
          <div>
            <label class="block text-[11px] text-slate-500 font-semibold uppercase tracking-wider mb-1">
              Model
            </label>
            ${this.modelsErr
              ? `<p class="text-red-400 text-xs font-mono">⚠ ${this.modelsErr}</p>`
              : `<select id="tc-model"
                   class="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2
                          text-slate-200 text-xs font-mono focus:outline-none focus:border-indigo-500">
                   ${this.models.length === 0
                     ? '<option value="">— no models loaded in LM Studio —</option>'
                     : this.models.map(m =>
                         `<option value="${this.esc(m.id)}">${this.esc(m.id)}</option>`
                       ).join('')
                   }
                 </select>`
            }
          </div>

          <!-- Integration config -->
          ${this.intType === 'ephemeral' ? this.renderEphemeralFields() : this.renderPluginFields()}

          <!-- Prompt -->
          <div>
            <label class="block text-[11px] text-slate-500 font-semibold uppercase tracking-wider mb-1">
              Prompt
            </label>
            <textarea id="tc-prompt" rows="3"
              placeholder="What is the top trending model on Hugging Face?"
              class="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2
                     text-slate-200 text-xs font-mono resize-none focus:outline-none focus:border-indigo-500
                     placeholder:text-slate-600"></textarea>
          </div>

          <!-- Context length + Fire -->
          <div class="flex items-center gap-3">
            <div class="flex items-center gap-2 flex-shrink-0">
              <label class="text-[11px] text-slate-500 font-semibold uppercase tracking-wider">ctx</label>
              <input id="tc-ctx" type="number" value="4096" min="512" max="131072" step="512"
                class="w-24 bg-slate-800 border border-slate-700 rounded-lg px-2 py-1.5
                       text-slate-200 text-xs font-mono text-center focus:outline-none focus:border-indigo-500" />
            </div>
            <button id="tc-fire"
              class="ml-auto px-5 py-2 rounded-lg font-semibold text-xs transition-all
                     ${this.firing
                       ? 'bg-slate-700 text-slate-500 cursor-not-allowed'
                       : 'bg-indigo-600 hover:bg-indigo-500 text-white cursor-pointer'}"
              ${this.firing ? 'disabled' : ''}>
              ${this.firing ? '⏳ Waiting…' : '▶ Fire Request'}
            </button>
          </div>
        </section>

        <!-- Response output -->
        ${this.renderResponse()}

        <!-- Tool-call audit log -->
        <section class="bg-slate-900 border border-slate-800 rounded-xl p-5">
          <h3 class="text-sm font-bold text-slate-200 mb-3">Tool-Call Audit Log</h3>
          <div class="bg-[#0d0f14] border border-slate-800 rounded-lg p-4 font-mono text-xs h-40 overflow-y-auto space-y-1.5">
            ${this.auditLog.length === 0
              ? '<p class="text-slate-700">[No tool calls recorded this session]</p>'
              : this.auditLog.map(e => `
                  <div class="flex gap-2">
                    <span class="text-slate-600 flex-shrink-0">${e.ts.toTimeString().slice(0, 8)}</span>
                    <span class="text-emerald-400">${this.esc(e.tool)}</span>
                    <span class="text-slate-500">via</span>
                    <span class="text-indigo-400">${this.esc(e.serverId)}</span>
                  </div>`).join('')
            }
          </div>
        </section>

      </div>
    `;
  }

  private renderEphemeralFields(): string {
    return `
      <div class="grid grid-cols-2 gap-3">
        <div>
          <label class="block text-[11px] text-slate-500 font-semibold uppercase tracking-wider mb-1">
            Server URL
          </label>
          <input id="tc-url" type="text" value="https://huggingface.co/mcp"
            placeholder="https://example.com/mcp"
            class="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2
                   text-slate-200 text-xs font-mono focus:outline-none focus:border-indigo-500
                   placeholder:text-slate-600" />
        </div>
        <div>
          <label class="block text-[11px] text-slate-500 font-semibold uppercase tracking-wider mb-1">
            Server Label
          </label>
          <input id="tc-label" type="text" value="huggingface"
            placeholder="my-server"
            class="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2
                   text-slate-200 text-xs font-mono focus:outline-none focus:border-indigo-500
                   placeholder:text-slate-600" />
        </div>
      </div>
      <div class="grid grid-cols-2 gap-3">
        <div>
          <label class="block text-[11px] text-slate-500 font-semibold uppercase tracking-wider mb-1">
            Allowed Tools <span class="text-slate-700 normal-case font-normal">(comma-separated, blank = all)</span>
          </label>
          <input id="tc-tools" type="text" placeholder="model_search, dataset_search"
            class="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2
                   text-slate-200 text-xs font-mono focus:outline-none focus:border-indigo-500
                   placeholder:text-slate-600" />
        </div>
        <div>
          <label class="block text-[11px] text-slate-500 font-semibold uppercase tracking-wider mb-1">
            Custom Headers <span class="text-slate-700 normal-case font-normal">(JSON, optional)</span>
          </label>
          <textarea id="tc-headers" rows="1"
            placeholder='{"Authorization": "Bearer <token>"}'
            class="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2
                   text-slate-200 text-xs font-mono resize-none focus:outline-none focus:border-indigo-500
                   placeholder:text-slate-600"></textarea>
          <p class="text-[10px] text-slate-600 mt-0.5">
            Required when the MCP server needs authentication. Value forwarded as-is to the server.
          </p>
        </div>
      </div>
    `;
  }

  private renderPluginFields(): string {
    return `
      <div>
        <label class="block text-[11px] text-slate-500 font-semibold uppercase tracking-wider mb-1">
          Plugin ID <span class="text-slate-700 normal-case font-normal">(from mcp.json)</span>
        </label>
        <input id="tc-plugin-id" type="text" value="mcp/playwright"
          placeholder="mcp/playwright"
          class="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2
                 text-slate-200 text-xs font-mono focus:outline-none focus:border-indigo-500
                 placeholder:text-slate-600" />
        <p class="text-[10px] text-slate-600 mt-1">
          Requires "Allow calling servers from mcp.json" to be enabled in LM Studio → Developer settings.
        </p>
      </div>
    `;
  }

  private renderResponse(): string {
    if (!this.lastResponse && !this.responseErr) return '';

    if (this.responseErr) {
      return `
        <section class="bg-red-500/10 border border-red-500/20 rounded-xl p-5">
          <h3 class="text-sm font-bold text-red-400 mb-2">Request Failed</h3>
          <p class="text-xs font-mono text-red-300">${this.esc(this.responseErr)}</p>
        </section>`;
    }

    const r = this.lastResponse!;
    const toolCalls = r.output.filter(o => o.type === 'tool_call');
    const messages  = r.output.filter(o => o.type === 'message');
    const reasoning = r.output.filter(o => o.type === 'reasoning');

    return `
      <section class="bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-4">
        <div class="flex items-center justify-between">
          <h3 class="text-sm font-bold text-slate-200">Response</h3>
          <div class="flex gap-3 text-[10px] text-slate-500 font-mono">
            <span>${r.stats.input_tokens} in</span>
            <span>${r.stats.total_output_tokens} out</span>
            <span>${r.stats.tokens_per_second.toFixed(1)} t/s</span>
            <span>${(r.stats.time_to_first_token_seconds * 1000).toFixed(0)}ms ttft</span>
          </div>
        </div>

        ${toolCalls.length > 0 ? `
          <div class="space-y-2">
            <p class="text-[11px] font-bold uppercase tracking-wider text-emerald-500">
              Tool Calls (${toolCalls.length})
            </p>
            ${toolCalls.map(tc => this.renderToolCall(tc)).join('')}
          </div>` : ''}

        ${reasoning.length > 0 ? `
          <div>
            <p class="text-[11px] font-bold uppercase tracking-wider text-slate-500 mb-2">Reasoning</p>
            <div class="bg-[#0d0f14] border border-slate-800 rounded-lg p-3 text-[11px]
                        text-slate-500 font-mono whitespace-pre-wrap max-h-40 overflow-y-auto">
              ${this.esc(reasoning.map(r => r.content ?? '').join('\n'))}
            </div>
          </div>` : ''}

        ${messages.length > 0 ? `
          <div>
            <p class="text-[11px] font-bold uppercase tracking-wider text-slate-500 mb-2">Message</p>
            <div class="bg-[#0d0f14] border border-slate-800 rounded-lg p-3 text-xs
                        text-slate-200 whitespace-pre-wrap">
              ${this.esc(messages.map(m => m.content ?? '').join('\n'))}
            </div>
          </div>` : ''}
      </section>`;
  }

  private renderToolCall(tc: ILMSOutputItem): string {
    const server = tc.provider_info?.server_label ?? tc.provider_info?.plugin_id ?? '—';
    const args   = JSON.stringify(tc.arguments ?? {}, null, 2);
    const out    = typeof tc.output === 'string' ? tc.output : JSON.stringify(tc.output);
    return `
      <div class="bg-emerald-500/5 border border-emerald-500/20 rounded-lg p-3 space-y-2">
        <div class="flex items-center gap-2 text-xs">
          <span class="text-emerald-400 font-bold font-mono">${this.esc(tc.tool ?? '?')}</span>
          ${renderStatusBadge(server, 'active')}
        </div>
        <div class="grid grid-cols-2 gap-2">
          <div>
            <p class="text-[10px] text-slate-600 font-semibold uppercase tracking-wider mb-1">Arguments</p>
            <pre class="text-[10px] font-mono text-slate-400 bg-[#0d0f14] rounded p-2 overflow-x-auto max-h-24">${this.esc(args)}</pre>
          </div>
          <div>
            <p class="text-[10px] text-slate-600 font-semibold uppercase tracking-wider mb-1">Output</p>
            <pre class="text-[10px] font-mono text-slate-400 bg-[#0d0f14] rounded p-2 overflow-x-auto max-h-24">${this.esc(out.slice(0, 500))}${out.length > 500 ? '…' : ''}</pre>
          </div>
        </div>
      </div>`;
  }

  // ---------------------------------------------------------------------------
  // Event binding (re-bind after each render)
  // ---------------------------------------------------------------------------

  private bindEvents(): void {
    document.getElementById('tc-tab-ephemeral')?.addEventListener('click', () => {
      this.intType = 'ephemeral';
      this.render();
      this.bindEvents();
    });
    document.getElementById('tc-tab-plugin')?.addEventListener('click', () => {
      this.intType = 'plugin';
      this.render();
      this.bindEvents();
    });
    document.getElementById('tc-fire')?.addEventListener('click', () => {
      if (!this.firing) void this.fireRequest();
    });
  }

  private esc(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
}
