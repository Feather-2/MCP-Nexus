// API client for MCP Gateway backend

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

  async request<T = any>(endpoint: string, options: RequestInit = {}): Promise<ApiResponse<T>> {
    const url = `${this.baseUrl}${endpoint}`;

    const defaultOptions: RequestInit = {
      headers: {
        'Content-Type': 'application/json',
        ...options.headers,
      },
    };

    const finalOptions = { ...defaultOptions, ...options };

    try {
      const response = await fetch(url, finalOptions);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = await response.json();
      return { ok: true, data };

    } catch (error) {
      console.error(`API request failed for ${endpoint}:`, error);
      return { ok: false, error: (error as Error).message };
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
    try {
      const params = encodeURIComponent(components.join(','));
      const es = new EventSource(`${this.baseUrl}/api/sandbox/install/stream?components=${params}`);
      es.onmessage = (ev) => {
        try { const obj = JSON.parse(ev.data); onMessage(obj); } catch (e) {}
      };
      es.onerror = () => { onError?.(new Error('sandbox stream error')); };
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
      const eventSource = new EventSource(`${this.baseUrl}/api/logs/stream`);

      eventSource.onmessage = (event) => {
        try {
          const log = JSON.parse(event.data);
          onMessage(log);
        } catch (error) {
          console.error('Failed to parse log message:', error);
        }
      };

      eventSource.onerror = (event) => {
        console.error('Log stream error:', event);
        if (onError) {
          onError(new Error('Log stream connection failed'));
        }
      };

      return eventSource;
    } catch (error) {
      console.error('Failed to create log stream:', error);
      if (onError) {
        onError(error as Error);
      }
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
        clientInfo: { name: 'pb-mcpgateway-ui', version: '1.0.0' }
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
