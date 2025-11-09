import { McpProtocolStackImpl } from '../../core/McpProtocolStackImpl.js';
import { McpServiceConfig, Logger, ServiceState } from '../../types/index.js';
import { spawn } from 'child_process';
import { EventEmitter } from 'events';

// Mock child_process
vi.mock('child_process');

// Mock dependencies
vi.mock('../../core/ProcessStateManager.js');
vi.mock('../../core/McpProtocolHandshaker.js');
vi.mock('../../utils/ErrorHandler.js');

// Create mock child process
class MockChildProcess extends EventEmitter {
  pid = 12345;
  stdin = {
    write: vi.fn(),
    end: vi.fn(),
    destroy: vi.fn()
  };
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  killed = false;
  exitCode: number | null = null;
  kill = vi.fn();

  constructor() {
    super();
    // Setup kill mock behavior
    this.kill.mockImplementation((signal?: string) => {
      this.killed = true;
      setTimeout(() => {
        this.emit('exit', 0, signal || 'SIGTERM');
      }, 10);
      return true;
    });
  }

  // Helper methods for testing
  simulateData(data: string) {
    this.stdout.emit('data', Buffer.from(data));
  }

  simulateError(error: Error) {
    this.emit('error', error);
  }

  simulateExit(code: number, signal?: string) {
    this.exitCode = code;
    this.emit('exit', code, signal);
  }
}

