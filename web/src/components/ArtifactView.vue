<script setup lang="ts">
/**
 * Renders the assembled artifact with provenance attached to every sentence.
 *
 * The reviewer never has to ask "where did this come from" — the claim ID, the
 * citation and the anchor are on the sentence itself. An unlinked segment is
 * rendered in an alarm state rather than quietly shown as normal copy.
 */
defineProps<{
  artifact: any;
  segments: any[];
  lint: any;
}>();
</script>

<template>
  <div>
    <div class="meta-grid">
      <div><span>Artifact</span><code>{{ artifact.id }}</code></div>
      <div><span>Prompt version</span><code>{{ artifact.prompt_version ?? '—' }}</code></div>
      <div><span>Model (pinned)</span><code>{{ artifact.model_id ?? '—' }}</code></div>
      <div><span>Snapshot</span><code class="wrap">{{ artifact.snapshot_key ?? '—' }}</code></div>
    </div>

    <ol class="segments">
      <li v-for="s in segments" :key="s.ordinal" :class="{ unlinked: !s.claim_id }">
        <p class="text">{{ s.text }}</p>
        <p v-if="s.claim_id" class="prov">
          <code>{{ s.claim_id }}</code>
          <span v-if="s.claim_type === 'safety'" class="tag safety">safety</span>
          <span class="cite">{{ s.citation }} &mdash; {{ s.anchor }}</span>
        </p>
        <p v-else class="prov danger">
          Unlinked. Nothing substantiates this sentence, so it cannot be approved.
        </p>
      </li>
    </ol>

    <div v-if="lint" class="lint" :class="lint.status">
      <strong>Compliance lint: {{ lint.status.toUpperCase() }}</strong>
      <span class="hint"> (deterministic, not model-judged)</span>
      <ul v-if="lint.findings?.length">
        <li v-for="(f, i) in lint.findings" :key="i" :class="f.severity">
          <code>{{ f.rule }}</code>
          <span v-if="f.ordinal"> &middot; segment {{ f.ordinal }}</span>
          &mdash; {{ f.message }}
        </li>
      </ul>
      <p v-else class="hint">No findings.</p>
    </div>
  </div>
</template>
