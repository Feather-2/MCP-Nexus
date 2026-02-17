import { performance } from 'node:perf_hooks';

interface LoadTestResult {
  scenario: string;
  totalRequests: number;
  successCount: number;
  errorCount: number;
  duration: number;
  rps: number;
  latency: {
    min: number;
    max: number;
    avg: number;
    p50: number;
    p95: number;
    p99: number;
  };
  errors: Record<string, number>;
}

interface Scenario {
  name: string;
  path: string;
  method: string;
  body: unknown | null;
}

interface CliConfig {
  targetUrl: string;
  concurrency: number;
  durationMs: number;
  scenario: string;
}

function parseCliArgs(argv: string[]): Record<string, string> {
  const parsed: Record<string, string> = {};

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      continue;
    }

    const rawKey = token.slice(2);
    const [keyPart, inlineValue] = rawKey.split('=', 2);
    const key = normalizeArgKey(keyPart.trim());
    if (!key) {
      continue;
    }

    if (inlineValue !== undefined) {
      parsed[key] = inlineValue;
      continue;
    }

    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      parsed[key] = next;
      i += 1;
      continue;
    }

    parsed[key] = 'true';
  }

  return parsed;
}

function normalizeArgKey(key: string): string {
  return key.replace(/[_\s]+/g, '-').toLowerCase();
}

function getArgValue(args: Record<string, string>, candidates: string[]): string | undefined {
  for (const candidate of candidates) {
    const normalized = normalizeArgKey(candidate);
    if (args[normalized] !== undefined) {
      return args[normalized];
    }
  }

  return undefined;
}

