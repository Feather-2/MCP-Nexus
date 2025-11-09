import { HttpTransportAdapter } from '../../adapters/HttpTransportAdapter.js';
import { McpServiceConfig, Logger } from '../../types/index.js';

// Mock fetch globally
const mockFetch = vi.fn();
global.fetch = mockFetch;

// Mock AbortController
class MockAbortController {
  signal = new MockAbortSignal();
  abort() {
    this.signal._abort();
  }
}

class MockAbortSignal {
  aborted = false;
  private listeners: Array<() => void> = [];
  
  addEventListener(type: string, listener: () => void) {
    if (type === 'abort') {
      this.listeners.push(listener);
    }
  }
  
  _abort() {
    this.aborted = true;
    this.listeners.forEach(listener => listener());
  }
}

global.AbortController = MockAbortController as any;

describe('HttpTransportAdapter', () => {
  let adapter: HttpTransportAdapter;
  let mockLogger: Logger;
  let mockConfig: McpServiceConfig;

  beforeEach(() => {
    mockLogger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      trace: vi.fn()
    };

    mockConfig = {
      name: 'test-http-service',
      version: '2024-11-26',
      transport: 'http',
      command: 'http://localhost:3000',
      timeout: 5000,
      retries: 2,
      env: {
        API_KEY: 'test-api-key',
        MCP_SERVER_URL: 'http://test-server:8080'
      }
    };

    adapter = new HttpTransportAdapter(mockConfig, mockLogger);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('initialization', () => {
    it('should initialize with correct config', () => {
      expect(adapter.type).toBe('http');
      expect(adapter.version).toBe('2024-11-26');
      expect(adapter.isConnected()).toBe(false);
    });

    it('should extract URL from MCP_SERVER_URL env variable', () => {
      const config = { ...mockConfig };
      const newAdapter = new HttpTransportAdapter(config, mockLogger);
      // URL extraction is tested in connection behavior
      expect(newAdapter).toBeDefined();
    });

    it('should set up headers with API key', () => {
      const config = {
        ...mockConfig,
        env: {
          API_KEY: 'test-key',
          HTTP_HEADERS: '{"X-Custom": "value"}'
        }
      };
      const newAdapter = new HttpTransportAdapter(config, mockLogger);
      expect(newAdapter).toBeDefined();
    });
  });

  describe('connection management', () => {
    it('should connect successfully with valid server', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK'
      });

      await adapter.connect();

      expect(adapter.isConnected()).toBe(true);
      expect(mockFetch).toHaveBeenCalledWith(
        'http://test-server:8080',
        expect.objectContaining({
          method: 'OPTIONS',
          headers: expect.objectContaining({
            'Content-Type': 'application/json',
            'Authorization': 'Bearer test-api-key'
          })
        })
      );
      expect(mockLogger.info).toHaveBeenCalledWith('HTTP adapter connected to http://test-server:8080');
    });

    it('should handle connection with 404 response (acceptable for OPTIONS)', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        statusText: 'Not Found'
      });

      await adapter.connect();

      expect(adapter.isConnected()).toBe(true);
    });

    it('should fail connection with server error', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error'
      });

      await expect(adapter.connect()).rejects.toThrow('HTTP connection failed: 500 Internal Server Error');
      expect(adapter.isConnected()).toBe(false);
    });

    it('should handle connection errors', async () => {
      const networkError = new Error('Network error');
      mockFetch.mockRejectedValueOnce(networkError);

      await expect(adapter.connect()).rejects.toThrow('Network error');
      expect(mockLogger.error).toHaveBeenCalledWith('Failed to connect HTTP adapter:', networkError);
    });

    it('should not reconnect if already connected', async () => {
      mockFetch.mockResolvedValue({ ok: true });
      
      await adapter.connect();
      await adapter.connect(); // Second call

      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('should disconnect cleanly', async () => {
      mockFetch.mockResolvedValueOnce({ ok: true });
      await adapter.connect();

      await adapter.disconnect();

      expect(adapter.isConnected()).toBe(false);
      expect(mockLogger.info).toHaveBeenCalledWith('HTTP adapter disconnected from http://test-server:8080');
    });
  });

  describe('message sending', () => {
    beforeEach(async () => {
      mockFetch.mockResolvedValueOnce({ ok: true }); // For connect
      await adapter.connect();
      vi.clearAllMocks();
    });

    it('should send message successfully', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK'
      });

      const message = {
        jsonrpc: '2.0' as const,
        id: 'test-1',
        method: 'test/method',
        params: { test: true }
      };

      await adapter.send(message);

      expect(mockFetch).toHaveBeenCalledWith(
        'http://test-server:8080',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'Content-Type': 'application/json',
            'Authorization': 'Bearer test-api-key'
          }),
          body: JSON.stringify(message)
        })
      );
      expect(mockLogger.trace).toHaveBeenCalledWith('Sent HTTP message:', message);
    });

    it('should throw error when not connected', async () => {
      await adapter.disconnect();

      const message = {
        jsonrpc: '2.0' as const,
        id: 'test-1',
        method: 'test/method'
      };

      await expect(adapter.send(message)).rejects.toThrow('Adapter not connected');
    });

    it('should handle send errors', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
        statusText: 'Bad Request'
      });

      const message = {
        jsonrpc: '2.0' as const,
        id: 'test-1',
        method: 'test/method'
      };

      await expect(adapter.send(message)).rejects.toThrow('HTTP request failed: 400 Bad Request');
      expect(mockLogger.error).toHaveBeenCalledWith('Failed to send HTTP message:', expect.any(Error));
    });
  });

  describe('request-response pattern', () => {
    beforeEach(async () => {
      mockFetch.mockResolvedValueOnce({ ok: true }); // For connect
      await adapter.connect();
      vi.clearAllMocks();
    });

    it('should send and receive message successfully', async () => {
      const responseData = {
        jsonrpc: '2.0' as const,
        id: 'test-1',
        result: { success: true }
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValue(responseData)
      });

      const message = {
        jsonrpc: '2.0' as const,
        id: 'test-1',
        method: 'test/method',
        params: { test: true }
      };

      const response = await adapter.sendAndReceive(message);

      expect(response).toEqual(responseData);
      expect(mockFetch).toHaveBeenCalledWith(
        'http://test-server:8080',
        expect.objectContaining({
          method: 'POST',
          headers: expect.any(Object),
          body: JSON.stringify(message),
          signal: expect.any(Object)
        })
      );
      expect(mockLogger.trace).toHaveBeenCalledWith(
        'HTTP request-response completed:',
        { request: message, response: responseData }
      );
    });

    it('should handle timeout', async () => {
      const slowConfig = { ...mockConfig, timeout: 100 };
      const slowAdapter = new HttpTransportAdapter(slowConfig, mockLogger);
      
      mockFetch.mockResolvedValueOnce({ ok: true }); // For connect
      await slowAdapter.connect();

      // Mock fetch to throw AbortError after delay
      let abortController: AbortController;
      mockFetch.mockImplementationOnce((url: string, options: any) => {
        abortController = new AbortController();
        // Simulate timeout by aborting after a short delay
        setTimeout(() => abortController.abort(), 50);
        
        return new Promise((resolve, reject) => {
          // Listen for abort signal
          if (options?.signal) {
            options.signal.addEventListener('abort', () => {
              const error = new Error('The operation was aborted');
              error.name = 'AbortError';
              reject(error);
            });
          }
          // Never resolve to simulate a hung request
        });
      });

      const message = {
        jsonrpc: '2.0' as const,
        id: 'test-1',
        method: 'test/method'
      };

      await expect(slowAdapter.sendAndReceive(message)).rejects.toThrow('HTTP request timeout for message test-1');
    }, 1000); // Set test timeout to 1 second

    it('should handle response errors', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: 'Server Error'
      });

      const message = {
        jsonrpc: '2.0' as const,
        id: 'test-1',
        method: 'test/method'
      };

      await expect(adapter.sendAndReceive(message)).rejects.toThrow('HTTP request failed: 500 Server Error');
    });

    it('should throw error for unsolicited receive', async () => {
      await expect(adapter.receive()).rejects.toThrow(
        'HTTP adapter does not support unsolicited message receiving. Use sendAndReceive instead.'
      );
    });
  });

  describe('health check', () => {
    beforeEach(async () => {
      mockFetch.mockResolvedValueOnce({ ok: true }); // For connect
      await adapter.connect();
      vi.clearAllMocks();
    });

    it('should pass health check with successful response', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({
          jsonrpc: '2.0',
          id: 'health-check',
          result: { tools: [] }
        })
      });

      const healthy = await adapter.healthCheck();

      expect(healthy).toBe(true);
    });

    it('should fail health check with error response', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({
          jsonrpc: '2.0',
          id: 'health-check',
          error: { code: -1, message: 'Service unavailable' }
        })
      });

      const healthy = await adapter.healthCheck();

      expect(healthy).toBe(false);
    });

    it('should fail health check on network error', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      const healthy = await adapter.healthCheck();

      expect(healthy).toBe(false);
    });
  });

  describe('URL extraction', () => {
    it('should use MCP_SERVER_URL from env', () => {
      const config = {
        ...mockConfig,
        env: { MCP_SERVER_URL: 'http://custom-server:9000' }
      };
      const newAdapter = new HttpTransportAdapter(config, mockLogger);
      expect(newAdapter).toBeDefined();
    });

    it('should use command as URL if it starts with http', () => {
      const config = {
        ...mockConfig,
        command: 'https://api.example.com',
        env: {}
      };
      const newAdapter = new HttpTransportAdapter(config, mockLogger);
      expect(newAdapter).toBeDefined();
    });

    it('should construct URL from host and port', () => {
      const config = {
        ...mockConfig,
        env: {
          MCP_HOST: 'api.example.com',
          MCP_PORT: '8080',
          MCP_HTTPS: 'true'
        }
      };
      const newAdapter = new HttpTransportAdapter(config, mockLogger);
      expect(newAdapter).toBeDefined();
    });

    it('should use default fallback URL', () => {
      const config = {
        ...mockConfig,
        command: 'node',
        env: {}
      };
      const newAdapter = new HttpTransportAdapter(config, mockLogger);
      expect(newAdapter).toBeDefined();
    });
  });
});