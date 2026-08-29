<script setup>
defineProps({
  /** A `call.toJSON()` payload from the `incoming` event. */
  call: { type: Object, required: true },
});
defineEmits(['answer', 'reject']);
</script>

<template>
  <div class="auso-call-card auso-incoming">
    <div class="auso-label">Incoming call</div>
    <div class="auso-cli">{{ call.cli }}</div>
    <div class="auso-who">{{ call.remote_display_name }}</div>

    <!-- Spec §5 screen-pop: whatever Laravel returned for this CLI. -->
    <div v-if="call.customer" class="auso-customer">
      <div class="auso-customer-name">{{ call.customer.name || call.customer.company }}</div>
      <div class="auso-customer-meta">
        <span v-if="call.customer.phone">{{ call.customer.phone }}</span>
        <span v-if="call.customer.previous_calls != null"> · {{ call.customer.previous_calls }} previous calls</span>
        <span v-if="call.customer.last_call"> · last {{ call.customer.last_call }}</span>
      </div>
    </div>

    <div class="auso-controls">
      <button type="button" class="auso-btn auso-btn-success" @click="$emit('answer', call.call_id)">Answer</button>
      <button type="button" class="auso-btn auso-btn-danger" @click="$emit('reject', call.call_id)">Reject</button>
    </div>
  </div>
</template>
