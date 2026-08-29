/**
 * The approval state machine.
 *
 * This file is the reason the project exists. In a regulated review workflow,
 * "a human must approve before it ships" cannot be a policy in a runbook or a
 * sentence in a system prompt, because both of those are things a busy person
 * or a confident model can route around. It has to be a property of the code:
 * there is no sequence of API calls that reaches `published` without an
 * authenticated human approval event having been recorded first.
 *
 * Everything else in the app is replaceable. This is not.
 */

export type ArtifactState =
  | 'draft'
  | 'generated'
  | 'in_review'
  | 'approved'
  | 'published'
  | 'rejected';

export type TransitionEvent =
  | 'generate'
  | 'submit_for_review'
  | 'approve'
  | 'reject'
  | 'publish'
  | 'revise';

export interface TransitionContext {
  /** Authenticated identity. `null` means the caller could not be identified. */
  actor: string | null;
  /** Result of the deterministic compliance linter, if it has been run. */
  lintStatus?: 'pass' | 'fail' | null;
  /** True when every generated segment resolves to an approved claim. */
  allSegmentsLinked?: boolean;
}

export class TransitionError extends Error {
  // Plain fields rather than TS parameter properties, so this module also runs
  // under Node's type-stripping (see scripts/verify-llm.ts).
  from: ArtifactState;
  event: TransitionEvent;
  constructor(message: string, from: ArtifactState, event: TransitionEvent) {
    super(message);
    this.name = 'TransitionError';
    this.from = from;
    this.event = event;
  }
}

/** Transitions that REQUIRE an authenticated human. Machines cannot perform these. */
const HUMAN_ONLY: ReadonlySet<TransitionEvent> = new Set(['approve', 'reject', 'publish']);

const EDGES: Record<ArtifactState, Partial<Record<TransitionEvent, ArtifactState>>> = {
  draft: { generate: 'generated' },
  generated: { submit_for_review: 'in_review', revise: 'draft' },
  in_review: { approve: 'approved', reject: 'rejected' },
  approved: { publish: 'published', revise: 'draft' },
  // Terminal for this artifact. Revising forks back to draft; it never
  // "un-rejects" in place, so the rejection stays in the audit trail.
  rejected: { revise: 'draft' },
  published: {},
};

/**
 * The single choke point. Every state change in the application goes through
 * here; nothing writes `artifacts.state` directly.
 *
 * Fails CLOSED: an unknown edge, a missing actor on a human-only event, or an
 * unverified artifact is refused rather than allowed with a warning.
 */
export function transition(
  from: ArtifactState,
  event: TransitionEvent,
  ctx: TransitionContext,
): ArtifactState {
  const to = EDGES[from]?.[event];
  if (!to) {
    throw new TransitionError(`illegal transition: ${from} --${event}--> (none)`, from, event);
  }

  // 1. Human-only events need a real, authenticated identity. An empty string,
  //    whitespace, or a service principal is not a person.
  if (HUMAN_ONLY.has(event)) {
    const actor = ctx.actor?.trim();
    if (!actor) {
      throw new TransitionError(
        `${event} requires an authenticated human actor`,
        from,
        event,
      );
    }
    if (actor.startsWith('system:') || actor.startsWith('service:')) {
      throw new TransitionError(
        `${event} cannot be performed by a machine identity (${actor})`,
        from,
        event,
      );
    }
  }

  // 2. Nothing enters review until the deterministic linter has passed AND
  //    every segment is traceable to an approved claim. A reviewer should never
  //    be shown copy that we already know is unsubstantiated.
  if (event === 'submit_for_review') {
    if (ctx.lintStatus !== 'pass') {
      throw new TransitionError(
        'cannot submit for review: compliance lint has not passed',
        from,
        event,
      );
    }
    if (ctx.allSegmentsLinked !== true) {
      throw new TransitionError(
        'cannot submit for review: at least one segment is not linked to an approved claim',
        from,
        event,
      );
    }
  }

  return to;
}

/**
 * Convenience predicate used by tests and the UI. Deliberately derived from
 * `transition` rather than re-stating the rules, so the two cannot drift apart.
 */
export function canTransition(
  from: ArtifactState,
  event: TransitionEvent,
  ctx: TransitionContext,
): boolean {
  try {
    transition(from, event, ctx);
    return true;
  } catch {
    return false;
  }
}
