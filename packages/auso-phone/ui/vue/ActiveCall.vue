<script setup>
import { computed } from 'vue';

const props = defineProps({
  call: { type: Object, required: true },
  /** `status().transfer` — non-null while an attended transfer is pending. */
  transfer: { type: Object, default: null },
  consultReady: { type: Boolean, default: false },
});
defineEmits([
  'hangup', 'toggle-mute', 'toggle-hold', 'open-transfer',
  'toggle-record', 'complete-transfer', 'cancel-transfer', 'swap-legs',
]);

const established = computed(() => ['answered', 'held'].includes(props.call.state));

const label = computed(() => ({
  dialing: 'Dialing',
  ringing: props.call.direction === 'outbound' ? 'Ringing' : 'Incoming',
  answered: 'Active call',
  held: 'On hold',
}[props.call.state] ?? 'Call'));

const timer = computed(() => {
  const s = Math.max(0, props.call.duration | 0);
  const pad = (n) => String(n).padStart(2, '0');
  const h = Math.floor(s / 3600);
  return (h ? `${pad(h)}:` : '') + `${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
});
</script>

<template>
  <div class="auso-call-card">
    <div class="auso-label">{{ label }}<span v-if="call.consultation"> · consultation</span></div>
    <div class="auso-cli">{{ call.cli }}</div>
    <div class="auso-who">{{ call.remote_display_name }}</div>
    <div class="auso-timer">{{ timer }}</div>

    <div class="auso-badges">
      <span v-if="call.held" class="auso-badge auso-hold">Hold</span>
      <span v-if="call.muted" class="auso-badge auso-mute">Muted</span>
      <span v-if="call.recording" class="auso-badge auso-rec">Rec</span>
      <span v-if="transfer" class="auso-badge auso-auto">Transfer pending</span>
    </div>

    <div v-if="call.customer" class="auso-customer">
      <div class="auso-customer-name">{{ call.customer.name || call.customer.company }}</div>
      <div class="auso-customer-meta">{{ call.customer.phone }}</div>
    </div>

    <!-- Matches the mockup in the spec: Mute · Hold · Transfer · Hangup -->
    <div class="auso-controls auso-controls-4">
      <button type="button" class="auso-btn auso-btn-ghost" :class="{ active: call.muted }"
              :disabled="!established" @click="$emit('toggle-mute', call.call_id)">
        {{ call.muted ? 'Unmute' : 'Mute' }}
      </button>
      <button type="button" class="auso-btn auso-btn-ghost" :class="{ active: call.held }"
              :disabled="!established" @click="$emit('toggle-hold', call.call_id)">
        {{ call.held ? 'Resume' : 'Hold' }}
      </button>
      <button type="button" class="auso-btn auso-btn-ghost" :disabled="!established" @click="$emit('open-transfer')">
        Transfer
      </button>
      <button type="button" class="auso-btn auso-btn-danger" @click="$emit('hangup', call.call_id)">
        Hangup
      </button>
    </div>

    <div v-if="established" class="auso-controls" style="margin-top: 8px">
      <button type="button" class="auso-btn auso-btn-ghost" :class="{ active: call.recording }"
              @click="$emit('toggle-record', call.call_id)">
        {{ call.recording ? 'Stop recording' : 'Record' }}
      </button>
    </div>

    <!-- Attended transfer controls (spec §8) -->
    <div v-if="transfer" class="auso-controls auso-controls-3" style="margin-top: 10px">
      <button type="button" class="auso-btn auso-btn-ghost" @click="$emit('swap-legs')">Swap</button>
      <button type="button" class="auso-btn auso-btn-success" :disabled="!consultReady"
              @click="$emit('complete-transfer')">Complete</button>
      <button type="button" class="auso-btn auso-btn-ghost" @click="$emit('cancel-transfer')">Cancel</button>
    </div>
  </div>
</template>
