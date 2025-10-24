// Export main gateway class
export { PbMcpGateway, createGateway } from './PbMcpGateway.js';

// Export types
export * from './types/index.js';

// Export core components
export { ServiceRegistryImpl } from './gateway/ServiceRegistryImpl.js';
export { AuthenticationLayerImpl } from './auth/AuthenticationLayerImpl.js';
export { GatewayRouterImpl } from './router/GatewayRouterImpl.js';
export { ProtocolAdaptersImpl } from './adapters/ProtocolAdaptersImpl.js';
export { ConfigManagerImpl } from './config/ConfigManagerImpl.js';
export { HttpApiServer } from './server/HttpApiServer.js';

// Export transport adapters
export { StdioTransportAdapter } from './adapters/StdioTransportAdapter.js';
export { HttpTransportAdapter } from './adapters/HttpTransportAdapter.js';
export { StreamableHttpAdapter } from './adapters/StreamableHttpAdapter.js';

// Export utilities
export { ConsoleLogger } from './utils/ConsoleLogger.js';