describe('McpProtocolStackImpl', () => {
  let protocolStack: McpProtocolStackImpl;
  let mockLogger: Logger;
  let mockConfig: McpServiceConfig;
  let mockChildProcess: MockChildProcess;

  beforeEach(() => {
    // Setup logger mock
    mockLogger = {
      trace: vi.fn(),
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    };

    // Setup service config mock
    mockConfig = {
      name: 'test-service',
      version: '2024-11-26',
      transport: 'stdio',
      command: 'node',
      args: ['test-server.js'],
      timeout: 30000,
      retries: 3,
      env: {
        NODE_ENV: 'test'
      },
      workingDirectory: '/tmp'
    };

    // Clear all mocks and reset spawn mock explicitly
    vi.clearAllMocks();
    vi.resetAllMocks();

    // Setup child process mock
    mockChildProcess = new MockChildProcess();
    vi.mocked(spawn).mockClear().mockReturnValue(mockChildProcess as any);

    // Create protocol stack instance
    protocolStack = new McpProtocolStackImpl(mockLogger);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('initialization', () => {
    it('should create instance with logger', () => {
      expect(protocolStack).toBeDefined();
    });
  });

  describe('process management', () => {
    it('should start a process successfully', async () => {
      // Mock handshake success
      const mockHandshaker = await import('../../core/McpProtocolHandshaker.js');
      vi.mocked(mockHandshaker.McpProtocolHandshaker.prototype.performHandshake).mockResolvedValue();

      const startPromise = protocolStack.startProcess(mockConfig);

      // Simulate successful process start
      setTimeout(() => {
        mockChildProcess.simulateData(JSON.stringify({
          jsonrpc: '2.0',
          id: expect.any(Number),
          result: { capabilities: {} }
        }));
      }, 50);

      const instance = await startPromise;

      expect(instance).toMatchObject({
        config: mockConfig,
        state: 'running',
        pid: 12345
      });
      
      expect(spawn).toHaveBeenCalledWith(
        'node',
        ['test-server.js'],
        expect.objectContaining({
          stdio: ['pipe', 'pipe', 'pipe'],
          env: expect.objectContaining({ NODE_ENV: 'test' }),
          cwd: '/tmp',
          shell: false
        })
      );
    });

    it('should handle process spawn failure', async () => {
      // Mock spawn to return process without PID
      const mockFailedProcess = { ...mockChildProcess, pid: undefined };
      vi.mocked(spawn).mockReturnValue(mockFailedProcess as any);

      await expect(protocolStack.startProcess(mockConfig)).rejects.toThrow('Failed to start process: node');
    });

    it('should stop a process gracefully', async () => {
      // First start a process
      const mockHandshaker = await import('../../core/McpProtocolHandshaker.js');
      vi.mocked(mockHandshaker.McpProtocolHandshaker.prototype.performHandshake).mockResolvedValue();

      const startPromise = protocolStack.startProcess(mockConfig);
      
      setTimeout(() => {
        mockChildProcess.simulateData(JSON.stringify({
          jsonrpc: '2.0',
          result: { capabilities: {} }
        }));
      }, 50);

      const instance = await startPromise;
      const serviceId = instance.id;

      // Now stop it
      await protocolStack.stopProcess(serviceId);

      expect(mockChildProcess.kill).toHaveBeenCalledWith('SIGTERM');
      expect(mockLogger.info).toHaveBeenCalledWith(`Service ${serviceId} stopped successfully`);
    });

    it('should force kill process after timeout', async () => {
      // Start process
      const mockHandshaker = await import('../../core/McpProtocolHandshaker.js');
      vi.mocked(mockHandshaker.McpProtocolHandshaker.prototype.performHandshake).mockResolvedValue();

      const startPromise = protocolStack.startProcess(mockConfig);
      
      setTimeout(() => {
        mockChildProcess.simulateData(JSON.stringify({
          jsonrpc: '2.0', 
          result: { capabilities: {} }
        }));
      }, 50);

      const instance = await startPromise;
      const serviceId = instance.id;

      // Mock process that doesn't respond to SIGTERM
      mockChildProcess.kill = vi.fn().mockImplementation((signal) => {
        if (signal === 'SIGKILL') {
          setTimeout(() => mockChildProcess.emit('exit', 9, 'SIGKILL'), 10);
        }
        // Don't emit exit for SIGTERM to simulate hanging process
        return true;
      });

      await protocolStack.stopProcess(serviceId);

      expect(mockChildProcess.kill).toHaveBeenCalledWith('SIGTERM');
      expect(mockChildProcess.kill).toHaveBeenCalledWith('SIGKILL');
    });

    it('should restart a process', async () => {
      // Setup mocks
      const mockHandshaker = await import('../../core/McpProtocolHandshaker.js');
      vi.mocked(mockHandshaker.McpProtocolHandshaker.prototype.performHandshake).mockResolvedValue();

      // Start process
      const startPromise = protocolStack.startProcess(mockConfig);
      
      setTimeout(() => {
        mockChildProcess.simulateData(JSON.stringify({
          jsonrpc: '2.0',
          result: { capabilities: {} }
        }));
      }, 50);

      const instance = await startPromise;
      const serviceId = instance.id;

      // Mock a new process for restart
      const newMockProcess = new MockChildProcess();
      newMockProcess.pid = 54321;
      vi.mocked(spawn).mockReturnValue(newMockProcess as any);

      const restartPromise = protocolStack.restartProcess(serviceId);

      // Simulate new process start
      setTimeout(() => {
        newMockProcess.simulateData(JSON.stringify({
          jsonrpc: '2.0',
          result: { capabilities: {} }
        }));
      }, 100);

      await restartPromise;

      expect(mockChildProcess.kill).toHaveBeenCalled(); // Old process killed
      expect(spawn).toHaveBeenCalledTimes(2); // New process started
    });

    it('should get process info', async () => {
      // Start process
      const mockHandshaker = await import('../../core/McpProtocolHandshaker.js');
      vi.mocked(mockHandshaker.McpProtocolHandshaker.prototype.performHandshake).mockResolvedValue();

      const startPromise = protocolStack.startProcess(mockConfig);
      
      setTimeout(() => {
        mockChildProcess.simulateData(JSON.stringify({
          jsonrpc: '2.0',
          result: { capabilities: {} }
        }));
      }, 50);

      const instance = await startPromise;
      const serviceId = instance.id;

      const info = await protocolStack.getProcessInfo(serviceId);
      
      expect(info).toMatchObject({
        id: serviceId,
        config: mockConfig,
        state: 'running',
        pid: 12345
      });
    });

    it('should return null for non-existent service', async () => {
      const info = await protocolStack.getProcessInfo('non-existent');
      expect(info).toBeNull();
    });
  });

  describe('message handling', () => {
    let serviceId: string;

    beforeEach(async () => {
      // Start a service for message tests
      const mockHandshaker = await import('../../core/McpProtocolHandshaker.js');
      vi.mocked(mockHandshaker.McpProtocolHandshaker.prototype.performHandshake).mockResolvedValue();

      const startPromise = protocolStack.startProcess(mockConfig);
      
      setTimeout(() => {
        mockChildProcess.simulateData(JSON.stringify({
          jsonrpc: '2.0',
          result: { capabilities: {} }
        }));
      }, 50);

      const instance = await startPromise;
      serviceId = instance.id;
    });

    it('should send and receive messages', async () => {
      const testMessage = {
        jsonrpc: '2.0' as const,
        id: 123,
        method: 'test',
        params: { data: 'test' }
      };

      // Create a promise for the response
      const responsePromise = protocolStack.sendMessage(serviceId, testMessage);
      
      // Wait a moment for the message to be sent
      await new Promise(resolve => setTimeout(resolve, 50));

      // Now simulate response from process
      mockChildProcess.simulateData(JSON.stringify({
        jsonrpc: '2.0',
        id: 123,
        result: { success: true }
      }));

      const response = await responsePromise;

      expect(mockChildProcess.stdin.write).toHaveBeenCalledWith(
        JSON.stringify(testMessage) + '\n'
      );
      expect(response).toMatchObject({
        jsonrpc: '2.0',
        id: 123,
        result: { success: true }
      });
    });

    it('should handle send message to non-existent service', async () => {
      const testMessage = {
        jsonrpc: '2.0' as const,
        id: 123,
        method: 'test'
      };

      await expect(
        protocolStack.sendMessage('non-existent', testMessage)
      ).rejects.toThrow('Service non-existent not found');
    });

    it('should handle receive message timeout', async () => {
      // Use a separate mock process for this test to avoid interference
      const timeoutMockProcess = new MockChildProcess();
      vi.mocked(spawn).mockReturnValue(timeoutMockProcess as any);
      
      // Start service with timeout config
      const mockHandshaker = await import('../../core/McpProtocolHandshaker.js');
      vi.mocked(mockHandshaker.McpProtocolHandshaker.prototype.performHandshake).mockResolvedValue();

      const startPromise = protocolStack.startProcess({...mockConfig, name: 'timeout-test'});
      
      setTimeout(() => {
        timeoutMockProcess.simulateData(JSON.stringify({
          jsonrpc: '2.0',
          result: { capabilities: {} }
        }));
      }, 50);

      const instance = await startPromise;
      
      // Don't simulate any response for the receiveMessage call - should timeout
      await expect(
        protocolStack.receiveMessage(instance.id, 100) // 100ms timeout
      ).rejects.toThrow(`Timeout waiting for message from ${instance.id}`);
    }, 5000);

    it('should handle malformed JSON in receive', async () => {
      // Use a separate mock process for this test
      const separateMockProcess = new MockChildProcess();
      vi.mocked(spawn).mockReturnValue(separateMockProcess as any);
      
      // Start a new service instance
      const mockHandshaker = await import('../../core/McpProtocolHandshaker.js');
      vi.mocked(mockHandshaker.McpProtocolHandshaker.prototype.performHandshake).mockResolvedValue();

      const startPromise = protocolStack.startProcess({...mockConfig, name: 'malformed-test'});
      
      setTimeout(() => {
        separateMockProcess.simulateData(JSON.stringify({
          jsonrpc: '2.0',
          result: { capabilities: {} }
        }));
      }, 50);

      const instance = await startPromise;
      
      // Now test the malformed JSON
      const receivePromise = protocolStack.receiveMessage(instance.id);
      
      // Send malformed JSON
      setTimeout(() => {
        separateMockProcess.simulateData('{ invalid json }');
      }, 50);

      await expect(receivePromise).rejects.toThrow();
    });
  });

  describe('version negotiation and capabilities', () => {
    let serviceId: string;

    beforeEach(async () => {
      // Start service
      const mockHandshaker = await import('../../core/McpProtocolHandshaker.js');
      vi.mocked(mockHandshaker.McpProtocolHandshaker.prototype.performHandshake).mockResolvedValue();

      const startPromise = protocolStack.startProcess(mockConfig);
      
      setTimeout(() => {
        mockChildProcess.simulateData(JSON.stringify({
          jsonrpc: '2.0',
          result: { capabilities: {} }
        }));
      }, 50);

      const instance = await startPromise;
      serviceId = instance.id;
    });

    it('should negotiate version', async () => {
      const mockHandshaker = await import('../../core/McpProtocolHandshaker.js');
      vi.mocked(mockHandshaker.McpProtocolHandshaker.prototype.negotiateVersion)
        .mockResolvedValue('2024-11-26');

      const version = await protocolStack.negotiateVersion(serviceId, ['2024-11-26', '2025-06-18']);

      expect(version).toBe('2024-11-26');
      expect(mockHandshaker.McpProtocolHandshaker.prototype.negotiateVersion)
        .toHaveBeenCalledWith(serviceId, ['2024-11-26', '2025-06-18']);
    });

    it('should get capabilities', async () => {
      // We need to capture the message ID to respond correctly
      let messageId: any;
      const originalWrite = mockChildProcess.stdin.write as any;
      mockChildProcess.stdin.write = vi.fn().mockImplementation((data: string) => {
        const message = JSON.parse(data.trim());
        messageId = message.id;
        return originalWrite.call(mockChildProcess.stdin, data);
      });
      
      const capabilitiesPromise = protocolStack.getCapabilities(serviceId);
      
      // Wait for the message to be sent
      await new Promise(resolve => setTimeout(resolve, 50));
      
      // Simulate capabilities response with the correct ID
      mockChildProcess.simulateData(JSON.stringify({
        jsonrpc: '2.0',
        id: messageId,
        result: {
          capabilities: {
            resources: {},
            tools: {},
            prompts: {}
          }
        }
      }));

      const capabilities = await capabilitiesPromise;
      
      expect(capabilities).toEqual({
        resources: {},
        tools: {},
        prompts: {}
      });
    });

    it('should handle capabilities error', async () => {
      // Capture the message ID to respond correctly
      let messageId: any;
      const originalWrite = mockChildProcess.stdin.write as any;
      mockChildProcess.stdin.write = vi.fn().mockImplementation((data: string) => {
        const message = JSON.parse(data.trim());
        messageId = message.id;
        return originalWrite.call(mockChildProcess.stdin, data);
      });
      
      const capabilitiesPromise = protocolStack.getCapabilities(serviceId);
      
      // Wait for the message to be sent
      await new Promise(resolve => setTimeout(resolve, 50));
      
      // Simulate error response with correct ID
      mockChildProcess.simulateData(JSON.stringify({
        jsonrpc: '2.0',
        id: messageId,
        error: {
          code: -1,
          message: 'Not supported'
        }
      }));

      await expect(capabilitiesPromise).rejects.toThrow('Failed to get capabilities: Not supported');
    });
  });

  describe('error handling', () => {
    it('should handle process errors', async () => {
      // Start process
      const mockHandshaker = await import('../../core/McpProtocolHandshaker.js');
      vi.mocked(mockHandshaker.McpProtocolHandshaker.prototype.performHandshake).mockResolvedValue();

      const startPromise = protocolStack.startProcess(mockConfig);
      
      setTimeout(() => {
        mockChildProcess.simulateData(JSON.stringify({
          jsonrpc: '2.0',
          result: { capabilities: {} }
        }));
      }, 50);

      const instance = await startPromise;
      const serviceId = instance.id;

      // Set up event listener
      const errorListener = vi.fn();
      protocolStack.on('service-error', errorListener);

      // Simulate process error
      const testError = new Error('Process crashed');
      mockChildProcess.simulateError(testError);

      // Give some time for error handling
      await new Promise(resolve => setTimeout(resolve, 100));

      expect(errorListener).toHaveBeenCalledWith({
        serviceId,
        error: testError
      });

      const updatedInstance = await protocolStack.getProcessInfo(serviceId);
      expect(updatedInstance?.state).toBe('error');
      expect(updatedInstance?.errorCount).toBe(1);
    });

    it('should handle process exit with error code', async () => {
      // Start process
      const mockHandshaker = await import('../../core/McpProtocolHandshaker.js');
      vi.mocked(mockHandshaker.McpProtocolHandshaker.prototype.performHandshake).mockResolvedValue();

      const startPromise = protocolStack.startProcess(mockConfig);
      
      setTimeout(() => {
        mockChildProcess.simulateData(JSON.stringify({
          jsonrpc: '2.0',
          result: { capabilities: {} }
        }));
      }, 50);

      const instance = await startPromise;
      const serviceId = instance.id;

      // Set up event listener
      const exitListener = vi.fn();
      protocolStack.on('service-stopped', exitListener);

      // Simulate process exit with error
      mockChildProcess.simulateExit(1, 'SIGTERM');

      // Give some time for event handling
      await new Promise(resolve => setTimeout(resolve, 100));

      expect(exitListener).toHaveBeenCalledWith({
        serviceId,
        code: 1,
        signal: 'SIGTERM'
      });

      const updatedInstance = await protocolStack.getProcessInfo(serviceId);
      expect(updatedInstance?.state).toBe('crashed');
      expect(updatedInstance?.errorCount).toBe(1);
    });

    it('should handle handshake failure', async () => {
      // Mock handshake failure
      const mockHandshaker = await import('../../core/McpProtocolHandshaker.js');
      vi.mocked(mockHandshaker.McpProtocolHandshaker.prototype.performHandshake)
        .mockRejectedValue(new Error('Handshake failed'));

      await expect(protocolStack.startProcess(mockConfig)).rejects.toThrow('Handshake failed for');
    });
  });

  describe('event system', () => {
    it('should support event listeners', () => {
      const listener = vi.fn();
      
      protocolStack.on('test-event', listener);
      protocolStack['eventEmitter'].emit('test-event', { data: 'test' });
      
      expect(listener).toHaveBeenCalledWith({ data: 'test' });
    });

    it('should support removing event listeners', () => {
      const listener = vi.fn();
      
      protocolStack.on('test-event', listener);
      protocolStack.off('test-event', listener);
      protocolStack['eventEmitter'].emit('test-event', { data: 'test' });
      
      expect(listener).not.toHaveBeenCalled();
    });
  });
});