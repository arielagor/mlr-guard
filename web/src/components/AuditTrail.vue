<script setup lang="ts">
/**
 * The audit trail. Each entry commits to the previous entry's hash, so an
 * alteration or a deletion is detectable rather than invisible.
 *
 * Generation events carry the prompt version, the pinned model and the full
 * request/response, because for a non-deterministic step the final value alone
 * does not let anyone reconstruct what happened.
 */
defineProps<{ audit: any[] }>();
</script>

<template>
  <ol class="audit">
    <li v-for="e in audit" :key="e.seq">
      <div class="audit-head">
        <code class="seq">#{{ e.seq }}</code>
        <strong>{{ e.event_type }}</strong>
        <span class="actor" :class="{ machine: e.actor?.startsWith('system:') }">{{ e.actor }}</span>
        <span class="at">{{ e.at }}</span>
      </div>
      <p v-if="e.from_state || e.to_state" class="hint">
        {{ e.from_state ?? '—' }} &rarr; {{ e.to_state ?? '—' }}
      </p>
      <p v-if="e.prompt_version" class="hint">
        prompt <code>{{ e.prompt_version }}</code> &middot; model <code>{{ e.model_id }}</code>
        &middot; temp <code>{{ e.temperature }}</code>
      </p>
      <p v-if="e.detail" class="detail">{{ e.detail }}</p>
      <p class="hash">
        <span>prev</span><code>{{ (e.prev_hash ?? 'genesis').slice(0, 16) }}</code>
        <span>entry</span><code>{{ e.entry_hash?.slice(0, 16) }}</code>
      </p>
    </li>
  </ol>
</template>
