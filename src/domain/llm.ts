/**
 * OpenAI-COMPATIBLE chat completions client.
 *
 * Written against the wire format rather than a vendor SDK, so the same code
 * runs unchanged against api.openai.com, api.x.ai, an Azure OpenAI deployment,
 * a Cloudflare AI Gateway, or a self-hosted vLLM front end. In a regulated
 * setting the endpoint is usually the customer's own approved gateway, so
 * "which provider" has to be configuration, not a dependency.
 *
 * The model is asked to SELECT claim IDs, not to write prose. That is what
 * keeps the output substantiable: the worst a bad generation can do is pick a
 * poor set or order, which the linter and the reviewer both catch. It cannot
 * invent a sentence, because sentences do not come from it.
 */

export interface LlmConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
}

export interface LlmCall {
  request: unknown;
  response: unknown;
  /** Claim IDs the model selected, in the order it chose. */
  claimIds: string[];
  finishReason: string | null;
  usage: unknown;
}

export interface ClaimOffer {
  id: string;
  claim_text: string;
  claim_type: string;
}

export class LlmError extends Error {
  // Plain fields rather than TS parameter properties, so this module also runs
  // under Node's type-stripping (see scripts/verify-llm.ts).
  status?: number;
  body?: string;
  constructor(message: string, status?: number, body?: string) {
    super(message);
    this.name = 'LlmError';
    this.status = status;
    this.body = body;
  }
}

export async function selectClaims(
  cfg: LlmConfig,
  systemPrompt: string,
  brief: string,
  channel: string,
  claims: ClaimOffer[],
): Promise<LlmCall> {
  const userContent = JSON.stringify(
    {
      brief,
      channel,
      // Only approved, in-scope claims are ever put in front of the model.
      // Filtering here rather than instructing the model not to use retired
      // claims means a retired claim cannot be selected even if the prompt
      // is ignored entirely.
      claims: claims.map((c) => ({ id: c.id, text: c.claim_text, type: c.claim_type })),
    },
    null,
    2,
  );

  const request = {
    model: cfg.model,
    temperature: cfg.temperature,
    // Deterministic-ish output matters more than variety here. Temperature 0
    // does not make an LLM deterministic, which is exactly why the audit trail
    // records the request and response rather than assuming reproducibility.
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent },
    ],
  };

  const res = await fetch(`${cfg.baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify(request),
  });

  const raw = await res.text();
  if (!res.ok) {
    throw new LlmError(`LLM call failed with ${res.status}`, res.status, raw.slice(0, 2000));
  }

  let response: any;
  try {
    response = JSON.parse(raw);
  } catch {
    throw new LlmError('LLM returned non-JSON body', res.status, raw.slice(0, 2000));
  }

  const content = response?.choices?.[0]?.message?.content ?? '';
  const claimIds = parseClaimIds(content);

  return {
    request,
    response,
    claimIds,
    finishReason: response?.choices?.[0]?.finish_reason ?? null,
    usage: response?.usage ?? null,
  };
}

/**
 * Parse the model's selection defensively. A malformed reply yields an empty
 * selection, which fails the linter and stops the artifact, rather than
 * throwing an opaque error or silently producing a partial asset.
 */
export function parseClaimIds(content: string): string[] {
  if (!content) return [];
  let parsed: any;
  try {
    parsed = JSON.parse(content);
  } catch {
    // Some gateways wrap JSON in a fenced block. Recover the outermost object.
    const m = content.match(/\{[\s\S]*\}/);
    if (!m) return [];
    try {
      parsed = JSON.parse(m[0]);
    } catch {
      return [];
    }
  }
  const segments = parsed?.segments;
  if (!Array.isArray(segments)) return [];
  return segments
    .map((s: any) => (typeof s === 'string' ? s : s?.claim_id))
    .filter((id: unknown): id is string => typeof id === 'string' && /^CLM-[\w-]+$/.test(id));
}
