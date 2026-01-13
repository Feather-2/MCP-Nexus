import { StreamableHttpAdapter } from '../../adapters/StreamableHttpAdapter.js';
import { McpServiceConfig, Logger } from '../../types/index.js';

// Mock EventSource
class MockEventSource {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 2;

  readyState = MockEventSource.CONNECTING;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  
  private listeners: Record<string, ((event: Event | MessageEvent) => void)[]> = {};
  private autoOpenTimeout?: ReturnType<typeof setTimeout>;

  constructor(public url: string, public options?: EventSourceInit) {
    // Simulate connection after a short delay (longer delay to allow addEventListener setup)
    this.autoOpenTimeout = setTimeout(() => {
      this.readyState = MockEventSource.OPEN;
      if (this.onopen) {
        this.onopen(new Event('open'));
      }
      // Also dispatch to addEventListener listeners
      this.dispatchEvent('open', new Event('open'));
    }, 50); // Increased from 10ms to 50ms
  }

  addEventListener(type: string, listener: (event: Event | MessageEvent) => void) {
    if (!this.listeners[type]) {
      this.listeners[type] = [];
    }
    this.listeners[type].push(listener);
  }

  removeEventListener(type: string, listener: (event: Event | MessageEvent) => void) {
    if (this.listeners[type]) {
      const index = this.listeners[type].indexOf(listener);
      if (index !== -1) {
        this.listeners[type].splice(index, 1);
      }
    }
  }

  close() {
    this.readyState = MockEventSource.CLOSED;
    if (this.autoOpenTimeout) {
      clearTimeout(this.autoOpenTimeout);
    }
  }

  // Helper method to dispatch events to listeners
  private dispatchEvent(type: string, event: Event | MessageEvent) {
    if (this.listeners[type]) {
      this.listeners[type].forEach(listener => {
        listener(event);
      });
    }
  }

  // Helper for testing - prevent auto-open
  cancelAutoOpen() {
    if (this.autoOpenTimeout) {
      clearTimeout(this.autoOpenTimeout);
      this.autoOpenTimeout = undefined;
    }
  }

  // Helper for testing
  simulateMessage(data: string) {
    if (this.onmessage) {
      this.onmessage(new MessageEvent('message', { data }));
    }
    // Also dispatch to addEventListener listeners
    this.dispatchEvent('message', new MessageEvent('message', { data }));
  }

  simulateError(_error?: string) {
    const errorEvent = new Event('error');
    if (this.onerror) {
      this.onerror(errorEvent);
    }
    // Also dispatch to addEventListener listeners
    this.dispatchEvent('error', errorEvent);
  }

  simulateCustomEvent(type: string, data: string) {
    if (this.listeners[type]) {
      this.listeners[type].forEach(listener => {
        listener(new MessageEvent(type, { data }));
      });
    }
  }
}

// Mock EventSource and fetch globally using vitest
const MockEventSourceConstructor: any = vi.fn().mockImplementation((url, options) => new MockEventSource(url, options));
MockEventSourceConstructor.CONNECTING = 0;
MockEventSourceConstructor.OPEN = 1;
MockEventSourceConstructor.CLOSED = 2;

vi.stubGlobal('EventSource', MockEventSourceConstructor);
vi.stubGlobal('fetch', vi.fn());

