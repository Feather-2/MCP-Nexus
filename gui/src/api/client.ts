// API client for MCP Nexus backend

interface ApiResponse<T = any> {
  ok: boolean;
  data?: T;
  error?: string;
}

interface ServiceTemplate {
  name: string;
  description?: string;
  transport: string;
  version: string;
  capabilities?: string[];
  env?: Record<string, string>;
  updatedAt?: string;
}

interface ServiceInstance {
  id: string;
  state: 'initializing' | 'starting' | 'running' | 'stopping' | 'stopped' | 'crashed' | 'error';
  config: {
    name: string;
    transport: string;
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    workingDirectory?: string;
  };
  startedAt?: string;
  startTime?: string;
  pid?: number;
  errorCount: number;
  metadata?: Record<string, any>;
}

interface SandboxStatus {
  nodeReady: boolean;
  pythonReady: boolean;
  goReady: boolean;
  packagesReady: boolean;
  details?: Record<string, any>;
}

interface HealthStatus {
  gateway?: {
    uptime: number;
    status?: string;
    version?: string;
  };
  metrics?: {
    totalRequests: number;
    successRate: number;
    averageResponseTime?: number;
    activeConnections?: number;
  };
  services?: {
    total: number;
    running: number;
    stopped: number;
    error: number;
  };
  apiKeys?: number;
  sandboxInstalled?: boolean;
}

type OrchestratorMode = 'manager-only' | 'auto' | 'wrapper-prefer'

interface OrchestratorStatus {
  enabled: boolean;
  mode: OrchestratorMode;
  subagentsDir?: string;
  reason?: string;
}

interface OrchestratorConfig {
  enabled: boolean;
  mode: OrchestratorMode;
  subagentsDir: string;
  planner?: Record<string, any>;
  vectorStore?: Record<string, any>;
  reranker?: Record<string, any>;
  budget?: Record<string, any>;
  routing?: Record<string, any>;
}

class ApiClient {
  private baseUrl = '';
  private apiKey: string | null = null;
  private bearerToken: string | null = null;

  constructor() {
    try {
      const k = localStorage.getItem('pb_api_key');
      const t = localStorage.getItem('pb_bearer_token');
      if (k) this.apiKey = k;
      if (t) this.bearerToken = t;
    } catch {}
  }

  setAuth(opts: { apiKey?: string | null; bearerToken?: string | null }) {
    if (opts.apiKey !== undefined) {
      this.apiKey = opts.apiKey || null;
      try { opts.apiKey == null ? localStorage.removeItem('pb_api_key') : localStorage.setItem('pb_api_key', String(opts.apiKey)); } catch {}
    }
    if (opts.bearerToken !== undefined) {
      this.bearerToken = opts.bearerToken || null;
      try { opts.bearerToken == null ? localStorage.removeItem('pb_bearer_token') : localStorage.setItem('pb_bearer_token', String(opts.bearerToken)); } catch {}
    }
  }

  getAuth() {
    return { apiKey: this.apiKey, bearerToken: this.bearerToken };
  }

