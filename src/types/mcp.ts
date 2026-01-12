// MCP Protocol core types

// MCP Protocol Versions
export const MCP_VERSIONS = ['2024-11-26', '2025-03-26', '2025-06-18'] as const;
export type McpVersion = typeof MCP_VERSIONS[number];

// Transport Types
export const TRANSPORT_TYPES = ['stdio', 'http', 'streamable-http'] as const;
export type TransportType = typeof TRANSPORT_TYPES[number];

// Service States
export const SERVICE_STATES = [
  'idle', 'initializing', 'starting', 'running', 'stopping',
  'stopped', 'error', 'crashed', 'restarting', 'upgrading', 'maintenance'
] as const;
export type ServiceState = typeof SERVICE_STATES[number];

// Routing Strategies
export const ROUTING_STRATEGIES = ['performance', 'cost', 'load-balance', 'content-aware'] as const;
export type RoutingStrategy = typeof ROUTING_STRATEGIES[number];

// Load Balancing Strategies
export const LOAD_BALANCING_STRATEGIES = ['round-robin', 'performance-based', 'cost-optimized', 'content-aware'] as const;
export type LoadBalancingStrategy = typeof LOAD_BALANCING_STRATEGIES[number];

// Orchestrator Modes
export const ORCHESTRATOR_MODES = ['manager-only', 'auto', 'wrapper-prefer'] as const;
export type OrchestratorMode = typeof ORCHESTRATOR_MODES[number];

// Security / Sandbox profiles
export const SECURITY_PROFILES = ['dev', 'default', 'locked-down'] as const;
export type SecurityProfile = typeof SECURITY_PROFILES[number];