describe('StreamableHttpAdapter', () => {
  let adapter: StreamableHttpAdapter;
  let mockLogger: Logger;
  let mockConfig: McpServiceConfig;
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockLogger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      trace: vi.fn()
    };

    mockConfig = {
      name: 'test-streamable-service',
      version: '2024-11-26',
      transport: 'streamable-http',
      command: 'http://localhost:3000',
      timeout: 5000,
      retries: 2,
      env: {
        API_KEY: 'test-api-key',
        MCP_SERVER_URL: 'http://test-server:8080'
      }
    };

    // Set up default EventSource mock
    MockEventSourceConstructor.mockImplementation((url: any, options: any) => new MockEventSource(url, options));
    
    // Set up default fetch mock
    mockFetch = vi.mocked(global.fetch) as any;
    mockFetch.mockResolvedValue(new Response('{"result": "success"}', {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    }));

    adapter = new StreamableHttpAdapter(mockConfig, mockLogger);
  });

  afterEach(async () => {
    if (adapter.isConnected()) {
      await adapter.disconnect();
    }
    vi.clearAllMocks();
  });

  describe('initialization', () => {
    it('should initialize with correct config', () => {
      expect(adapter.type).toBe('streamable-http');
      expect(adapter.version).toBe('2024-11-26');
      expect(adapter.isConnected()).toBe(false);
    });

    it('should set up headers with API key and streaming headers', () => {
      const config = {
        ...mockConfig,
        env: {
          API_KEY: 'test-key',
          HTTP_HEADERS: '{"X-Custom": "value"}'
        }
      };
      const newAdapter = new StreamableHttpAdapter(config, mockLogger);
      expect(newAdapter).toBeDefined();
    });
  });

  describe('connection management', () => {
    it('should connect successfully and establish EventSource', async () => {
      await adapter.connect();

      expect(adapter.isConnected()).toBe(true);
      expect(mockLogger.info).toHaveBeenCalledWith('StreamableHttp adapter connected to http://test-server:8080');
    });

    it('should handle connection timeout', async () => {
      // Mock EventSource that doesn't fire open event
      MockEventSourceConstructor.mockImplementation(() => {
        const mockES = new MockEventSource('test-url');
        // Prevent the auto-open event to trigger timeout
        mockES.cancelAutoOpen(); 
        return mockES as any;
      });

      await expect(adapter.connect()).rejects.toThrow('StreamableHttp connection timeout');
    }, 15000); // Increase timeout for this test

    it('should handle EventSource errors during connection', async () => {
      // Create a special adapter with longer timeout for this test
      const errorTestConfig = { ...mockConfig, timeout: 5000 };
      const errorTestAdapter = new StreamableHttpAdapter(errorTestConfig, mockLogger);
      
      let connectionErrorHandler: (error: Event) => void;
      
      // Mock EventSource that fires error event quickly
      MockEventSourceConstructor.mockImplementation((url: any, options: any) => {
        const mockES = new MockEventSource(url, options);
        // Prevent auto-open so error happens first
        mockES.cancelAutoOpen();
        
        // Override addEventListener to capture the error handler
        const originalAddEventListener = mockES.addEventListener;
        mockES.addEventListener = vi.fn((type: string, handler: any) => {
          if (type === 'error') {
            connectionErrorHandler = handler;
          }
          return originalAddEventListener.call(mockES, type, handler);
        });
        
        // Simulate error very quickly and trigger the connection error handler
        setTimeout(() => {
          const errorEvent = new Event('error');
          if (connectionErrorHandler) {
            connectionErrorHandler(errorEvent);
          }
        }, 10);
        
        return mockES as any;
      });

      await expect(errorTestAdapter.connect()).rejects.toThrow(/StreamableHttp connection failed/);
    }, 15000);

    it('should not reconnect if already connected', async () => {
      await adapter.connect();
      const firstConnection = adapter.isConnected();
      
      await adapter.connect(); // Second call

      expect(firstConnection).toBe(true);
      expect(adapter.isConnected()).toBe(true);
    });

    it('should disconnect cleanly', async () => {
      await adapter.connect();

      await adapter.disconnect();

      expect(adapter.isConnected()).toBe(false);
      expect(mockLogger.info).toHaveBeenCalledWith('StreamableHttp adapter disconnected from http://test-server:8080');
    });

    it('should handle disconnect when not connected', async () => {
      await adapter.disconnect(); // Should not throw
      expect(adapter.isConnected()).toBe(false);
    });
  });

  describe('message handling', () => {
    let mockEventSource: MockEventSource;

    beforeEach(async () => {
      await adapter.connect();
      // Get reference to the created EventSource
      mockEventSource = (adapter as any).eventSource;
    });

    it('should handle incoming SSE messages', async () => {
      const testMessage = {
        jsonrpc: '2.0' as const,
        method: 'test/notification',
        params: { data: 'test' }
      };

      mockEventSource.simulateMessage(JSON.stringify(testMessage));

      const receivedMessage = await adapter.receive();
      expect(receivedMessage).toEqual(testMessage);
      expect(mockLogger.trace).toHaveBeenCalledWith('Received message via StreamableHttp:', testMessage);
    });

    it('should handle custom SSE event types', async () => {
      const testMessage = {
        jsonrpc: '2.0' as const,
        id: 'custom-1',
        result: { success: true }
      };

      mockEventSource.simulateCustomEvent('mcp-message', JSON.stringify(testMessage));

      const receivedMessage = await adapter.receive();
      expect(receivedMessage).toEqual(testMessage);
    });

    it('should handle malformed SSE messages gracefully', async () => {
      mockEventSource.simulateMessage('invalid json');

      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Failed to parse SSE message:',
        expect.objectContaining({
          data: 'invalid json',
          error: expect.any(Error)
        })
      );
    });

    it('should queue multiple messages', async () => {
      const message1 = { jsonrpc: '2.0' as const, method: 'test1' };
      const message2 = { jsonrpc: '2.0' as const, method: 'test2' };

      mockEventSource.simulateMessage(JSON.stringify(message1));
      mockEventSource.simulateMessage(JSON.stringify(message2));

      const received1 = await adapter.receive();
      const received2 = await adapter.receive();

      expect(received1).toEqual(message1);
      expect(received2).toEqual(message2);
    });

    it('should handle receive timeout', async () => {
      const shortTimeoutConfig = { ...mockConfig, timeout: 100 };
      const shortTimeoutAdapter = new StreamableHttpAdapter(shortTimeoutConfig, mockLogger);
      await shortTimeoutAdapter.connect();

      await expect(shortTimeoutAdapter.receive()).rejects.toThrow('Receive timeout');
      await shortTimeoutAdapter.disconnect();
    });
  });

  describe('message sending', () => {
    beforeEach(async () => {
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
            'Accept': 'text/event-stream',
            'Authorization': 'Bearer test-api-key'
          }),
          body: JSON.stringify(message)
        })
      );
      expect(mockLogger.trace).toHaveBeenCalledWith('Sent StreamableHttp message:', message);
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

      await expect(adapter.send(message)).rejects.toThrow('StreamableHttp request failed: 400 Bad Request');
      expect(mockLogger.error).toHaveBeenCalledWith('Failed to send StreamableHttp message:', expect.any(Error));
    });
  });

  describe('request-response pattern', () => {
    let mockEventSource: MockEventSource;

    beforeEach(async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        statusText: 'OK'
      });

      await adapter.connect();
      mockEventSource = (adapter as any).eventSource;
      vi.clearAllMocks();
    });

    it('should send and receive response with matching ID', async () => {
      const message = {
        jsonrpc: '2.0' as const,
        id: 'test-123',
        method: 'test/method',
        params: { test: true }
      };

      const responsePromise = adapter.sendAndReceive(message);

      // Simulate response after a short delay
      setTimeout(() => {
        const response = {
          jsonrpc: '2.0' as const,
          id: 'test-123',
          result: { success: true }
        };
        mockEventSource.simulateMessage(JSON.stringify(response));
      }, 10);

      const response = await responsePromise;

      expect(response).toEqual({
        jsonrpc: '2.0',
        id: 'test-123',
        result: { success: true }
      });
    });

    it('should generate ID if not provided', async () => {
      const message: any = {
        jsonrpc: '2.0' as const,
        method: 'test/method',
        params: { test: true }
      };

      const responsePromise = adapter.sendAndReceive(message);

      // Check that ID was generated
      expect(message.id).toMatch(/^req-\d+-[a-z0-9]+$/);

      // Simulate response with generated ID
      setTimeout(() => {
        const response = {
          jsonrpc: '2.0' as const,
          id: message.id!,
          result: { success: true }
        };
        mockEventSource.simulateMessage(JSON.stringify(response));
      }, 10);

      await responsePromise;
    });

    it('should handle request timeout', async () => {
      const shortTimeoutConfig = { ...mockConfig, timeout: 50 };
      const shortTimeoutAdapter = new StreamableHttpAdapter(shortTimeoutConfig, mockLogger);
      await shortTimeoutAdapter.connect();

      const message = {
        jsonrpc: '2.0' as const,
        id: 'timeout-test',
        method: 'test/method'
      };

      await expect(shortTimeoutAdapter.sendAndReceive(message)).rejects.toThrow('Request timeout for message timeout-test');
      await shortTimeoutAdapter.disconnect();
    });

    it('should handle send failure in sendAndReceive', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      const message = {
        jsonrpc: '2.0' as const,
        id: 'error-test',
        method: 'test/method'
      };

      await expect(adapter.sendAndReceive(message)).rejects.toThrow('Network error');
    });
  });

  describe('health check', () => {
    beforeEach(async () => {
      mockFetch.mockResolvedValue({ ok: true });
      await adapter.connect();
      vi.clearAllMocks();
    });

    it('should pass health check with successful response', async () => {
      const mockEventSource = (adapter as any).eventSource;
      
      const healthPromise = adapter.healthCheck();

      // Simulate health check response
      setTimeout(() => {
        const response = {
          jsonrpc: '2.0' as const,
          id: 'health-check',
          result: { tools: [] }
        };
        mockEventSource.simulateMessage(JSON.stringify(response));
      }, 10);

      const healthy = await healthPromise;
      expect(healthy).toBe(true);
    });

    it('should fail health check with error response', async () => {
      const mockEventSource = (adapter as any).eventSource;
      
      const healthPromise = adapter.healthCheck();

      // Simulate error response
      setTimeout(() => {
        const response = {
          jsonrpc: '2.0' as const,
          id: 'health-check',
          error: { code: -1, message: 'Service unavailable' }
        };
        mockEventSource.simulateMessage(JSON.stringify(response));
      }, 10);

      const healthy = await healthPromise;
      expect(healthy).toBe(false);
    });

    it('should fail health check on timeout', async () => {
      const shortTimeoutConfig = { ...mockConfig, timeout: 50 };
      const shortTimeoutAdapter = new StreamableHttpAdapter(shortTimeoutConfig, mockLogger);
      await shortTimeoutAdapter.connect();

      const healthy = await shortTimeoutAdapter.healthCheck();
      expect(healthy).toBe(false);

      await shortTimeoutAdapter.disconnect();
    });
  });

  describe('EventSource error handling', () => {
    it('should handle EventSource disconnect', async () => {
      await adapter.connect();
      const mockEventSource = (adapter as any).eventSource;

      let disconnectEventEmitted = false;
      adapter.on('disconnect', () => {
        disconnectEventEmitted = true;
      });

      // Simulate EventSource closed state
      mockEventSource.readyState = MockEventSource.CLOSED;
      mockEventSource.simulateError();

      expect(disconnectEventEmitted).toBe(true);
      expect(adapter.isConnected()).toBe(false);
    });

    it('should emit error for non-disconnect EventSource errors', async () => {
      await adapter.connect();
      const mockEventSource = (adapter as any).eventSource;

      let errorEventEmitted = false;
      adapter.on('error', () => {
        errorEventEmitted = true;
      });

      // Keep EventSource open but simulate error
      mockEventSource.readyState = MockEventSource.OPEN;
      mockEventSource.simulateError();

      expect(errorEventEmitted).toBe(true);
    });
  });
});
