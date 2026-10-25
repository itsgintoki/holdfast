const MIN_RETRY_MS = 20;
const MAX_RETRY_MS = 100;

export const MAX_TRANSACTION_ATTEMPTS = 3;

export function isDeadlockError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }

  const code = (error as { code?: unknown }).code;
  if (code === '40P01') {
    return true;
  }

  return isDeadlockError((error as { cause?: unknown }).cause);
}

export function retryDelayMs(): number {
  return MIN_RETRY_MS + Math.random() * (MAX_RETRY_MS - MIN_RETRY_MS);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A deadlock is safe to retry because Postgres has already rolled back the
 * whole transaction. Retrying must happen outside the failed transaction.
 */
export async function withDeadlockRetry<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 1; attempt <= MAX_TRANSACTION_ATTEMPTS; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (attempt === MAX_TRANSACTION_ATTEMPTS || !isDeadlockError(error)) {
        throw error;
      }
      await sleep(retryDelayMs());
    }
  }

  throw new Error('unreachable: retry loop exited without returning or throwing');
}
