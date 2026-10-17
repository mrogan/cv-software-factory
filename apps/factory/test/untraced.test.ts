import { describe, expect, it } from 'vitest';
import { untracedIncoming, untracedOutgoing } from '../src/untraced.ts';

describe('what the workers leave out of their traces', () => {
  it('leaves out Kubernetes probing /health, and traces every other request in', () => {
    expect(untracedIncoming({ url: '/health' })).toBe(true);
    expect(untracedIncoming({ url: '/v1/smoke' })).toBe(false);
    expect(untracedIncoming({})).toBe(false);
  });

  it('leaves out the release watch reading the Rollout and its AnalysisRuns', () => {
    const base = '/apis/argoproj.io/v1alpha1/namespaces/website';
    expect(untracedOutgoing({ method: 'GET', path: `${base}/rollouts/website` })).toBe(true);
    expect(untracedOutgoing({ method: 'GET', path: `${base}/analysisruns` })).toBe(true);
    // Node's own default, when a request names no method.
    expect(untracedOutgoing({ path: `${base}/analysisruns` })).toBe(true);
  });

  it('traces whatever else it asks of Kubernetes', () => {
    expect(untracedOutgoing({ method: 'GET', path: '/api/v1/namespaces/website/pods?labelSelector=x' })).toBe(false);
    expect(untracedOutgoing({ method: 'GET', path: '/apis/batch/v1/namespaces/runners/jobs/coder-1' })).toBe(false);
    expect(untracedOutgoing({ method: 'POST', path: '/apis/argoproj.io/v1alpha1/namespaces/website/rollouts' })).toBe(
      false,
    );
    expect(untracedOutgoing({ method: 'GET' })).toBe(false);
  });
});
