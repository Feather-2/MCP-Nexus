import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    testTimeout: 10000,
    hookTimeout: 10000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: [
        '**/*.test.ts',
        '**/dist/**',
        // Exclude GUI, scripts, and other non-core files from coverage requirements
        'gui/**',
        'scripts/**',
        '*.js',
        '*.cjs',
        'src/cli.ts',
        'src/cli-simple.ts',
        'src/SimplePbMcpGateway.ts',
        'src/generator/**',
        'src/config/ExternalMcpConfigImporter.ts'
      ],
      all: true,
      thresholds: {
        lines: 25,      // Current: 24.69% → Target: gradually increase
        functions: 50,  // Current: 53.04% → Already above
        branches: 60,   // Current: 62.26% → Already above
        statements: 25  // Current: 24.69% → Target: gradually increase
      }
    }
  }
});