  async request<T = any>(endpoint: string, options: RequestInit = {}): Promise<ApiResponse<T>> {
    const url = `${this.baseUrl}${endpoint}`;

    const defaultOptions: RequestInit = {
      headers: {
        'Content-Type': 'application/json',
        ...options.headers,
      },
    };

    const finalOptions = { ...defaultOptions, ...options };
    // Inject auth headers when not explicitly provided
    const hdrs = (finalOptions.headers || {}) as Record<string, string>;
    if (this.apiKey && !hdrs['x-api-key'] && !hdrs['X-API-Key']) {
      hdrs['X-API-Key'] = this.apiKey;
    }
    if (this.bearerToken && !hdrs['authorization'] && !hdrs['Authorization']) {
      hdrs['Authorization'] = `Bearer ${this.bearerToken}`;
    }
    finalOptions.headers = hdrs;

    try {
      const response = await fetch(url, finalOptions);

      // Non-OK: 尽可能解析结构化错误体，避免出现“no body”误导
      if (!response.ok) {
        const ct = response.headers.get('content-type') || '';
        // 优先尝试 JSON
        if (ct.includes('application/json')) {
          try {
            const j = await response.json();
            // 常见结构：{ success:false, error:{ message, code } } | { error, message }
            const errObj: any = j || {};
            const msg = (errObj?.error?.message) || errObj?.message || (typeof errObj?.error === 'string' ? errObj.error : '') || '';
            const code = errObj?.error?.code || errObj?.code;
            const combined = [code && String(code), msg || response.statusText].filter(Boolean).join(': ');
            return { ok: false, error: combined || `HTTP ${response.status}` };
          } catch {}
        }
        // 再尝试文本
        try {
          const text = await response.text();
          const trimmed = (text || '').trim();
          if (trimmed) return { ok: false, error: trimmed };
        } catch {}
        // 兜底：状态码与状态文本
        return { ok: false, error: `HTTP ${response.status}: ${response.statusText || 'Error'}` };
      }

      // OK: 解析 JSON；若无 body，返回 data:null 避免“no body”观感
      const ct = response.headers.get('content-type') || '';
      if (ct.includes('application/json')) {
        try {
          const data = await response.json();
          return { ok: true, data };
        } catch {
          return { ok: true, data: null as any };
        }
      } else {
        // 非 JSON：尝试文本，失败则返回空
        try {
          const text = await response.text();
          return { ok: true, data: (text ?? '') as any };
        } catch {
          return { ok: true, data: null as any };
        }
      }

    } catch (error) {
      console.error(`API request failed for ${endpoint}:`, error);
      const msg = (error as Error)?.message || 'Network error';
      return { ok: false, error: msg };
    }
  }

  // AI Provider API
  async getAiConfig(): Promise<ApiResponse<{ config: any }>> {
    return this.request<{ config: any }>(`/api/ai/config`);
  }

  async updateAiConfig(cfg: Partial<{ provider: string; model: string; endpoint: string; timeoutMs: number; streaming: boolean }>): Promise<ApiResponse<{ success: boolean; config: any }>> {
    return this.request<{ success: boolean; config: any }>(`/api/ai/config`, {
      method: 'PUT',
      body: JSON.stringify(cfg)
    });
  }

  async testAiConnectivity(payload?: Partial<{ provider: string; model: string; endpoint: string; mode: 'env-only' | 'ping' }>): Promise<ApiResponse<{ success: boolean; provider: string; env: { ok: boolean; required: string[]; missing: string[] }; ping?: { ok: boolean; note?: string } }>> {
    return this.request(`/api/ai/test`, {
      method: 'POST',
      body: JSON.stringify(payload || { mode: 'env-only' })
    });
  }

  async aiChat(messages: Array<{ role: string; content: string }>): Promise<ApiResponse<{ message: { role: string; content: string } }>> {
    return this.request<{ message: { role: string; content: string } }>(`/api/ai/chat`, {
      method: 'POST',
      body: JSON.stringify({ messages })
    })
  }

  createAiChatStream(prompt: string, onDelta: (chunk: string) => void, onDone?: () => void, onError?: (err: Error) => void): EventSource | null {
    try {
      const q = encodeURIComponent(prompt || '')
      const es = new EventSource(`/api/ai/chat/stream?q=${q}`)
      let closed = false
      es.onmessage = (ev) => {
        try {
          const obj = JSON.parse(ev.data)
          if (obj?.event === 'delta' && typeof obj.delta === 'string') onDelta(obj.delta)
          if (obj?.event === 'done' && !closed) { onDone?.(); es.close(); closed = true }
        } catch {}
      }
      es.onerror = () => { if (!closed) onError?.(new Error('stream error')) }
      return es
    } catch (e) {
      onError?.(e as Error)
      return null
    }
  }

  // Marketplace API
  async listMarketplace(): Promise<ApiResponse<{ templates: any[] }>> {
    return this.request<{ templates: any[] }>(`/api/generator/marketplace`);
  }

  async searchMarketplace(q: string): Promise<ApiResponse<{ success: boolean; query: string; results: any[] }>> {
    const query = encodeURIComponent(q || '');
    return this.request<{ success: boolean; query: string; results: any[] }>(`/api/generator/marketplace/search?q=${query}`);
  }

  async installMarketplace(idOrName: string): Promise<ApiResponse<{ success: boolean; name: string }>> {
    const body = { templateId: idOrName };
    return this.request<{ success: boolean; name: string }>(`/api/generator/marketplace/install`, {
      method: 'POST',
      body: JSON.stringify(body)
    });
  }

