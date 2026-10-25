import { writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import process from 'node:process';

const databaseUrl =
  process.env.BENCH_DATABASE_URL ??
  'postgres://holdfast:holdfast@localhost:5432/holdfast_test';

if (!databaseUrl.includes('_test')) {
  throw new Error('Refusing to benchmark against a non-test database');
}

process.env.DATABASE_URL = databaseUrl;
process.env.DB_POOL_MAX ??= '20';

const [
  { pool },
  { holdSeats },
  { holdAnySeats },
  { SeatsUnavailableError },
  { resetDb, seedEvent },
  { assertEventInvariants },
] = await Promise.all([
  import('../src/db/client'),
  import('../src/holds/holdSeats'),
  import('../src/holds/holdAnySeats'),
  import('../src/errors'),
  import('../test/helpers'),
  import('../test/invariants'),
]);

type Strategy = 'specific' | 'any-N';

type Scenario = {
  strategy: Strategy;
  buyers: number;
  inventory: number;
  samples: number;
};

type Result = Scenario & {
  successes: number;
  meanBatchMs: number;
  p50BatchMs: number;
  p95BatchMs: number;
  maxBatchMs: number;
  meanPerBuyerMs: number;
  buyersPerSecond: number;
};

const scenarios: Scenario[] = [
  { strategy: 'specific', buyers: 1, inventory: 1, samples: 100 },
  { strategy: 'any-N', buyers: 1, inventory: 1, samples: 100 },
  { strategy: 'specific', buyers: 1_000, inventory: 100, samples: 5 },
  { strategy: 'any-N', buyers: 1_000, inventory: 100, samples: 5 },
];

function percentile(sorted: number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1);
  return sorted[index];
}

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

async function runBatch(scenario: Scenario): Promise<{ elapsedMs: number; successes: number }> {
  await resetDb();
  const { tenantId, eventId, unitIds } = await seedEvent(scenario.inventory);
  const expectedSuccesses = Math.min(scenario.buyers, scenario.inventory);

  const started = performance.now();
  const results = await Promise.allSettled(
    Array.from({ length: scenario.buyers }, (_, i) =>
      scenario.strategy === 'specific'
        ? holdSeats({
            tenantId,
            eventId,
            buyerRef: `buyer-${i}`,
            unitIds: [unitIds[i % scenario.inventory]],
          })
        : holdAnySeats({
            tenantId,
            eventId,
            buyerRef: `buyer-${i}`,
            quantity: 1,
          }),
    ),
  );
  const elapsedMs = performance.now() - started;

  const successes = results.filter((result) => result.status === 'fulfilled').length;
  const failures = results.filter(
    (result): result is PromiseRejectedResult => result.status === 'rejected',
  );

  if (successes !== expectedSuccesses) {
    throw new Error(
      `${scenario.strategy}: expected ${expectedSuccesses} successes, got ${successes} (${failures.length} failures)`,
    );
  }

  const unexpectedFailure = failures.find(
    (failure) => !(failure.reason instanceof SeatsUnavailableError),
  );

  if (unexpectedFailure) {
    throw new Error(`${scenario.strategy}: unexpected failure: ${String(unexpectedFailure.reason)}`);
  }

  await assertEventInvariants(eventId);
  return { elapsedMs, successes };
}

async function benchmark(scenario: Scenario): Promise<Result> {
  const durations: number[] = [];

  for (let i = 0; i < scenario.samples; i += 1) {
    const { elapsedMs } = await runBatch(scenario);
    durations.push(elapsedMs);
  }

  const sorted = [...durations].sort((a, b) => a - b);
  const meanBatchMs = mean(durations);

  return {
    ...scenario,
    successes: Math.min(scenario.buyers, scenario.inventory),
    meanBatchMs: round(meanBatchMs),
    p50BatchMs: round(percentile(sorted, 0.5)),
    p95BatchMs: round(percentile(sorted, 0.95)),
    maxBatchMs: round(sorted[sorted.length - 1]),
    meanPerBuyerMs: round(meanBatchMs / scenario.buyers),
    buyersPerSecond: round((scenario.buyers / meanBatchMs) * 1_000),
  };
}

async function warmPool(): Promise<void> {
  await Promise.all(Array.from({ length: 20 }, () => pool.query('select 1')));
}

await warmPool();

const results: Result[] = [];
for (const scenario of scenarios) {
  console.log(
    `running ${scenario.strategy}: ${scenario.buyers.toLocaleString()} buyers, ${scenario.inventory.toLocaleString()} units...`,
  );
  results.push(await benchmark(scenario));
}

const output = {
  generatedAt: new Date().toISOString(),
  databaseUrl,
  poolMax: Number(process.env.DB_POOL_MAX),
  node: process.version,
  results,
};

await writeFile(new URL('./results.json', import.meta.url), `${JSON.stringify(output, null, 2)}\n`);

console.table(
  results.map((result) => ({
    strategy: result.strategy,
    buyers: result.buyers,
    units: result.inventory,
    successes: result.successes,
    samples: result.samples,
    'mean batch ms': result.meanBatchMs,
    'p50 batch ms': result.p50BatchMs,
    'p95 batch ms': result.p95BatchMs,
    'mean/buyer ms': result.meanPerBuyerMs,
    'buyers/sec': result.buyersPerSecond,
  })),
);

await resetDb();
await pool.end();
