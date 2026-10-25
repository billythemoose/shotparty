/**
 * @fileoverview Runs upload jobs with bounded concurrency and retries transient failures with
 * backoff. Jobs can be added while the queue is running (guests often pick more photos mid-upload).
 */
import { assertIsError, type Result } from './result';

/** How the queue runs jobs. */
export interface QueueOptions<E> {
  concurrency: number;
  /** Retries after the first attempt; 3 means up to 4 attempts. */
  retries: number;
  backoffMs: (retry: number) => number;
  isRetryable: (error: E) => boolean;
  sleep?: (ms: number) => Promise<void>;
}

/** Progress callbacks; all optional. */
export interface QueueHooks<T, E> {
  onStart?(job: T, attempt: number): void;
  onRetry?(job: T, retry: number, error: E): void;
  onSuccess?(job: T): void;
  /** The job failed for good: not retryable, or out of retries. */
  onFailure?(job: T, error: E): void;
  /** The worker threw (a bug); the job is not retried. */
  onCrash?(job: T, error: Error): void;
  onIdle?(): void;
}

/** Does one attempt at a job. */
export type Worker<T, E> = (job: T, attempt: number) => Promise<Result<void, E>>;

/** Runs jobs with bounded concurrency, retrying retryable failures with backoff. */
export class JobQueue<T, E> {
  private readonly pending: T[] = [];
  private active = 0;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly worker: Worker<T, E>,
    private readonly opts: QueueOptions<E>,
    private readonly hooks: QueueHooks<T, E> = {},
  ) {
    this.sleep =
      opts.sleep ??
      ((ms) =>
        new Promise((resolve) => {
          setTimeout(resolve, ms);
        }));
  }

  /** Whether any job is running or waiting. */
  get busy(): boolean {
    return this.active > 0 || this.pending.length > 0;
  }

  /** Queues jobs; they start as soon as there is a free slot. */
  add(...jobs: T[]): void {
    this.pending.push(...jobs);
    this.pump();
  }

  private pump(): void {
    while (this.active < this.opts.concurrency) {
      const job = this.pending.shift();
      if (job === undefined) return;
      this.active++;
      void this.run(job).finally(() => {
        this.active--;
        this.pump();
        if (!this.busy) this.hooks.onIdle?.();
      });
    }
  }

  private async run(job: T): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      let result: Result<void, E>;
      try {
        this.hooks.onStart?.(job, attempt);
        result = await this.worker(job, attempt);
      } catch (e: unknown) {
        assertIsError(e);
        this.hooks.onCrash?.(job, e);
        return;
      }
      if (result.ok) {
        this.hooks.onSuccess?.(job);
        return;
      }
      if (attempt >= this.opts.retries || !this.opts.isRetryable(result.error)) {
        this.hooks.onFailure?.(job, result.error);
        return;
      }
      this.hooks.onRetry?.(job, attempt + 1, result.error);
      await this.sleep(this.opts.backoffMs(attempt + 1));
    }
  }
}
