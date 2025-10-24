const { AuthenticationLayerImpl } = require('./src/auth/AuthenticationLayerImpl.js');

const mockLogger = {
  debug: (msg, data) => console.log('DEBUG:', msg, data),
  info: (msg, data) => console.log('INFO:', msg, data),
  warn: (msg, data) => console.log('WARN:', msg, data),
  error: (msg, data) => console.log('ERROR:', msg, data)
};

const mockConfig = {
  authMode: 'external-secure',
  port: 19233,
  host: '127.0.0.1',
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
  rateLimiting: { enabled: false, maxRequests: 100, windowMs: 60000 },
  logLevel: 'info'
};

console.log('Creating AuthenticationLayerImpl...');
const auth = new AuthenticationLayerImpl(mockConfig, mockLogger);

console.log('API Keys after creation:', auth.listApiKeys());

setTimeout(() => {
  console.log('API Keys after timeout:', auth.listApiKeys());
}, 100);