function parsePositiveInt(value: string | undefined, fallback: number, label: string): number {
  if (value === undefined) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer. Received: ${value}`);
  }

  return parsed;
}

function loadConfigFromEnvAndArgs(): CliConfig {
  const args = parseCliArgs(process.argv.slice(2));

  const targetUrl =
    getArgValue(args, ['target-url', 'target']) ??
    process.env.TARGET_URL ??
    'http://127.0.0.1:3000';

  const concurrency = parsePositiveInt(
    getArgValue(args, ['concurrency']) ?? process.env.CONCURRENCY,
    10,
    'CONCURRENCY'
  );

  const durationMs = parsePositiveInt(
    getArgValue(args, ['duration-ms', 'duration']) ?? process.env.DURATION_MS,
    10000,
    'DURATION_MS'
  );

  const scenario =
    getArgValue(args, ['scenario']) ??
    process.env.SCENARIO ??
    'all';

  return {
    targetUrl: targetUrl.replace(/\/$/, ''),
    concurrency,
    durationMs,
    scenario,
  };
}

function incrementCounter(map: Record<string, number>, key: string): void {
  map[key] = (map[key] ?? 0) + 1;
}

function percentage(part: number, total: number): string {
  if (total <= 0) {
    return '0.00';
  }

  return ((part / total) * 100).toFixed(2);
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) {
    return 0;
  }

  const idx = Math.ceil((sorted.length * p) / 100) - 1;
  return sorted[Math.max(0, idx)] ?? sorted[sorted.length - 1];
}

function formatMs(ms: number): string {
  if (!Number.isFinite(ms)) {
    return '0.0ms';
  }

  if (ms > 0 && ms < 0.001) {
    return `${Math.max(1, Math.round(ms * 1000))}μs`;
  }

  return `${ms.toFixed(1)}ms`;
}

function aggregateLatency(latencies: number[]): LoadTestResult['latency'] {
  if (latencies.length === 0) {
    return {
      min: 0,
      max: 0,
      avg: 0,
      p50: 0,
      p95: 0,
      p99: 0,
    };
  }

  const sorted = [...latencies].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, value) => acc + value, 0);

  return {
    min: sorted[0],
    max: sorted[sorted.length - 1],
    avg: sum / sorted.length,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
  };
}

async function runScenario(
  name: string,
  urlPath: string,
  method: string,
  body: unknown | null,
  concurrency: number,
  durationMs: number
): Promise<LoadTestResult> {
  const latencies: number[] = [];
  const errors: Record<string, number> = {};
  const requestBody = body === null ? undefined : JSON.stringify(body);
  const headers: HeadersInit | undefined =
    body === null
      ? undefined
      : {
        'content-type': 'application/json',
      };

  let totalRequests = 0;
  let successCount = 0;
  let errorCount = 0;

  const startedAt = performance.now();
  const deadline = startedAt + durationMs;

  const worker = async (): Promise<void> => {
    while (performance.now() < deadline) {
      const requestStart = performance.now();

      try {
        const response = await fetch(urlPath, {
          method,
          headers,
          body: requestBody,
        });

        await response.arrayBuffer();

        const elapsed = performance.now() - requestStart;
        latencies.push(elapsed);
        totalRequests += 1;

        if (response.ok) {
          successCount += 1;
        } else {
          errorCount += 1;
          incrementCounter(errors, `HTTP ${response.status}`);
        }
      } catch (error: unknown) {
        const elapsed = performance.now() - requestStart;
        latencies.push(elapsed);
        totalRequests += 1;
        errorCount += 1;

        const message =
          error instanceof Error && error.message.trim().length > 0
            ? error.message
            : String(error);

        incrementCounter(errors, message);
      }
    }
  };

  await Promise.all(Array.from({ length: concurrency }, async () => worker()));

  const duration = performance.now() - startedAt;
  const latency = aggregateLatency(latencies);

  return {
    scenario: name,
    totalRequests,
    successCount,
    errorCount,
    duration,
    rps: duration > 0 ? totalRequests / (duration / 1000) : 0,
    latency,
    errors,
  };
}

function printResult(result: LoadTestResult, concurrency: number): void {
  console.log(`=== Load Test: ${result.scenario} ===`);
  console.log(`  Duration:     ${(result.duration / 1000).toFixed(1)}s`);
  console.log(`  Concurrency:  ${concurrency}`);
  console.log(`  Total:        ${result.totalRequests} requests`);
  console.log(`  Success:      ${result.successCount} (${percentage(result.successCount, result.totalRequests)}%)`);
  console.log(`  Errors:       ${result.errorCount} (${percentage(result.errorCount, result.totalRequests)}%)`);
  console.log(`  Throughput:   ${result.rps.toFixed(1)} req/s`);
  console.log('  Latency:');
  console.log(`    min:   ${formatMs(result.latency.min)}`);
  console.log(`    avg:   ${formatMs(result.latency.avg)}`);
  console.log(`    p50:   ${formatMs(result.latency.p50)}`);
  console.log(`    p95:   ${formatMs(result.latency.p95)}`);
  console.log(`    p99:   ${formatMs(result.latency.p99)}`);
  console.log(`    max:   ${formatMs(result.latency.max)}`);

  if (result.errorCount > 0) {
    console.log('  Error Breakdown:');
    for (const [label, count] of Object.entries(result.errors).sort((a, b) => b[1] - a[1])) {
      console.log(`    ${label}: ${count}`);
    }
  }

  console.log('');
}

function printSummaryTable(results: LoadTestResult[]): void {
  const scenarioWidth = Math.max('Scenario'.length, ...results.map((result) => result.scenario.length));
  const rpsWidth = Math.max('RPS'.length, ...results.map((result) => result.rps.toFixed(1).length));
  const p50Width = Math.max('p50'.length, ...results.map((result) => formatMs(result.latency.p50).length));
  const p95Width = Math.max('p95'.length, ...results.map((result) => formatMs(result.latency.p95).length));
  const p99Width = Math.max('p99'.length, ...results.map((result) => formatMs(result.latency.p99).length));
  const errorsWidth = Math.max(
    'Errors'.length,
    ...results.map((result) => `${percentage(result.errorCount, result.totalRequests)}%`.length)
  );

  const row = (values: string[]): string => {
    return `  ${values[0].padEnd(scenarioWidth)} | ${values[1].padEnd(rpsWidth)} | ${values[2].padEnd(p50Width)} | ${values[3].padEnd(p95Width)} | ${values[4].padEnd(p99Width)} | ${values[5].padEnd(errorsWidth)}`;
  };

  console.log('=== Summary ===');
  console.log(row(['Scenario', 'RPS', 'p50', 'p95', 'p99', 'Errors']));

  for (const result of results) {
    console.log(
      row([
        result.scenario,
        result.rps.toFixed(1),
        formatMs(result.latency.p50),
        formatMs(result.latency.p95),
        formatMs(result.latency.p99),
        `${percentage(result.errorCount, result.totalRequests)}%`,
      ])
    );
  }

  console.log('');
}

async function main(): Promise<void> {
  const { targetUrl, concurrency, durationMs, scenario } = loadConfigFromEnvAndArgs();

  console.log('\nLoad Test Configuration:');
  console.log(`  Target:      ${targetUrl}`);
  console.log(`  Concurrency: ${concurrency}`);
  console.log(`  Duration:    ${durationMs}ms`);
  console.log(`  Scenario:    ${scenario}\n`);

  const scenarios: Scenario[] = [
    { name: 'health', path: '/api/health', method: 'GET', body: null },
    { name: 'services', path: '/api/services', method: 'GET', body: null },
    { name: 'tools-list', path: '/api/tools', method: 'GET', body: null },
    { name: 'policy', path: '/api/deploy/policy', method: 'GET', body: null },
    { name: 'deploy-status', path: '/api/deploy/status', method: 'GET', body: null },
  ];

  const selectedScenario = scenario.toLowerCase();
  const toRun =
    selectedScenario === 'all'
      ? scenarios
      : scenarios.filter((candidate) => candidate.name === selectedScenario);

  if (toRun.length === 0) {
    console.error(`Unknown scenario: ${scenario}`);
    console.error(`Available scenarios: ${['all', ...scenarios.map((candidate) => candidate.name)].join(', ')}`);
    process.exitCode = 1;
    return;
  }

  const results: LoadTestResult[] = [];
  for (const scenarioConfig of toRun) {
    const result = await runScenario(
      scenarioConfig.name,
      `${targetUrl}${scenarioConfig.path}`,
      scenarioConfig.method,
      scenarioConfig.body,
      concurrency,
      durationMs
    );
    results.push(result);
    printResult(result, concurrency);
  }

  if (results.length > 1) {
    printSummaryTable(results);
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Load test failed: ${message}`);
  process.exit(1);
});

export { percentile, formatMs, printSummaryTable, runScenario };
export type { LoadTestResult };
