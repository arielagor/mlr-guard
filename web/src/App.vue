<script setup lang="ts">
/**
 * mlr-guard console. Vue 3 Composition API.
 *
 * The UI's job is to make provenance and the review gate VISIBLE. A reviewer
 * should be able to see, for every sentence, which approved claim it is and
 * what substantiates it, without leaving the page. That is the difference
 * between a tool people trust in a regulated workflow and one they do not.
 */
import { ref, computed, onMounted } from 'vue';
import ClaimLibrary from './components/ClaimLibrary.vue';
import ArtifactView from './components/ArtifactView.vue';
import AuditTrail from './components/AuditTrail.vue';

type Audience = 'hcp' | 'patient';

const audience = ref<Audience>('hcp');
const brief = ref('Launch email introducing VERIDANE to specialists.');
const channel = ref('email');
const actor = ref('');

const artifactId = ref<string | null>(null);
const artifact = ref<any>(null);
const segments = ref<any[]>([]);
const audit = ref<any[]>([]);
const lint = ref<any>(null);
const busy = ref(false);
const error = ref<string | null>(null);
const verification = ref<any>(null);

const state = computed<string>(() => artifact.value?.state ?? 'none');
const hasActor = computed(() => actor.value.trim().length > 0);

function headers(): Record<string, string> {
  const h: Record<string, string> = { 'content-type': 'application/json' };
  // Human-only transitions carry the authenticated identity. With this absent,
  // the Worker's state machine refuses approve/reject/publish outright.
  if (hasActor.value) h['x-actor'] = actor.value.trim();
  return h;
}

async function call(path: string, init: RequestInit = {}) {
  busy.value = true;
  error.value = null;
  try {
    const res = await fetch(path, { ...init, headers: headers() });
    const data = await res.json();
    if (!res.ok) {
      error.value = data.error ?? `request failed (${res.status})`;
      if (data.lint) lint.value = data.lint;
      return null;
    }
    return data;
  } catch (e) {
    error.value = String(e);
    return null;
  } finally {
    busy.value = false;
  }
}

async function refresh() {
  if (!artifactId.value) return;
  const data = await call(`/api/artifacts/${artifactId.value}`);
  if (!data) return;
  artifact.value = data.artifact;
  segments.value = data.segments ?? [];
  audit.value = data.audit ?? [];
}

async function createAndGenerate() {
  verification.value = null;
  lint.value = null;
  const created = await call('/api/artifacts', {
    method: 'POST',
    body: JSON.stringify({ audience: audience.value, channel: channel.value, brief: brief.value }),
  });
  if (!created) return;
  artifactId.value = created.id;
  const gen = await call(`/api/artifacts/${created.id}/generate`, { method: 'POST' });
  if (gen) lint.value = gen.lint;
  await refresh();
}

async function act(verb: string) {
  const data = await call(`/api/artifacts/${artifactId.value}/${verb}`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
  if (data?.lint) lint.value = data.lint;
  await refresh();
}

async function verifyAudit() {
  verification.value = await call(`/api/artifacts/${artifactId.value}/audit/verify`);
}

onMounted(() => {
  /* claims load inside ClaimLibrary */
});
</script>

<template>
  <div class="shell">
    <header class="head">
      <div>
        <h1>mlr-guard</h1>
        <p class="sub">
          Claims-grounded content generation on the Cloudflare edge. The model selects and orders
          pre-approved claims; it never writes a sentence.
        </p>
      </div>
      <span class="demo-flag">Demo &middot; fictional product, synthetic claims</span>
    </header>

    <section class="panel">
      <h2>1 &middot; Brief</h2>
      <div class="row">
        <label>
          Audience
          <select v-model="audience">
            <option value="hcp">Healthcare professional</option>
            <option value="patient">Patient</option>
          </select>
        </label>
        <label>
          Channel
          <select v-model="channel">
            <option value="email">Email</option>
            <option value="detail-aid">Detail aid</option>
            <option value="web">Web</option>
          </select>
        </label>
      </div>
      <label class="block">
        Brief
        <textarea v-model="brief" rows="2"></textarea>
      </label>
      <button class="primary" :disabled="busy" @click="createAndGenerate">
        {{ busy ? 'Working…' : 'Generate from approved claims' }}
      </button>
    </section>

    <ClaimLibrary :audience="audience" />

    <section v-if="artifact" class="panel">
      <h2>2 &middot; Generated artifact</h2>
      <ArtifactView :artifact="artifact" :segments="segments" :lint="lint" />
    </section>

    <section v-if="artifact" class="panel">
      <h2>3 &middot; Review gate</h2>
      <label class="block">
        Reviewer identity
        <input
          v-model="actor"
          placeholder="leave blank to prove the gate refuses an unauthenticated approval"
        />
      </label>
      <p v-if="!hasActor" class="hint">
        No identity set. Approve, reject and publish will be refused by the state machine, not by
        the UI.
      </p>
      <div class="actions">
        <button :disabled="busy || state !== 'generated'" @click="act('submit')">
          Submit for review
        </button>
        <button :disabled="busy || state !== 'in_review'" @click="act('approve')">Approve</button>
        <button :disabled="busy || state !== 'in_review'" @click="act('reject')">Reject</button>
        <button :disabled="busy || state !== 'approved'" @click="act('publish')">Publish</button>
      </div>
      <p class="state">
        State: <strong>{{ state }}</strong>
      </p>
      <p v-if="error" class="error">{{ error }}</p>
    </section>

    <section v-if="audit.length" class="panel">
      <h2>4 &middot; Audit trail</h2>
      <AuditTrail :audit="audit" />
      <button :disabled="busy" @click="verifyAudit">Verify hash chain</button>
      <p v-if="verification" :class="verification.verification?.ok ? 'ok' : 'error'">
        {{
          verification.verification?.ok
            ? `Chain intact across ${verification.entries} entries.`
            : `Chain broken at #${verification.verification?.brokenAtSeq}: ${verification.verification?.reason}`
        }}
      </p>
    </section>
  </div>
</template>
