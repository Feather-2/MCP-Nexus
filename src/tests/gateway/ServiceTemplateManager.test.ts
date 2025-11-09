import { ServiceTemplateManager } from '../../gateway/ServiceTemplateManager.js';
import { McpServiceConfig, Logger } from '../../types/index.js';
import * as fs from 'fs/promises';
import * as path from 'path';

// Mock fs and path modules
vi.mock('fs/promises');
vi.mock('path');

describe('ServiceTemplateManager', () => {
  let templateManager: ServiceTemplateManager;
  let mockLogger: Logger;
  
  const mockTemplate: McpServiceConfig = {
    name: 'test-service',
    version: '2024-11-26',
    transport: 'stdio',
    command: 'node',
    args: ['-v'],
    timeout: 5000,
    retries: 2
  };

  beforeEach(() => {
    mockLogger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      trace: vi.fn()
    };

    // Clear and reset all mocks explicitly
    vi.clearAllMocks();
    vi.resetAllMocks();

    // Mock path.join to return a predictable path
    vi.mocked(path.join).mockClear().mockImplementation((...segments) => segments.join('/'));

    // Mock fs operations with explicit clears
    vi.mocked(fs.mkdir).mockClear().mockResolvedValue(undefined);
    vi.mocked(fs.writeFile).mockClear().mockResolvedValue(undefined);
    vi.mocked(fs.readFile).mockClear().mockResolvedValue(JSON.stringify(mockTemplate));
    vi.mocked(fs.readdir).mockClear().mockResolvedValue([]);
    vi.mocked(fs.unlink).mockClear().mockResolvedValue(undefined);

    templateManager = new ServiceTemplateManager(mockLogger);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('initialization', () => {
    it('should create templates directory on initialization', () => {
      expect(fs.mkdir).toHaveBeenCalledWith(
        expect.stringContaining('templates'),
        { recursive: true }
      );
    });

    it('should handle directory creation errors', async () => {
      const error = new Error('Permission denied');
      vi.mocked(fs.mkdir).mockRejectedValueOnce(error);
      
      // Create a new instance to trigger initialization
      new ServiceTemplateManager(mockLogger);
      
      // Wait for async initialization
      await new Promise(resolve => setTimeout(resolve, 0));
      
      expect(mockLogger.error).toHaveBeenCalledWith(
        'Failed to create templates directory:',
        error
      );
    });
  });

  describe('template registration', () => {
    it('should register valid template', async () => {
      await templateManager.register(mockTemplate);

      expect(fs.writeFile).toHaveBeenCalledWith(
        expect.stringContaining('test-service.json'),
        JSON.stringify(mockTemplate, null, 2)
      );
      expect(mockLogger.debug).toHaveBeenCalledWith('Template registered: test-service');
    });

    it('should validate template schema', async () => {
      const invalidTemplate = {
        name: '', // Invalid: empty name
        version: '2024-11-26',
        transport: 'stdio'
      } as any;

      await expect(templateManager.register(invalidTemplate))
        .rejects.toThrow();
    });

    it('should handle file write errors', async () => {
      const error = new Error('Disk full');
      vi.mocked(fs.writeFile).mockRejectedValueOnce(error);

      await expect(templateManager.register(mockTemplate))
        .rejects.toThrow('Disk full');
    });

    it('should overwrite existing template', async () => {
      const updatedTemplate = { ...mockTemplate, timeout: 10000 };

      await templateManager.register(mockTemplate);
      await templateManager.register(updatedTemplate);

      // Should write twice
      expect(fs.writeFile).toHaveBeenCalledTimes(2);
      expect(mockLogger.debug).toHaveBeenCalledTimes(2);
    });
  });

  describe('template retrieval', () => {
    it('should get template from memory', async () => {
      // Register template first
      await templateManager.register(mockTemplate);

      const result = await templateManager.get('test-service');

      expect(result).toEqual(mockTemplate);
      // Should not read from file since it's in memory
      expect(fs.readFile).not.toHaveBeenCalled();
    });

    it('should load template from disk if not in memory', async () => {
      vi.mocked(fs.readFile).mockResolvedValueOnce(JSON.stringify(mockTemplate));

      const result = await templateManager.get('test-service');

      expect(fs.readFile).toHaveBeenCalledWith(
        expect.stringContaining('test-service.json'),
        'utf-8'
      );
      expect(result).toEqual(mockTemplate);
      expect(mockLogger.debug).toHaveBeenCalledWith('Template loaded from disk: test-service');
    });

    it('should return null for non-existent template', async () => {
      vi.mocked(fs.readFile).mockRejectedValueOnce(new Error('File not found'));

      const result = await templateManager.get('non-existent');

      expect(result).toBeNull();
    });

    it('should handle invalid JSON in template file', async () => {
      vi.mocked(fs.readFile).mockResolvedValueOnce('invalid json');

      const result = await templateManager.get('test-service');

      expect(result).toBeNull();
      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Failed to parse template test-service:',
        expect.any(Error)
      );
    });
  });

  describe('template listing', () => {
    it('should list templates from memory and disk', async () => {
      const diskTemplate: McpServiceConfig = {
        name: 'disk-service',
        version: '2024-11-26',
        transport: 'http',
        command: 'python',
        args: ['--version'],
        timeout: 8000,
        retries: 1
      };

      // Register one template in memory
      await templateManager.register(mockTemplate);

      // Mock disk templates
      vi.mocked(fs.readdir).mockResolvedValueOnce(['disk-service.json'] as any);
      vi.mocked(fs.readFile).mockResolvedValueOnce(JSON.stringify(diskTemplate));

      const result = await templateManager.list();

      expect(result).toHaveLength(2);
      expect(result).toContainEqual(mockTemplate);
      expect(result).toContainEqual(diskTemplate);
    });

    it('should handle readdir errors', async () => {
      const error = new Error('Permission denied');
      vi.mocked(fs.readdir).mockRejectedValueOnce(error);

      // Should still return templates from memory
      await templateManager.register(mockTemplate);

      const result = await templateManager.list();

      expect(result).toEqual([mockTemplate]);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Failed to read templates directory:',
        error
      );
    });

    it('should skip invalid template files', async () => {
      vi.mocked(fs.readdir).mockResolvedValueOnce([
        'valid.json',
        'invalid.json',
        'not-json.txt'
      ] as any);
      
      vi.mocked(fs.readFile)
        .mockResolvedValueOnce(JSON.stringify(mockTemplate))
        .mockResolvedValueOnce('invalid json');

      const result = await templateManager.list();

      expect(result).toEqual([mockTemplate]);
      expect(mockLogger.debug).toHaveBeenCalledWith('Skipping non-JSON file: not-json.txt');
    });

    it('should deduplicate templates from memory and disk', async () => {
      // Register template in memory
      await templateManager.register(mockTemplate);

      // Mock same template on disk
      vi.mocked(fs.readdir).mockResolvedValueOnce(['test-service.json'] as any);
      vi.mocked(fs.readFile).mockResolvedValueOnce(JSON.stringify(mockTemplate));

      const result = await templateManager.list();

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual(mockTemplate);
    });
  });

  describe('template removal', () => {
    it('should remove template from memory and disk', async () => {
      // Register template first
      await templateManager.register(mockTemplate);

      await templateManager.remove('test-service');

      expect(fs.unlink).toHaveBeenCalledWith(
        expect.stringContaining('test-service.json')
      );
      expect(mockLogger.debug).toHaveBeenCalledWith('Template removed: test-service');

      // Should return null after removal
      const result = await templateManager.get('test-service');
      expect(result).toBeNull();
    });

    it('should handle file deletion errors', async () => {
      const error = new Error('File not found');
      vi.mocked(fs.unlink).mockRejectedValueOnce(error);

      await templateManager.remove('test-service');

      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Failed to delete template file for test-service:',
        error
      );
    });
  });

  describe('default template initialization', () => {
    it('should initialize default templates', async () => {
      await templateManager.initializeDefaults();

      // Should register multiple default templates
      expect(fs.writeFile).toHaveBeenCalledTimes(3); // filesystem, brave-search, github
      expect(mockLogger.info).toHaveBeenCalledWith('Default templates initialized');
    });

    it('should skip initialization if templates already exist', async () => {
      // Mock existing templates
      vi.mocked(fs.readdir).mockResolvedValueOnce(['filesystem.json'] as any);

      await templateManager.initializeDefaults();

      expect(fs.writeFile).not.toHaveBeenCalled();
      expect(mockLogger.info).toHaveBeenCalledWith('Default templates already exist, skipping initialization');
    });
  });
});