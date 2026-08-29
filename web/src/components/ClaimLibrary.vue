<script setup lang="ts">
/**
 * The claims library. Only claims with status='approved' are ever returned by
 * the API, so a retired claim cannot be offered to the model even if the prompt
 * is ignored entirely. Filtering here rather than instructing is the point.
 */
import { ref, watch, onMounted } from 'vue';

const props = defineProps<{ audience: string }>();
const claims = ref<any[]>([]);
const open = ref(false);

async function load() {
  const res = await fetch(`/api/claims?product=VERIDANE&audience=${props.audience}`);
  if (res.ok) claims.value = (await res.json()).claims ?? [];
}
onMounted(load);
watch(() => props.audience, load);
</script>

<template>
  <section class="panel">
    <h2 @click="open = !open" class="clickable">
      Claims library
      <span class="count">{{ claims.length }} approved</span>
      <span class="chev">{{ open ? '−' : '+' }}</span>
    </h2>
    <p class="hint">
      The model is only ever shown these. It returns claim IDs; the text on the page is read back
      from this library, so a claim cannot be reworded in transit.
    </p>
    <ul v-if="open" class="claims">
      <li v-for="c in claims" :key="c.id">
        <div class="claim-head">
          <code>{{ c.id }}</code>
          <span class="tag" :class="c.claim_type">{{ c.claim_type }}</span>
        </div>
        <p class="text">{{ c.claim_text }}</p>
        <p class="cite">{{ c.citation }} &mdash; {{ c.anchor }}</p>
      </li>
    </ul>
  </section>
</template>
