# Hold benchmark

Run with `npm run bench`. The script uses `holdfast_test`, truncates it between
samples, and refuses to run against a database whose name does not contain
`_test`.

## Environment

- Date: 2026-10-25
- CPU: 12th Gen Intel Core i5-1235U (12 logical CPUs)
- Node: v22.22.1
- PostgreSQL: 17, Docker Compose service on localhost
- Connection pool: 20
- Raw results: `bench/results.json`

## Workload

| Scenario | Buyers | Units | Expected result |
|---|---:|---:|---|
| Specific unit, 1 buyer | 1 | 1 | 1 hold |
| Any N, 1 buyer | 1 | 1 | 1 hold |
| Specific unit, contention | 1,000 | 100 | 100 holds, 900 conflicts |
| Any N, contention | 1,000 | 100 | 100 holds, 900 conflicts |

Each `1000` row runs 5 batches. The `1` row runs 100 batches. The reported
time covers the hold calls only; database reset and fixture insertion happen
before the timer starts. The 1,000-buyer throughput includes the 900 rejected
calls, so it measures completion rate, not successful holds per second.

## Results

| Strategy | Buyers | Units | Wins | Mean batch | p50 | p95 | Mean per buyer | Buyers/sec |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Specific | 1 | 1 | 1 | 10.65 ms | 10.54 ms | 12.83 ms | 10.65 ms | 94 |
| Any N | 1 | 1 | 1 | 9.12 ms | 9.16 ms | 12.00 ms | 9.12 ms | 110 |
| Specific | 1,000 | 100 | 100 | 1,507.30 ms | 1,402.75 ms | 1,806.45 ms | 1.51 ms | 663 |
| Any N | 1,000 | 100 | 100 | 1,669.28 ms | 1,691.34 ms | 1,784.20 ms | 1.67 ms | 599 |

## What the numbers say

- At one buyer the two paths are effectively tied; the 1.5 ms difference is
  within run-to-run noise.
- At 1,000 buyers for 100 units, the specific-unit path was about 10% faster
  in this run. The losing specific-unit buyers wait on a row lock and then fail
  as soon as the winner commits. The losing any-N buyers skip locked rows, run
  the non-locking count check, and sleep for 20-100 ms before retrying, so they
  do more total work.
- `SKIP LOCKED` is expected to pull ahead when winning transactions hold locks
  for longer, or when there is enough inventory that buyers rarely collide.
  This microbenchmark has sub-2 ms transactions, so queueing is cheap.
- Both contention runs produced exactly 100 holds and passed the invariant
  checker. The benchmark aborts on any unexpected success count, non-conflict
  error, or invariant failure.

## Caveat

The retry cap is deliberately finite. A separate all-success run with 1,000
buyers competing for 1,000 units occasionally left a handful of units unclaimed
when the last buyers exhausted their retries while other transactions held the
remaining rows. That is the documented tradeoff of a capped retry: under
extreme, short-lived contention the buyer can receive a 409 even though another
transaction later releases stock. The 100-unit contention scenario above is the
M1 test workload, where both strategies have the same 100 winners.
