/** @fileoverview The guest page: loads the event, then queues and uploads the picked files. */
import { applyDisplay, thanksMessage } from './display';
import { requireElement } from './dom';
import { eventTokenFromPath, loadEvent } from './event';
import { loadGuestName, loadPin, saveGuestName, savePin } from './guest';
import { pickerAccept, resolveContentType } from './mime';
import { JobQueue } from './queue';
import { localSessionStorage, SessionManager } from './session';
import { createTurnstile } from './turnstile';
import { fingerprint, loadUploaded, rememberUploaded, uploadedEntry } from './uploaded';
import {
  failureMessage,
  isRetryable,
  PIN_ERRORS,
  postWithProgress,
  requestPresign,
  SESSION_ERRORS,
  type UploadFailure,
} from './upload';

type Status = 'queued' | 'uploading' | 'retrying' | 'done' | 'failed' | 'skipped';

interface Job {
  file: File;
  contentType: string | null;
  /** Identifies the file under the guest's name once fingerprinted (uploaded.ts). */
  uploadedEntry: string | null;
  status: Status;
  progress: number;
  error?: string;
  el: HTMLLIElement;
}

/** A job for a supported file type: only these are ever queued. */
interface UploadJob extends Job {
  contentType: string;
}

function isUploadJob(job: Job): job is UploadJob {
  return job.contentType !== null;
}

const token = eventTokenFromPath(location.pathname);
const blocked = requireElement(document, '#blocked');
const uploader = requireElement(document, '#uploader');
const pinField = requireElement(document, '#pin-field');
const pinInput = requireElement<HTMLInputElement>(document, '#pin');
const nameInput = requireElement<HTMLInputElement>(document, '#guest-name');
const fileInput = requireElement<HTMLInputElement>(document, '#files');
fileInput.accept = pickerAccept(navigator.userAgent);
const progressSection = requireElement(document, '#progress');
const summaryText = requireElement(document, '#summary-text');
const overallBar = requireElement(document, '#overall-bar');
const retryButton = requireElement<HTMLButtonElement>(document, '#retry-failed');
const keepOpen = requireElement(document, '#keep-open');
const thanks = requireElement(document, '#thanks');
const list = requireElement<HTMLUListElement>(document, '#file-list');

const jobs: Job[] = [];

// ---------- event: show the uploader only for a valid, open event ----------
let requiresPin = false;
let sessions: SessionManager | null = null;
let customThanks: string | undefined;

void (async () => {
  const lookup = await loadEvent(token);
  const event = lookup.ok ? lookup.value : lookup.error.event;
  if (event) {
    applyDisplay(document, event.name, event.display);
    customThanks = event.display?.thanks;
  }
  if (!lookup.ok) {
    blocked.textContent = lookup.error.message;
    blocked.hidden = false;
    return;
  }
  // loadEvent only succeeds for a token, so this never returns; it narrows `token`.
  if (!token) return;
  requiresPin = lookup.value.requiresPin;
  sessions = new SessionManager({
    eventToken: token,
    getPin: () => pinInput.value.trim(),
    getTurnstileToken: createTurnstile(
      lookup.value.turnstileSiteKey,
      requireElement(document, '#turnstile'),
    ),
    storage: localSessionStorage(token),
  });
  pinField.hidden = !requiresPin;
  if (requiresPin) pinInput.value = loadPin(token);
  uploader.hidden = false;
})();

// ---------- guest name + PIN ----------
nameInput.value = loadGuestName();
nameInput.addEventListener('change', () => {
  saveGuestName(nameInput.value.trim());
});
pinInput.addEventListener('change', () => {
  if (token) savePin(token, pinInput.value.trim());
});
pinInput.addEventListener('input', () => {
  pinInput.setCustomValidity('');
});

// ---------- queue ----------
const queue = new JobQueue<UploadJob, UploadFailure>(
  async (job) => {
    if (!sessions) throw new Error('an upload started before the event loaded');
    const session = await sessions.ensure();
    if (!session.ok) return session;
    const post = await requestPresign({
      file: job.file,
      contentType: job.contentType,
      session: session.value,
      guestName: nameInput.value.trim(),
    });
    if (!post.ok) {
      // Expired/revoked session: forget it; the retry creates a fresh one.
      if (post.error.kind === 'api-refused' && SESSION_ERRORS.has(post.error.code)) {
        sessions.clear();
      }
      return post;
    }
    return postWithProgress(post.value, job.file, (fraction) => {
      job.progress = fraction;
      render(job);
    });
  },
  {
    concurrency: 3,
    retries: 3,
    backoffMs: (retry) => 1000 * 3 ** (retry - 1), // 1s, 3s, 9s
    isRetryable,
  },
  {
    onStart: (job) => {
      update(job, { status: 'uploading', progress: 0, error: undefined });
    },
    onRetry: (job, retry) => {
      update(job, { status: 'retrying', error: `retrying (${retry}/3)…` });
    },
    onSuccess: (job) => {
      if (token && job.uploadedEntry !== null) rememberUploaded(token, job.uploadedEntry);
      update(job, { status: 'done', progress: 1 });
    },
    onFailure: (job, error) => {
      update(job, { status: 'failed', error: failureMessage(error) });
      if (error.kind === 'api-refused' && PIN_ERRORS.has(error.code)) {
        pinField.hidden = false;
        pinInput.focus();
      }
    },
    onCrash: (job, error) => {
      console.error(error);
      update(job, { status: 'failed', error: 'failed' });
    },
    onIdle: () => {
      void releaseWakeLock();
      renderSummary();
    },
  },
);

