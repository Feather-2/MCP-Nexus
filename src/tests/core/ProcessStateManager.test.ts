import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ProcessStateManager } from '../../core/ProcessStateManager.js';
import { ServiceState, Logger } from '../../types/index.js';

describe('ProcessStateManager', () => {
  let stateManager: ProcessStateManager;
  let mockLogger: Logger;

  beforeEach(() => {
    mockLogger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    };
    stateManager = new ProcessStateManager(mockLogger);
  });

  describe('state updates', () => {
    it('should update service state correctly', () => {
      const serviceId = 'test-service';
      
      stateManager.updateState(serviceId, 'idle');
      expect(stateManager.getState(serviceId)).toBe('idle');
    });

    it('should not update state if it is the same', () => {
      const serviceId = 'test-service';
      
      stateManager.updateState(serviceId, 'idle');
      stateManager.updateState(serviceId, 'idle');
      
      expect(mockLogger.debug).toHaveBeenCalledTimes(1);
    });

    it('should validate state transitions', () => {
      const serviceId = 'test-service';
      
      // Valid transition: idle -> initializing
      stateManager.updateState(serviceId, 'idle');
      stateManager.updateState(serviceId, 'initializing');
      
      expect(mockLogger.warn).not.toHaveBeenCalled();
      expect(stateManager.getState(serviceId)).toBe('initializing');
    });

    it('should warn on invalid state transitions', () => {
      const serviceId = 'test-service';
      
      // Invalid transition: idle -> running (should go through initializing -> starting)
      stateManager.updateState(serviceId, 'idle');
      stateManager.updateState(serviceId, 'running');
      
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining(`Invalid state transition for ${serviceId}: idle -> running`)
      );
      expect(stateManager.getState(serviceId)).toBe('running'); // Still updates despite being invalid
    });
  });

  describe('state history', () => {
    it('should track state history', () => {
      const serviceId = 'test-service';
      
      stateManager.updateState(serviceId, 'idle');
      stateManager.updateState(serviceId, 'initializing');
      stateManager.updateState(serviceId, 'starting');
      
      const history = stateManager.getStateHistory(serviceId);
      expect(history).toHaveLength(3);
      expect(history[0].state).toBe('idle');
      expect(history[1].state).toBe('initializing');
      expect(history[2].state).toBe('starting');
      expect(history[0].timestamp).toBeInstanceOf(Date);
    });

    it('should limit history to 10 entries', () => {
      const serviceId = 'test-service';
      const states: ServiceState[] = ['idle', 'initializing', 'starting', 'running', 'stopping', 
                                     'stopped', 'starting', 'running', 'stopping', 'stopped',
                                     'starting', 'running']; // 12 states
      
      states.forEach(state => stateManager.updateState(serviceId, state));
      
      const history = stateManager.getStateHistory(serviceId);
      expect(history).toHaveLength(10);
      expect(history[0].state).toBe('starting'); // First two should be removed
      expect(history[9].state).toBe('running');
    });

    it('should return empty array for non-existent service history', () => {
      const history = stateManager.getStateHistory('non-existent');
      expect(history).toEqual([]);
    });
  });

  describe('service management', () => {
    it('should remove service and its history', () => {
      const serviceId = 'test-service';
      
      stateManager.updateState(serviceId, 'idle');
      stateManager.updateState(serviceId, 'running');
      
      expect(stateManager.getState(serviceId)).toBe('running');
      expect(stateManager.getStateHistory(serviceId)).toHaveLength(2);
      
      stateManager.removeService(serviceId);
      
      expect(stateManager.getState(serviceId)).toBeUndefined();
      expect(stateManager.getStateHistory(serviceId)).toEqual([]);
    });

    it('should list services in specific state', () => {
      stateManager.updateState('service1', 'running');
      stateManager.updateState('service2', 'running');
      stateManager.updateState('service3', 'stopped');
      
      const runningServices = stateManager.listServicesInState('running');
      expect(runningServices).toEqual(['service1', 'service2']);
      
      const stoppedServices = stateManager.listServicesInState('stopped');
      expect(stoppedServices).toEqual(['service3']);
      
      const idleServices = stateManager.listServicesInState('idle');
      expect(idleServices).toEqual([]);
    });
  });

  describe('state transitions validation', () => {
    const validTransitions = [
      ['idle', 'initializing'],
      ['initializing', 'starting'],
      ['initializing', 'error'],
      ['starting', 'running'],
      ['starting', 'error'],
      ['starting', 'crashed'],
      ['running', 'stopping'],
      ['running', 'error'],
      ['running', 'crashed'],
      ['running', 'restarting'],
      ['running', 'maintenance'],
      ['stopping', 'stopped'],
      ['stopping', 'error'],
      ['stopped', 'starting'],
      ['stopped', 'idle'],
      ['error', 'starting'],
      ['error', 'stopping'],
      ['error', 'stopped'],
      ['crashed', 'starting'],
      ['crashed', 'stopped'],
      ['restarting', 'starting'],
      ['restarting', 'error'],
      ['upgrading', 'running'],
      ['upgrading', 'error'],
      ['maintenance', 'running'],
      ['maintenance', 'stopping']
    ] as const;

    it.each(validTransitions)('should allow valid transition from %s to %s', (from, to) => {
      const serviceId = 'test-service';
      
      stateManager.updateState(serviceId, from);
      stateManager.updateState(serviceId, to);
      
      expect(mockLogger.warn).not.toHaveBeenCalled();
      expect(stateManager.getState(serviceId)).toBe(to);
    });

    const invalidTransitions = [
      ['idle', 'running'],
      ['idle', 'stopped'],
      ['idle', 'crashed'],
      ['running', 'idle'],
      ['running', 'initializing'],
      ['stopped', 'running'],
      ['stopped', 'error']
    ] as const;

    it.each(invalidTransitions)('should warn on invalid transition from %s to %s', (from, to) => {
      const serviceId = 'test-service';
      
      stateManager.updateState(serviceId, from);
      vi.clearAllMocks(); // Clear the mock to ignore the first valid update
      
      stateManager.updateState(serviceId, to);
      
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining(`Invalid state transition for ${serviceId}: ${from} -> ${to}`)
      );
    });
  });
});