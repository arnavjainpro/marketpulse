// Serializes Claude API calls with a minimum gap between starts, so a burst of
// detected events (e.g. a news spike across the watchlist) doesn't slam the API
// concurrently and trip rate limits. The SDK's built-in retry (2x, honors
// retry-after) still handles any 429 that gets through.
export function createThrottle(minGapMs: number) {
  let lastStart = 0;
  let chain: Promise<unknown> = Promise.resolve();

  return function throttled<T>(fn: () => Promise<T>): Promise<T> {
    const run = chain.then(async () => {
      const wait = lastStart + minGapMs - Date.now();
      if (wait > 0) await Bun.sleep(wait);
      lastStart = Date.now();
      return fn();
    });
    chain = run.catch(() => {});
    return run;
  };
}

// One shared queue for all Claude traffic (triage + analysis + briefings),
// spaced 350ms apart — ~3 calls/sec worst case.
export const claudeQueue = createThrottle(350);