fileInput.addEventListener('change', () => {
  const files = [...(fileInput.files ?? [])];
  fileInput.value = ''; // allow picking the same files again
  if (files.length === 0) return;
  if (requiresPin && !pinInput.value.trim()) {
    pinInput.focus();
    pinInput.setCustomValidity('Enter the PIN from your card first');
    pinInput.reportValidity();
    return;
  }

  const added = files.map((file) => createJob(file));
  progressSection.hidden = false;
  renderSummary();
  void enqueue(added);
});

/** Queues each new file unless it isn't media or this guest already uploaded (or queued) it. */
async function enqueue(added: Job[]): Promise<void> {
  const guestName = nameInput.value.trim();
  const uploaded = token ? loadUploaded(token) : new Set<string>();
  for (const job of added) {
    if (!isUploadJob(job)) {
      update(job, { status: 'failed', error: 'not a photo or video' });
      continue;
    }
    const print = await fingerprint(job.file);
    job.uploadedEntry = print === null ? null : uploadedEntry(guestName, print);
    if (job.uploadedEntry !== null && (uploaded.has(job.uploadedEntry) || isRepeat(job))) {
      update(job, { status: 'skipped' });
      continue;
    }
    void acquireWakeLock();
    queue.add(job);
  }
  renderSummary();
}

/** True when another job for the same file is waiting, uploading or done. */
function isRepeat(job: Job): boolean {
  return jobs.some(
    (other) =>
      other !== job &&
      other.uploadedEntry === job.uploadedEntry &&
      other.status !== 'failed' &&
      other.status !== 'skipped',
  );
}

retryButton.addEventListener('click', () => {
  const retryable = jobs.filter(isUploadJob).filter((j) => j.status === 'failed');
  for (const job of retryable) {
    update(job, { status: 'queued', progress: 0, error: undefined });
  }
  if (retryable.length) {
    void acquireWakeLock();
    queue.add(...retryable);
  }
});

window.addEventListener('beforeunload', (e) => {
  if (queue.busy) e.preventDefault(); // browsers show their own "leave site?" prompt
});

// ---------- rendering ----------
function createJob(file: File): Job {
  const el = document.createElement('li');
  el.innerHTML = `
    <div class="row"><span class="name"></span><span class="state"></span></div>
    <div class="bar"><div></div></div>`;
  requireElement(el, '.name').textContent = `${file.name} · ${formatSize(file.size)}`;
  list.prepend(el);
  const job: Job = {
    file,
    contentType: resolveContentType(file),
    uploadedEntry: null,
    status: 'queued',
    progress: 0,
    el,
  };
  jobs.push(job);
  render(job);
  return job;
}

function update(job: Job, patch: Partial<Job>): void {
  Object.assign(job, patch);
  render(job);
  renderSummary();
}

function render(job: Job): void {
  job.el.className = `file ${job.status}`;
  const labels: Record<Status, string> = {
    queued: 'waiting',
    uploading: `${Math.round(job.progress * 100)}%`,
    retrying: job.error ?? 'retrying…',
    done: 'uploaded ✓',
    failed: job.error ?? 'failed',
    skipped: 'already uploaded',
  };
  requireElement(job.el, '.state').textContent = labels[job.status];
  requireElement(job.el, '.bar > div').style.width = `${job.progress * 100}%`;
  if (job.status === 'uploading') renderOverall();
}

function renderOverall(): void {
  const sending = jobs.filter((j) => j.contentType && j.status !== 'skipped');
  const total = sending.reduce((sum, j) => sum + j.file.size, 0);
  const sent = sending.reduce((sum, j) => sum + j.file.size * j.progress, 0);
  overallBar.style.width = total ? `${(sent / total) * 100}%` : '0';
}

function renderSummary(): void {
  const done = jobs.filter((j) => j.status === 'done').length;
  const failed = jobs.filter((j) => j.status === 'failed').length;
  const skipped = jobs.filter((j) => j.status === 'skipped').length;
  const busy = queue.busy;

  const failedNote = failed ? ` · ${failed} failed` : '';
  const skippedNote = skipped ? ` · ${skipped} already uploaded` : '';
  summaryText.textContent = `${done} of ${jobs.length - skipped} uploaded${failedNote}${skippedNote}`;
  retryButton.hidden = busy || !jobs.some((j) => j.status === 'failed' && j.contentType);
  keepOpen.hidden = !busy;
  thanks.hidden = busy || done === 0;
  thanks.textContent = thanksMessage(done, failed, customThanks);
  renderOverall();
}

function formatSize(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

// ---------- keep the screen awake while uploading (phones pause uploads when locked) ----------
let wakeLock: WakeLockSentinel | null = null;

async function acquireWakeLock(): Promise<void> {
  try {
    wakeLock ??= (await navigator.wakeLock?.request('screen')) ?? null;
    wakeLock?.addEventListener('release', () => {
      wakeLock = null;
    });
  } catch {
    // Unsupported or denied (e.g. low battery); uploads still work.
  }
}

async function releaseWakeLock(): Promise<void> {
  await wakeLock?.release().catch(() => undefined);
  wakeLock = null;
}

document.addEventListener('visibilitychange', () => {
  // The lock is dropped whenever the page is hidden; re-take it on return if still uploading.
  if (document.visibilityState === 'visible' && queue.busy) void acquireWakeLock();
});

// ---------- dev diagnostics footer ----------

void (async () => {
  const footer = requireElement(document, '#api');
  try {
    const res = await fetch('/api/health', { cache: 'no-store' });
    const body: unknown = await res.json();
    const stage =
      typeof body === 'object' && body !== null && 'stage' in body ? String(body.stage) : '?';
    if (stage !== 'prod') footer.textContent = ` · API ok (${stage})`;
  } catch {
    // Unreachable, or not JSON: either way the footer says so.
    footer.textContent = ' · API unreachable';
  }
})();
