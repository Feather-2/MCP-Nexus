import { describe, it, expect, beforeEach, vi } from 'vitest';
import { McpProtocolHandshaker } from '../../core/McpProtocolHandshaker.js';
import { McpVersion, McpMessage, McpProtocolStack, Logger } from '../../types/index.js';

describe('McpProtocolHandshaker', () => {
  let handshaker: McpProtocolHandshaker;
  let mockLogger: Logger;
  let mockProtocolStack: McpProtocolStack;

  beforeEach(() => {
    mockLogger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    };

    mockProtocolStack = {
      sendMessage: vi.fn(),
      close: vi.fn(),
      isConnected: vi.fn(),
      getProcessInfo: vi.fn()
    } as any;

    handshaker = new McpProtocolHandshaker(mockLogger);
  });

  describe('version negotiation', () => {
    it('should select the latest version from supported versions', async () => {
      const versions: McpVersion[] = ['2024-11-26', '2025-03-26', '2025-06-18'];
      const result = await handshaker.negotiateVersion('test-service', versions);

      expect(result).toBe('2025-06-18');
      expect(mockLogger.debug).toHaveBeenCalledWith(
        'Version negotiated for test-service: 2025-06-18'
      );
    });

    it('should handle single version', async () => {
      const versions: McpVersion[] = ['2024-11-26'];
      const result = await handshaker.negotiateVersion('test-service', versions);

      expect(result).toBe('2024-11-26');
    });

    it('should sort versions correctly', async () => {
      const versions: McpVersion[] = ['2024-11-26', '2025-06-18', '2025-03-26'];
      const result = await handshaker.negotiateVersion('test-service', versions);

      expect(result).toBe('2025-06-18');
    });
  });

  describe('handshake process', () => {
    it('should perform successful handshake', async () => {
      const serviceId = 'test-service';

      // Mock successful initialize response
      vi.mocked(mockProtocolStack.sendMessage)
        .mockResolvedValueOnce({
          jsonrpc: '2.0',
          id: 'init-123',
          result: {
            capabilities: {
              tools: { listChanged: true }
            },
            serverInfo: {
              name: 'test-server',
              version: '1.0.0'
            }
          }
        })
        // Mock initialized notifications (no response expected)
        .mockResolvedValueOnce({
          jsonrpc: '2.0'
        })
        .mockResolvedValueOnce({
          jsonrpc: '2.0'
        })
        // Mock verification response
        .mockResolvedValueOnce({
          jsonrpc: '2.0',
          id: 'ping-123',
          result: {
            tools: []
          }
        });

      await handshaker.performHandshake(serviceId, mockProtocolStack);

      // Now there should be 4 calls: initialize, initialized, notifications/initialized, tools/list
      expect(mockProtocolStack.sendMessage).toHaveBeenCalledTimes(4);

      // Verify initialize message with negotiated latest version
      const calls = vi.mocked(mockProtocolStack.sendMessage).mock.calls;
      const initCall = calls[0];
      expect(initCall[1]).toMatchObject({
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          clientInfo: {
            name: 'MCP-Nexus',
            version: '1.0.0'
          }
        }
      });

      // Verify both initialized variants were sent
      const methods = calls.slice(1).map(c => (c[1] as any).method);
      expect(methods).toContain('initialized');
      expect(methods).toContain('notifications/initialized');

      // Verify verification message exists
      expect(methods).toContain('tools/list');

      expect(mockLogger.info).toHaveBeenCalledWith(
        'Handshake completed successfully for test-service'
      );
    });

    it('should handle initialize error', async () => {
      const serviceId = 'test-service';

      vi.mocked(mockProtocolStack.sendMessage)
        .mockResolvedValueOnce({
          jsonrpc: '2.0',
          id: 'init-123',
          error: {
            code: -1,
            message: 'Initialization failed'
          }
        });

      await expect(handshaker.performHandshake(serviceId, mockProtocolStack))
        .rejects.toThrow('Initialize failed: Initialization failed');

      expect(mockLogger.error).toHaveBeenCalledWith(
        'Handshake failed for test-service:',
        expect.any(Error)
      );
    });

    it('should handle verification failure gracefully', async () => {
      const serviceId = 'test-service';

      vi.mocked(mockProtocolStack.sendMessage)
        .mockResolvedValueOnce({
          jsonrpc: '2.0',
          id: 'init-123',
          result: { capabilities: {} }
        })
        .mockResolvedValueOnce({
          jsonrpc: '2.0'
        })
        .mockResolvedValueOnce({
          jsonrpc: '2.0'
        })
        // Verification fails with non-method-not-found error
        .mockResolvedValueOnce({
          jsonrpc: '2.0',
          id: 'ping-123',
          error: {
            code: -500,
            message: 'Service not ready'
          }
        });

      // Should not throw, just log warning
      await handshaker.performHandshake(serviceId, mockProtocolStack);

      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Service verification warning for test-service:',
        expect.any(Error)
      );
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Handshake completed successfully for test-service'
      );
    });

    it('should handle method not found in verification as acceptable', async () => {
      const serviceId = 'test-service';

      vi.mocked(mockProtocolStack.sendMessage)
        .mockResolvedValueOnce({
          jsonrpc: '2.0',
          id: 'init-123',
          result: { capabilities: {} }
        })
        .mockResolvedValueOnce({
          jsonrpc: '2.0'
        })
        .mockResolvedValueOnce({
          jsonrpc: '2.0'
        })
        // Method not found is acceptable
        .mockResolvedValueOnce({
          jsonrpc: '2.0',
          id: 'ping-123',
          error: {
            code: -32601,
            message: 'Method not found'
          }
        });

      await handshaker.performHandshake(serviceId, mockProtocolStack);

      expect(mockLogger.warn).not.toHaveBeenCalled();
      expect(mockLogger.debug).toHaveBeenCalledWith(
        'Service test-service verified as ready'
      );
    });
  });

  describe('server capabilities', () => {
    it('should retrieve server capabilities successfully', async () => {
      const serviceId = 'test-service';
      const expectedCapabilities = {
        tools: { listChanged: true },
        resources: { subscribe: true }
      };

      vi.mocked(mockProtocolStack.sendMessage)
        .mockResolvedValueOnce({
          jsonrpc: '2.0',
          id: 'caps-123',
          result: {
            capabilities: expectedCapabilities,
            serverInfo: { name: 'test-server' }
          }
        });

      const capabilities = await handshaker.getServerCapabilities(serviceId, mockProtocolStack);

      expect(capabilities).toEqual(expectedCapabilities);

      const message = vi.mocked(mockProtocolStack.sendMessage).mock.calls[0][1] as McpMessage;
      expect(message.method).toBe('initialize');
      expect(message.params?.protocolVersion).toBe('2025-06-18');
    });

    it('should handle capabilities error', async () => {
      const serviceId = 'test-service';

      vi.mocked(mockProtocolStack.sendMessage)
        .mockResolvedValueOnce({
          jsonrpc: '2.0',
          id: 'caps-123',
          error: {
            code: -1,
            message: 'Capabilities not available'
          }
        });

      await expect(handshaker.getServerCapabilities(serviceId, mockProtocolStack))
        .rejects.toThrow('Failed to get server capabilities: Capabilities not available');
    });

    it('should return empty capabilities if not provided', async () => {
      const serviceId = 'test-service';

      vi.mocked(mockProtocolStack.sendMessage)
        .mockResolvedValueOnce({
          jsonrpc: '2.0',
          id: 'caps-123',
          result: {
            serverInfo: { name: 'test-server' }
            // No capabilities field
          }
        });

      const capabilities = await handshaker.getServerCapabilities(serviceId, mockProtocolStack);

      expect(capabilities).toEqual({});
    });
  });
});
