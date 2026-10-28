/**
 * @fileoverview Decides whether a CloudFormation change set is safe to execute without a human
 * reading it. Interactive deploys show the change set and ask; unattended ones (setup, CI) go
 * through this.
 */
import type { StackKind } from './deploy-params.js';

/** One resource change in a CloudFormation change set. */
export interface ResourceChange {
  Action?: string; // Add | Modify | Remove | Import | Dynamic
  LogicalResourceId?: string;
  ResourceType?: string;
  Replacement?: string; // True | False | Conditional
}

/**
 * App-stack resources whose replacement breaks things guests rely on: a new distribution gets a new
 * *.cloudfront.net URL, so every printed QR code would point at nothing.
 */
const PROTECTED_APP_RESOURCES = new Set(['Distribution']);

/**
 * Human-readable reasons to refuse; empty means safe to execute unattended. Nothing in the account
 * stack is protected: its only resource is the account budget, which is recreated as it was.
 */
export function riskyChanges(kind: StackKind | 'account', changes: ResourceChange[]): string[] {
  const reasons: string[] = [];
  for (const c of changes) {
    const id = `${c.LogicalResourceId} (${c.ResourceType})`;
    const protectedResource =
      kind === 'data' || (kind === 'app' && PROTECTED_APP_RESOURCES.has(c.LogicalResourceId ?? ''));
    if (!protectedResource) continue;
    if (c.Action === 'Remove') {
      reasons.push(`${id} would be deleted`);
    } else if (c.Replacement === 'True') {
      reasons.push(`${id} would be replaced`);
    } else if (c.Replacement === 'Conditional') {
      reasons.push(`${id} might be replaced`);
    }
  }
  return reasons;
}
