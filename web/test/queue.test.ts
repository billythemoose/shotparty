import { describe, expect, it, vi } from 'vitest';
import { JobQueue, type QueueOptions } from '../src/queue';
import { err, ok, type Result } from '../src/result';

interface TestFailure {
  kind: 'test-failure';
  retryable: boolean;
}

function flush(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

function deferred(): Deferred {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function fail(retryable: boolean): Result<void, TestFailure> {
  return err({ kind: 'test-failure', retryable });
}

const baseOpts: QueueOptions<TestFailure> = {
  concurrency: 3,
  retries: 3,
  backoffMs: (n) => 1000 * 3 ** (n - 1),
  isRetryable: (e) => e.retryable,
  sleep: () => Promise.resolve(),
};

describe('JobQueue', () => {
  it('never runs more than `concurrency` jobs at once', async () => {
    const gates = new Map<number, Deferred>();
    let running = 0;
    let peak = 0;
    const queue = new JobQueue<number, TestFailure>(async (n) => {
      running++;
      peak = Math.max(peak, running);
      const gate = deferred();
      gates.set(n, gate);
      await gate.promise.finally(() => {
        running--;
      });
      return ok(undefined);
    }, baseOpts);

    queue.add(1, 2, 3, 4, 5);
    await flush();
    expect(running).toBe(3);
    gates.get(1)!.resolve();
    await flush();
    expect(running).toBe(3); // job 4 started
    for (const g of gates.values()) {
      g.resolve();
    }
    await flush();
    await flush();
    for (const g of gates.values()) {
      g.resolve();
    }
    await flush();
    expect(peak).toBe(3);
    expect(queue.busy).toBe(false);
  });

  it('retries retryable failures with backoff, then succeeds', async () => {
    const sleep = vi.fn<(ms: number) => Promise<void>>(() => Promise.resolve());
    const onRetry = vi.fn();
    const onSuccess = vi.fn();
    let calls = 0;
    const queue = new JobQueue<string, TestFailure>(
      async () => (++calls < 3 ? fail(true) : ok(undefined)),
      { ...baseOpts, sleep },
      { onRetry, onSuccess },
    );
    queue.add('a');
    await vi.waitFor(() => expect(onSuccess).toHaveBeenCalledWith('a'));
    expect(calls).toBe(3);
    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([1000, 3000]);
  });

  it('gives up after the retry budget (4 attempts total)', async () => {
    const onFailure = vi.fn();
    let calls = 0;
    const queue = new JobQueue<string, TestFailure>(
      async () => {
        calls++;
        return fail(true);
      },
      baseOpts,
      { onFailure },
    );
    queue.add('a');
    await vi.waitFor(() =>
      expect(onFailure).toHaveBeenCalledWith('a', { kind: 'test-failure', retryable: true }),
    );
    expect(calls).toBe(4);
  });

  it('does not retry permanent failures', async () => {
    const onFailure = vi.fn();
    let calls = 0;
    const queue = new JobQueue<string, TestFailure>(
      async () => {
        calls++;
        return fail(false);
      },
      baseOpts,
      { onFailure },
    );
    queue.add('a');
    await vi.waitFor(() => expect(onFailure).toHaveBeenCalled());
    expect(calls).toBe(1);
  });

  it('reports a worker that throws (a bug) as a crash, without retrying', async () => {
    const onCrash = vi.fn();
    const onFailure = vi.fn();
    let calls = 0;
    const queue = new JobQueue<string, TestFailure>(
      async () => {
        calls++;
        throw new Error('boom');
      },
      baseOpts,
      { onCrash, onFailure },
    );
    queue.add('a');
    await vi.waitFor(() => expect(onCrash).toHaveBeenCalledWith('a', new Error('boom')));
    expect(calls).toBe(1);
    expect(onFailure).not.toHaveBeenCalled();
    expect(queue.busy).toBe(false);
  });

  it('accepts new jobs while running and reports idle once at the end', async () => {
    const onIdle = vi.fn();
    const done: string[] = [];
    const queue = new JobQueue<string, TestFailure>(
      async (j) => {
        await flush();
        done.push(j);
        return ok(undefined);
      },
      baseOpts,
      { onIdle },
    );
    queue.add('a');
    queue.add('b');
    await vi.waitFor(() => expect(onIdle).toHaveBeenCalledTimes(1));
    expect(done.sort()).toEqual(['a', 'b']);
  });
});