  // Health check
  async checkHealth(): Promise<ApiResponse> {
    return this.request('/health');
  }

  // Services API
  async getServices(): Promise<ApiResponse<ServiceInstance[]>> {
    return this.request<ServiceInstance[]>('/api/services');
  }

  async getService(serviceId: string): Promise<ApiResponse<{ service: ServiceInstance }>> {
    return this.request<{ service: ServiceInstance }>(`/api/services/${serviceId}`);
  }

  async createService(templateName: string, instanceArgs: Record<string, any> = {}): Promise<ApiResponse> {
    return this.request('/api/services', {
      method: 'POST',
      body: JSON.stringify({ templateName, instanceArgs })
    });
  }

  async deleteService(serviceId: string): Promise<ApiResponse> {
    return this.request(`/api/services/${serviceId}`, {
      method: 'DELETE'
    });
  }

  async updateServiceEnv(serviceId: string, env: Record<string, string>): Promise<ApiResponse<{success: boolean; serviceId: string}>> {
    return this.request<{success: boolean; serviceId: string}>(`/api/services/${serviceId}/env`, {
      method: 'PATCH',
      body: JSON.stringify({ env })
    });
  }

  // Templates API
  async getTemplates(): Promise<ApiResponse<ServiceTemplate[]>> {
    return this.request<ServiceTemplate[]>('/api/templates');
  }

  async addTemplate(template: Omit<ServiceTemplate, 'capabilities'>): Promise<ApiResponse> {
    return this.request('/api/templates', {
      method: 'POST',
      body: JSON.stringify(template)
    });
  }

  async deleteTemplate(templateName: string): Promise<ApiResponse> {
    return this.request(`/api/templates/${templateName}`, {
      method: 'DELETE'
    });
  }

  async updateTemplateEnv(templateName: string, env: Record<string, string>): Promise<ApiResponse<{ success: boolean; name: string }>> {
    return this.request<{ success: boolean; name: string }>(`/api/templates/${encodeURIComponent(templateName)}/env`, {
      method: 'PATCH',
      body: JSON.stringify({ env })
    });
  }

  async diagnoseTemplate(templateName: string): Promise<ApiResponse<{ success: boolean; name: string; required: string[]; provided: string[]; missing: string[]; transport: string }>> {
    return this.request<{ success: boolean; name: string; required: string[]; provided: string[]; missing: string[]; transport: string }>(
      `/api/templates/${encodeURIComponent(templateName)}/diagnose`,
      { method: 'POST' }
    );
  }

  // Authentication API
  async generateToken(userId: string, permissions: string[], expiresInHours: number = 24): Promise<ApiResponse<{token: string}>> {
    return this.request('/api/auth/token', {
      method: 'POST',
      body: JSON.stringify({ userId, permissions, expiresInHours })
    });
  }

  async listApiKeys(): Promise<ApiResponse<any[]>> {
    return this.request('/api/auth/apikeys');
  }

  async createApiKey(name: string, permissions: string[]): Promise<ApiResponse<{apiKey: string}>> {
    return this.request('/api/auth/apikey', {
      method: 'POST',
      body: JSON.stringify({ name, permissions })
    });
  }

  async deleteApiKey(key: string): Promise<ApiResponse> {
    return this.request(`/api/auth/apikey/${key}`, {
      method: 'DELETE'
    });
  }

  async listTokens(): Promise<ApiResponse<any[]>> {
    return this.request('/api/auth/tokens');
  }

  async revokeToken(token: string): Promise<ApiResponse> {
    return this.request(`/api/auth/token/${token}`, {
      method: 'DELETE'
    });
  }

  // Monitoring API
  async getHealthStatus(): Promise<ApiResponse<HealthStatus>> {
    return this.request<HealthStatus>('/api/health-status');
  }

  async getHealthAggregates(): Promise<ApiResponse<{ global: { monitoring: number; healthy: number; unhealthy: number; avgLatency: number; p95?: number; p99?: number; errorRate?: number }; perService: any[] }>> {
    return this.request<{ global: any; perService: any[] }>('/api/metrics/health');
  }

