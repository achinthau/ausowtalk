<script setup>
import { ref } from 'vue';

defineProps({
  /** Pass `status().transfer`; when set, a transfer is already running. */
  pending: { type: Object, default: null },
});
const emit = defineEmits(['transfer', 'close']);

const target = ref('');
const type = ref('blind');

function submit() {
  if (!target.value) return;
  emit('transfer', { target: target.value, type: type.value });
  if (type.value === 'blind') target.value = '';
}
</script>

<template>
  <div class="auso-panel">
    <h4>Transfer call</h4>

    <p v-if="pending" class="auso-hint">
      An attended transfer is already in progress — complete or cancel it from the call controls.
    </p>

    <template v-else>
      <div class="auso-seg">
        <button type="button" class="auso-btn" :class="type === 'blind' ? 'auso-btn-primary' : 'auso-btn-ghost'"
                @click="type = 'blind'">Blind</button>
        <button type="button" class="auso-btn" :class="type === 'attended' ? 'auso-btn-primary' : 'auso-btn-ghost'"
                @click="type = 'attended'">Attended</button>
      </div>

      <div class="auso-field">
        <label for="auso-transfer-target">Destination</label>
        <input id="auso-transfer-target" v-model="target" type="tel" placeholder="e.g. 2005" @keydown.enter="submit" />
      </div>

      <p class="auso-hint">
        {{ type === 'blind'
          ? 'Sends a REFER immediately and drops you from the call.'
          : 'Holds the customer and dials the destination so you can announce the call first.' }}
      </p>

      <div class="auso-controls">
        <button type="button" class="auso-btn auso-btn-ghost" @click="$emit('close')">Cancel</button>
        <button type="button" class="auso-btn auso-btn-primary" :disabled="!target" @click="submit">Transfer</button>
      </div>
    </template>

    <button v-if="pending" type="button" class="auso-btn auso-btn-ghost" @click="$emit('close')">Close</button>
  </div>
</template>
