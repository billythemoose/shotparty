/** @fileoverview The /api/health response, kept pure for testing. */

/** The /api/health response body. */
export interface HealthBody {
  status: 'ok';
  stage: string;
  mediaBucket: string;
  time: string;
}

/** Returns the health body for this deployment. */
export function healthBody(stage: string, mediaBucket: string, now: Date = new Date()): HealthBody {
  return { status: 'ok', stage, mediaBucket, time: now.toISOString() };
}
