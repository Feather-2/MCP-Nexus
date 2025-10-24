import { ServiceState, Logger } from '../types/index.js';

export class ProcessStateManager {
  private serviceStates = new Map<string, ServiceState>();
  private stateHistory = new Map<string, Array<{ state: ServiceState; timestamp: Date }>>();

  constructor(private logger: Logger) {}

  updateState(serviceId: string, newState: ServiceState): void {
    const oldState = this.serviceStates.get(serviceId);
    
    if (oldState === newState) {
      return; // No change
    }

    // Validate state transition
    if (oldState && !this.isValidTransition(oldState, newState)) {
      this.logger.warn(`Invalid state transition for ${serviceId}: ${oldState} -> ${newState}`);
    }

    // Update current state
    this.serviceStates.set(serviceId, newState);

    // Record in history
    const history = this.stateHistory.get(serviceId) || [];
    history.push({ state: newState, timestamp: new Date() });
    
    // Keep only last 10 state changes
    if (history.length > 10) {
      history.shift();
    }
    
    this.stateHistory.set(serviceId, history);

    this.logger.debug(`State changed for ${serviceId}: ${oldState} -> ${newState}`);
  }

  getState(serviceId: string): ServiceState | undefined {
    return this.serviceStates.get(serviceId);
  }

  getStateHistory(serviceId: string): Array<{ state: ServiceState; timestamp: Date }> {
    return this.stateHistory.get(serviceId) || [];
  }

  removeService(serviceId: string): void {
    this.serviceStates.delete(serviceId);
    this.stateHistory.delete(serviceId);
  }

  listServicesInState(state: ServiceState): string[] {
    const services: string[] = [];
    for (const [serviceId, currentState] of this.serviceStates.entries()) {
      if (currentState === state) {
        services.push(serviceId);
      }
    }
    return services;
  }

  private isValidTransition(fromState: ServiceState, toState: ServiceState): boolean {
    const validTransitions: Record<ServiceState, ServiceState[]> = {
      'idle': ['initializing'],
      'initializing': ['starting', 'error'],
      'starting': ['running', 'error', 'crashed'],
      'running': ['stopping', 'error', 'crashed', 'restarting', 'maintenance'],
      'stopping': ['stopped', 'error'],
      'stopped': ['starting', 'idle'],
      'error': ['starting', 'stopping', 'stopped'],
      'crashed': ['starting', 'stopped'],
      'restarting': ['starting', 'error'],
      'upgrading': ['running', 'error'],
      'maintenance': ['running', 'stopping']
    };

    const allowedNextStates = validTransitions[fromState] || [];
    return allowedNextStates.includes(toState);
  }
}