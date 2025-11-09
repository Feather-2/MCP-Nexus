import { ConfigManagerImpl } from '../../config/ConfigManagerImpl.js';
import { GatewayConfig, Logger } from '../../types/index.js';
import * as fs from 'fs/promises';
import * as path from 'path';

// Mock fs and path modules
vi.mock('fs/promises');
vi.mock('path');

describe('ConfigManagerImpl', () => {
  let configManager: ConfigManagerImpl;
  let mockLogger: Logger;
  
  const mockConfig: GatewayConfig = {
    port: 19233,
    host: '127.0.0.1',
    authMode: 'local-trusted',
    routingStrategy: 'performance',
    loadBalancingStrategy: 'performance-based',
    maxConcurrentServices: 50,
    requestTimeout: 30000,
    enableMetrics: true,
    enableHealthChecks: true,
    healthCheckInterval: 30000,
    maxRetries: 3,
    enableCors: true,
    corsOrigins: ['http://localhost:3000'],
    maxRequestSize: 10 * 1024 * 1024,
    metricsRetentionDays: 7,
    rateLimiting: {
      enabled: false,
      maxRequests: 100,
      windowMs: 60000
    },
    logLevel: 'info'
  };

  beforeEach(() => {
    mockLogger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      trace: vi.fn()
    };

    // Mock path.join to return a predictable path
    vi.mocked(path.join).mockImplementation((...segments) => segments.join('/'));
    vi.mocked(path.dirname).mockImplementation((p) => {
      if (typeof p === 'string') {
        return p.split('/').slice(0, -1).join('/');
      }
      return '/default/path';
    });
    
    // Mock fs operations
    vi.mocked(fs.mkdir).mockResolvedValue(undefined);
    vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(mockConfig));
    vi.mocked(fs.writeFile).mockResolvedValue(undefined);
    vi.mocked(fs.access).mockResolvedValue(undefined);
    vi.mocked(fs.watch).mockReturnValue({
      close: vi.fn(),
      [Symbol.asyncIterator]: vi.fn()
    } as any);

    configManager = new ConfigManagerImpl('/test/config/gateway.json', mockLogger);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('initialization', () => {
    it('should initialize with default config path', () => {
      expect(configManager).toBeDefined();
      expect(path.join).toHaveBeenCalledWith(process.cwd(), 'config', 'gateway.json');
    });

    it('should initialize with custom config path', () => {
      const customPath = '/custom/config.json';
      const customConfigManager = new ConfigManagerImpl(mockLogger, customPath);
      expect(customConfigManager).toBeDefined();
    });
  });

  describe('config loading', () => {
    it('should load config from file successfully', async () => {
      const config = await configManager.loadConfig();

      expect(fs.readFile).toHaveBeenCalledWith(
        expect.stringContaining('gateway.json'),
        'utf-8'
      );
      expect(config).toEqual(mockConfig);
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Configuration loaded successfully',
        expect.objectContaining({
          configPath: expect.stringContaining('gateway.json')
        })
      );
    });

    it('should create default config when file does not exist', async () => {
      vi.mocked(fs.readFile).mockRejectedValueOnce({ code: 'ENOENT' });

      const config = await configManager.loadConfig();

      expect(fs.mkdir).toHaveBeenCalled(); // Should create directory
      expect(fs.writeFile).toHaveBeenCalled(); // Should write default config
      expect(config).toBeDefined();
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Created default configuration file',
        expect.any(Object)
      );
    });

    it('should handle JSON parsing errors', async () => {
      vi.mocked(fs.readFile).mockResolvedValueOnce('invalid json');

      await expect(configManager.loadConfig()).rejects.toThrow();
      expect(mockLogger.error).toHaveBeenCalledWith(
        'Failed to load configuration:',
        expect.any(Error)
      );
    });

    it('should handle file system errors', async () => {
      const fsError = new Error('Permission denied');
      vi.mocked(fs.readFile).mockRejectedValueOnce(fsError);

      await expect(configManager.loadConfig()).rejects.toThrow();
      expect(mockLogger.error).toHaveBeenCalledWith(
        'Failed to load configuration:',
        fsError
      );
    });
  });

  describe('config saving', () => {
    it('should save config to file successfully', async () => {
      await configManager.saveConfig(mockConfig);

      expect(fs.mkdir).toHaveBeenCalled(); // Ensure directory exists
      expect(fs.writeFile).toHaveBeenCalledWith(
        expect.stringContaining('gateway.json'),
        JSON.stringify(mockConfig, null, 2)
      );
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Configuration saved successfully',
        expect.objectContaining({
          configPath: expect.stringContaining('gateway.json')
        })
      );
    });

    it('should handle save errors', async () => {
      const saveError = new Error('Disk full');
      vi.mocked(fs.writeFile).mockRejectedValueOnce(saveError);

      await expect(configManager.saveConfig(mockConfig)).rejects.toThrow();
      expect(mockLogger.error).toHaveBeenCalledWith(
        'Failed to save configuration:',
        saveError
      );
    });

    it('should create directory if it does not exist', async () => {
      vi.mocked(fs.mkdir).mockRejectedValueOnce({ code: 'EEXIST' });

      await configManager.saveConfig(mockConfig);

      expect(fs.mkdir).toHaveBeenCalledWith(
        expect.stringContaining('config'),
        { recursive: true }
      );
    });
  });

  describe('config validation', () => {
    it('should validate valid config', () => {
      const isValid = configManager.validateConfig(mockConfig);
      expect(isValid).toBe(true);
    });

    it('should reject invalid config', () => {
      const invalidConfig = {
        ...mockConfig,
        port: 'not-a-number' // Invalid port
      } as any;

      const isValid = configManager.validateConfig(invalidConfig);
      expect(isValid).toBe(false);
    });

    it('should handle validation with partial config', () => {
      const partialConfig = {
        port: 19233,
        host: '127.0.0.1',
        authMode: 'local-trusted'
      } as any;

      const isValid = configManager.validateConfig(partialConfig);
      // Should be valid as other fields have defaults
      expect(isValid).toBe(true);
    });
  });

  describe('config watching', () => {
    it('should start watching config file for changes', async () => {
      const changeCallback = vi.fn();
      
      await configManager.watchConfig(changeCallback);

      expect(fs.watch).toHaveBeenCalledWith(
        expect.stringContaining('gateway.json'),
        expect.any(Object)
      );
      expect(mockLogger.debug).toHaveBeenCalledWith(
        'Started watching configuration file',
        expect.any(Object)
      );
    });

    it('should handle file change events', async () => {
      const changeCallback = vi.fn();
      
      // Mock fs.watch to return an async iterator
      const mockWatcher = {
        close: vi.fn(),
        [Symbol.asyncIterator]: vi.fn().mockReturnValue({
          next: vi.fn()
            .mockResolvedValueOnce({
              done: false,
              value: { eventType: 'change', filename: 'gateway.json' }
            })
            .mockResolvedValueOnce({ done: true })
        })
      };
      
      vi.mocked(fs.watch).mockReturnValueOnce(mockWatcher as any);

      await configManager.watchConfig(changeCallback);

      // Simulate some time for the watcher to process events
      await new Promise(resolve => setTimeout(resolve, 10));
    });

    it('should stop watching when requested', async () => {
      const changeCallback = vi.fn();
      
      await configManager.watchConfig(changeCallback);
      configManager.stopWatching();

      expect(mockLogger.debug).toHaveBeenCalledWith('Stopped watching configuration file');
    });

    it('should handle watch errors gracefully', async () => {
      const changeCallback = vi.fn();
      const watchError = new Error('Watch failed');
      
      vi.mocked(fs.watch).mockImplementationOnce(() => {
        throw watchError;
      });

      await configManager.watchConfig(changeCallback);

      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Failed to watch configuration file:',
        watchError
      );
    });
  });

  describe('default config generation', () => {
    it('should generate default config with proper structure', async () => {
      vi.mocked(fs.readFile).mockRejectedValueOnce({ code: 'ENOENT' });

      const config = await configManager.loadConfig();

      expect(config).toMatchObject({
        port: expect.any(Number),
        host: expect.any(String),
        authMode: expect.any(String),
        routingStrategy: expect.any(String),
        loadBalancingStrategy: expect.any(String)
      });
    });

    it('should include all required fields in default config', async () => {
      vi.mocked(fs.readFile).mockRejectedValueOnce({ code: 'ENOENT' });

      const config = await configManager.loadConfig();

      const requiredFields = [
        'port', 'host', 'authMode', 'routingStrategy', 'loadBalancingStrategy',
        'maxConcurrentServices', 'requestTimeout', 'enableMetrics', 'enableHealthChecks'
      ];

      for (const field of requiredFields) {
        expect(config).toHaveProperty(field);
      }
    });
  });

  describe('config merging', () => {
    it('should merge partial updates with existing config', async () => {
      // Load initial config
      await configManager.loadConfig();

      const updates = {
        port: 8080,
        maxConcurrentServices: 100
      };

      await configManager.updateConfig(updates);

      expect(fs.writeFile).toHaveBeenCalledWith(
        expect.any(String),
        expect.stringContaining('"port": 8080')
      );
      expect(fs.writeFile).toHaveBeenCalledWith(
        expect.any(String),
        expect.stringContaining('"maxConcurrentServices": 100')
      );
    });

    it('should validate merged config before saving', async () => {
      await configManager.loadConfig();

      const invalidUpdates = {
        port: -1, // Invalid port
        authMode: 'invalid-mode'
      } as any;

      await expect(configManager.updateConfig(invalidUpdates)).rejects.toThrow();
    });
  });

  describe('backup and restore', () => {
    it('should create config backup', async () => {
      await configManager.createBackup();

      expect(fs.writeFile).toHaveBeenCalledWith(
        expect.stringContaining('.backup'),
        expect.any(String)
      );
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Configuration backup created',
        expect.any(Object)
      );
    });

    it('should restore from backup', async () => {
      const backupConfig = { ...mockConfig, port: 9999 };
      vi.mocked(fs.readFile)
        .mockResolvedValueOnce(JSON.stringify(mockConfig)) // Current config
        .mockResolvedValueOnce(JSON.stringify(backupConfig)); // Backup config

      await configManager.restoreFromBackup();

      expect(fs.writeFile).toHaveBeenCalledWith(
        expect.stringContaining('gateway.json'),
        JSON.stringify(backupConfig, null, 2)
      );
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Configuration restored from backup',
        expect.any(Object)
      );
    });

    it('should handle missing backup file', async () => {
      vi.mocked(fs.readFile)
        .mockResolvedValueOnce(JSON.stringify(mockConfig))
        .mockRejectedValueOnce({ code: 'ENOENT' });

      await expect(configManager.restoreFromBackup()).rejects.toThrow('Backup file not found');
    });
  });

  describe('environment variable overrides', () => {
    it('should apply environment variable overrides', async () => {
      // Mock environment variables
      const originalEnv = process.env;
      process.env = {
        ...originalEnv,
        PB_GATEWAY_PORT: '8080',
        PB_GATEWAY_HOST: '0.0.0.0',
        PB_GATEWAY_AUTH_MODE: 'external-secure'
      };

      const config = await configManager.loadConfigWithEnvOverrides();

      expect(config.port).toBe(8080);
      expect(config.host).toBe('0.0.0.0');
      expect(config.authMode).toBe('external-secure');

      // Restore environment
      process.env = originalEnv;
    });

    it('should handle invalid environment variable values', async () => {
      const originalEnv = process.env;
      process.env = {
        ...originalEnv,
        PB_GATEWAY_PORT: 'invalid-port'
      };

      // Should fall back to config file value
      const config = await configManager.loadConfigWithEnvOverrides();
      expect(config.port).toBe(mockConfig.port);

      process.env = originalEnv;
    });
  });
});