  async getPerServiceMetrics(): Promise<ApiResponse<{ serviceMetrics: Array<{ serviceId: string; serviceName: string; health: any; uptime: number }> }>> {
    return this.request<{ serviceMetrics: Array<{ serviceId: string; serviceName: string; health: any; uptime: number }> }>('/api/metrics/services');
  }

  // Generator V2 helpers
  async exportTemplate(templateName: string, format: 'json' | 'typescript' | 'npm' | 'gist' = 'json'): Promise<ApiResponse<{ success: boolean; downloadUrl?: string; data?: any }>> {
    return this.request(`/api/generator/export`, {
      method: 'POST',
      body: JSON.stringify({ templateName, format })
    })
  }

  async importTemplateFromJson(config: any, options: { autoRegister?: boolean; overwrite?: boolean } = { autoRegister: true, overwrite: true }): Promise<ApiResponse<{ success: boolean }>> {
    return this.request(`/api/generator/import`, {
      method: 'POST',
      body: JSON.stringify({ source: { type: 'json', content: config }, options })
    })
  }

  async getOrchestratorStatus(): Promise<ApiResponse<OrchestratorStatus>> {
    return this.request<OrchestratorStatus>('/api/orchestrator/status');
  }

  async getOrchestratorConfig(): Promise<ApiResponse<{ config: OrchestratorConfig }>> {
    return this.request<{ config: OrchestratorConfig }>('/api/orchestrator/config');
  }

  async updateOrchestratorConfig(updates: Partial<OrchestratorConfig>): Promise<ApiResponse<{ success: boolean; config: OrchestratorConfig }>> {
    return this.request<{ success: boolean; config: OrchestratorConfig }>('/api/orchestrator/config', {
      method: 'PUT',
      body: JSON.stringify(updates)
    });
  }

  // Subagents management
  async listSubagents(): Promise<ApiResponse<{ success: boolean; items: any[] }>> {
    return this.request<{ success: boolean; items: any[] }>(
      '/api/orchestrator/subagents'
    );
  }

  async createSubagent(cfg: { name: string; tools: string[]; actions?: string[]; maxConcurrency?: number; weights?: Record<string, number>; policy?: Record<string, any>; }): Promise<ApiResponse<{ success: boolean; name: string }>> {
    return this.request<{ success: boolean; name: string }>(
      '/api/orchestrator/subagents',
      { method: 'POST', body: JSON.stringify(cfg) }
    );
  }

  async deleteSubagent(name: string): Promise<ApiResponse<{ success: boolean; name: string }>> {
    return this.request<{ success: boolean; name: string }>(
      `/api/orchestrator/subagents/${name}`,
      { method: 'DELETE' }
    );
  }

  async quickCreateGroup(payload: { groupName?: string; source: { type: 'markdown'; content: string }; options?: Record<string, any>; auth?: any; }): Promise<ApiResponse<{ success: boolean; name: string; template: string }>> {
    return this.request<{ success: boolean; name: string; template: string }>(
      '/api/orchestrator/quick-group',
      { method: 'POST', body: JSON.stringify(payload) }
    );
  }

  // Configuration API
  async getConfig(): Promise<ApiResponse<any>> {
    return this.request('/api/config');
  }

  async updateConfig(updates: any): Promise<ApiResponse<any>> {
    return this.request('/api/config', {
      method: 'PUT',
      body: JSON.stringify(updates)
    });
  }

  async getConfigValue(key: string): Promise<ApiResponse<any>> {
    return this.request(`/api/config/${key}`);
  }

  // Real-time logs API
  async getLogs(limit: number = 50): Promise<ApiResponse<any[]>> {
    return this.request(`/api/logs?limit=${limit}`);
  }

  // Get service-specific logs
  async getServiceLogs(serviceId: string, limit: number = 50): Promise<ApiResponse<any[]>> {
    return this.request(`/api/services/${serviceId}/logs?limit=${limit}`);
  }

  // Sandbox API
  async getSandboxStatus(): Promise<ApiResponse<SandboxStatus>> {
    return this.request<SandboxStatus>('/api/sandbox/status');
  }

  async installSandbox(components?: string[]): Promise<ApiResponse<{ success: boolean; result: SandboxStatus }>> {
    return this.request<{ success: boolean; result: SandboxStatus }>('/api/sandbox/install', {
      method: 'POST',
      body: JSON.stringify({ components })
    });
  }

