import { describe, it, expect } from 'vitest';
import { transition, canTransition, TransitionError, type ArtifactState } from '../src/domain/state';

const HUMAN = { actor: 'veronica@example.com' };
const CLEAN = { lintStatus: 'pass' as const, allSegmentsLinked: true };

describe('approval state machine', () => {
  it('walks the happy path draft -> published', () => {
    let s: ArtifactState = 'draft';
    s = transition(s, 'generate', { actor: null });
    expect(s).toBe('generated');
    s = transition(s, 'submit_for_review', { actor: null, ...CLEAN });
    expect(s).toBe('in_review');
    s = transition(s, 'approve', HUMAN);
    expect(s).toBe('approved');
    s = transition(s, 'publish', HUMAN);
    expect(s).toBe('published');
  });

  // ---- THE CENTRAL GUARANTEE -------------------------------------------
  // If this test ever passes with a shorter path, the product is broken.
  it('has NO path from generated to published without a human approval', () => {
    const events = [
      'generate',
      'submit_for_review',
      'approve',
      'reject',
      'publish',
      'revise',
    ] as const;

    // Exhaustively explore every reachable state using ONLY machine identity
    // (actor: null) and confirm `published` is unreachable.
    const reachable = new Set<ArtifactState>(['draft']);
    const queue: ArtifactState[] = ['draft'];
    while (queue.length) {
      const from = queue.pop()!;
      for (const ev of events) {
        try {
          const to = transition(from, ev, { actor: null, ...CLEAN });
          if (!reachable.has(to)) {
            reachable.add(to);
            queue.push(to);
          }
        } catch {
          /* refused, as intended */
        }
      }
    }
    expect(reachable.has('published')).toBe(false);
    expect(reachable.has('approved')).toBe(false);
  });

  it('refuses approve/reject/publish without an authenticated actor', () => {
    expect(() => transition('in_review', 'approve', { actor: null })).toThrow(TransitionError);
    expect(() => transition('in_review', 'approve', { actor: '   ' })).toThrow(TransitionError);
    expect(() => transition('in_review', 'reject', { actor: '' })).toThrow(TransitionError);
    expect(() => transition('approved', 'publish', { actor: null })).toThrow(TransitionError);
  });

  it('refuses approval by a machine identity', () => {
    expect(() => transition('in_review', 'approve', { actor: 'system:generator' })).toThrow(
      /cannot be performed by a machine identity/,
    );
    expect(() => transition('in_review', 'approve', { actor: 'service:bot' })).toThrow(
      TransitionError,
    );
  });

  it('cannot publish directly from in_review, skipping approval', () => {
    expect(() => transition('in_review', 'publish', HUMAN)).toThrow(/illegal transition/);
  });

  it('cannot re-publish or mutate a published artifact', () => {
    for (const ev of ['generate', 'submit_for_review', 'approve', 'publish', 'revise'] as const) {
      expect(canTransition('published', ev, HUMAN)).toBe(false);
    }
  });

  it('blocks review when the linter has not passed', () => {
    expect(() =>
      transition('generated', 'submit_for_review', {
        actor: null,
        lintStatus: 'fail',
        allSegmentsLinked: true,
      }),
    ).toThrow(/compliance lint has not passed/);
  });

  it('blocks review when any segment is unlinked', () => {
    expect(() =>
      transition('generated', 'submit_for_review', {
        actor: null,
        lintStatus: 'pass',
        allSegmentsLinked: false,
      }),
    ).toThrow(/not linked to an approved claim/);
  });

  it('a rejected artifact returns to draft rather than un-rejecting in place', () => {
    expect(transition('rejected', 'revise', HUMAN)).toBe('draft');
    expect(canTransition('rejected', 'approve', HUMAN)).toBe(false);
  });
});
