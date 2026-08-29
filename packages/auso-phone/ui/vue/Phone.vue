<script setup>
import { computed, ref } from 'vue';
import { usePhone } from './usePhone.js';
import DialPad from './DialPad.vue';
import IncomingCall from './IncomingCall.vue';
import ActiveCall from './ActiveCall.vue';
import TransferDialog from './TransferDialog.vue';

const props = defineProps({
  /** Passed straight to AusoPhone.init() — credentialsUrl, lookupUrl, branding… */
  config: { type: Object, default: () => ({}) },
  autoLogin: { type: Boolean, default: false },
  extension: { type: String, default: '' },
});

const {
  state, error, login, logout, call, answer, reject, hangup,
  toggleHold, toggleMute, sendDTMF, transfer,
  completeTransfer, cancelTransfer, swapTransferLegs, setAutoAnswer,
  startRecording, stopRecording,
} = usePhone({ config: props.config, autoLogin: props.autoLogin });

const view = ref('dialpad'); // dialpad | transfer | dtmf

const incoming = computed(() =>
  state.calls.find((c) => c.direction === 'inbound' && c.state === 'ringing'));

const active = computed(() =>
  state.calls.find((c) => c.state === 'answered' || c.state === 'held')
  ?? state.calls.find((c) => c.state === 'dialing' || c.state === 'ringing'));

const consultReady = computed(() => {
  const id = state.transfer?.consultCallId;
  return Boolean(id && state.calls.find((c) => c.call_id === id)?.state === 'answered');
});

const brandStyle = computed(() => ({ '--auso-primary': state.branding.primary_color }));

async function onTransfer({ target, type }) {
  await transfer(target, { type });
  view.value = 'dialpad';
}

async function onToggleRecord(id) {
  const c = state.calls.find((x) => x.call_id === id);
  if (c?.recording) await stopRecording(id);
  else await startRecording(id);
}
</script>

<template>
  <div class="auso-phone" :style="brandStyle" :data-theme="state.branding.theme">
    <header class="auso-header">
      <img v-if="state.branding.logo" :src="state.branding.logo" :alt="state.branding.company_name" />
      <span class="auso-brand">{{ state.branding.company_name }}</span>
      <span v-if="state.extension" class="auso-ext">Ext {{ state.extension }}</span>
    </header>

    <div class="auso-status">
      <span class="auso-dot" :class="state.registration"></span>
      <span>{{ {
        registered: 'Registered',
        registering: 'Registering…',
        failed: 'Registration failed',
        unregistered: state.connection === 'connected' ? 'Connected' : 'Offline',
      }[state.registration] }}</span>
      <span class="auso-spacer"></span>
      <label class="auso-toggle">
        <input type="checkbox" :checked="state.auto_answer" @change="setAutoAnswer($event.target.checked)" />
        Auto answer
      </label>
      <button v-if="!state.registered" type="button" class="auso-btn auso-btn-ghost"
              @click="login({ extension })">Connect</button>
      <button v-else type="button" class="auso-btn auso-btn-ghost" @click="logout()">Disconnect</button>
    </div>

    <div class="auso-body">
      <p v-if="error" class="auso-error">{{ error }}</p>

      <IncomingCall v-if="incoming" :call="incoming" @answer="answer" @reject="reject" />

      <ActiveCall
        v-else-if="active"
        :call="active"
        :transfer="state.transfer"
        :consult-ready="consultReady"
        @hangup="hangup"
        @toggle-mute="toggleMute"
        @toggle-hold="toggleHold"
        @toggle-record="onToggleRecord"
        @open-transfer="view = 'transfer'"
        @complete-transfer="completeTransfer"
        @cancel-transfer="cancelTransfer"
        @swap-legs="swapTransferLegs"
      />

      <TransferDialog
        v-if="view === 'transfer'"
        :pending="state.transfer"
        @transfer="onTransfer"
        @close="view = 'dialpad'"
      />

      <DialPad
        v-if="view !== 'transfer'"
        :disabled="!state.registered"
        :dtmf-mode="Boolean(active && active.state === 'answered')"
        @dial="call"
        @dtmf="sendDTMF"
      />
    </div>

    <footer v-if="state.branding.show_powered_by" class="auso-footer">Powered by AusoPhone</footer>
  </div>
</template>