  createSandboxInstallStream(components: string[], onMessage: (msg: any) => void, onError?: (err: Error) => void): EventSource | null {
    // 不自动重连：避免安装流程被多次触发；若后端已有安装在进行，会以“attach”姿态加入
    try {
      const params = encodeURIComponent(components.join(','));
      const url = `${this.baseUrl}/api/sandbox/install/stream?components=${params}`;
      const es = new EventSource(url);
      es.onmessage = (ev) => { try { const obj = JSON.parse(ev.data); onMessage(obj); } catch {} };
      es.onerror = () => { try { es.close(); } catch {}; onError?.(new Error('sandbox stream error')); };
      return es;
    } catch (e) {
      onError?.(e as Error);
      return null;
    }
  }

  async repairSandbox(components?: string[]): Promise<ApiResponse<{ success: boolean; result: any }>> {
    return this.request<{ success: boolean; result: any }>(`/api/sandbox/repair`, {
      method: 'POST',
      body: JSON.stringify({ components })
    });
  }

  async cleanupSandbox(): Promise<ApiResponse<{ success: boolean; result: any }>> {
    return this.request<{ success: boolean; result: any }>(`/api/sandbox/cleanup`, { method: 'POST' });
  }

  async repairTemplates(): Promise<ApiResponse<{ success: boolean }>> {
    return this.request<{ success: boolean }>('/api/templates/repair', { method: 'POST' });
  }

  async repairTemplateImages(): Promise<ApiResponse<{ success: boolean; fixed?: number; updated?: string[] }>> {
    return this.request<{ success: boolean; fixed?: number; updated?: string[] }>(
      '/api/templates/repair-images',
      { method: 'POST' }
    );
  }

  // External MCP config import
  async previewExternalConfigs(): Promise<ApiResponse<any[]>> {
    return this.request<any[]>('/api/config/import/preview');
  }

  async applyExternalConfigs(): Promise<ApiResponse<{ success: boolean; applied: number }>> {
    return this.request<{ success: boolean; applied: number }>('/api/config/import/apply', { method: 'POST' });
  }

  // Create a Server-Sent Events connection for real-time logs
  createLogStream(onMessage: (log: any) => void, onError?: (error: Error) => void): EventSource | null {
    try {
      const url = `${this.baseUrl}/api/logs/stream`;
      let attempts = 0;
      let es: EventSource | null = null;
      const maxDelay = 10000;
      const connect = () => {
        es = new EventSource(url);
        es.onmessage = (event) => {
          try { const log = JSON.parse(event.data); onMessage(log); } catch (error) { console.error('Failed to parse log message:', error); }
        };
        es.onerror = (event) => {
          attempts += 1;
          const delay = Math.min(1000 * Math.pow(2, attempts), maxDelay);
          console.error('Log stream error:', event);
          onError?.(new Error('Log stream connection failed'));
          try { es && es.close(); } catch {}
          setTimeout(connect, delay);
        };
      };
      connect();
      return es;
    } catch (error) {
      console.error('Failed to create log stream:', error);
      onError?.(error as Error);
      return null;
    }
  }

  // MCP Proxy API
  async proxyMcp(serviceId: string, message: any): Promise<ApiResponse<any>> {
    return this.request(`/api/proxy/${serviceId}`, {
      method: 'POST',
      body: JSON.stringify(message)
    });
  }

  // Convenience helpers
  buildInitializeMessage(protocolVersion: string = '2024-11-26', capabilities: Record<string, any> = {}) {
    return {
      jsonrpc: '2.0',
      id: `init-${Date.now()}`,
      method: 'initialize',
      params: {
        protocolVersion,
        capabilities,
        clientInfo: { name: 'MCP-Nexus-ui', version: '1.0.0' }
      }
    };
  }

  buildSimpleMethod(method: string, params: any = {}) {
    return {
      jsonrpc: '2.0',
      id: `req-${Date.now()}`,
      method,
      params
    };
  }
}

export const apiClient = new ApiClient();
export type { ServiceTemplate, ServiceInstance, HealthStatus, OrchestratorStatus, OrchestratorConfig, OrchestratorMode, ApiResponse };
