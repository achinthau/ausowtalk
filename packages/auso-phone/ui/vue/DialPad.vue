<script setup>
import { computed, ref } from 'vue';

const props = defineProps({
  disabled: { type: Boolean, default: false },
  /** When true, key presses emit `dtmf` instead of building a number. */
  dtmfMode: { type: Boolean, default: false },
});
const emit = defineEmits(['dial', 'dtmf']);

const KEYS = [
  ['1', ''], ['2', 'ABC'], ['3', 'DEF'],
  ['4', 'GHI'], ['5', 'JKL'], ['6', 'MNO'],
  ['7', 'PQRS'], ['8', 'TUV'], ['9', 'WXYZ'],
  ['*', ''], ['0', '+'], ['#', ''],
];

const number = ref('');
const canDial = computed(() => !props.disabled && number.value.length > 0);

function press(key) {
  if (props.dtmfMode) {
    emit('dtmf', key);
    return;
  }
  number.value += key;
}

function backspace() {
  number.value = number.value.slice(0, -1);
}

function dial() {
  if (!canDial.value) return;
  emit('dial', number.value);
  number.value = '';
}
</script>

<template>
  <div class="auso-dialpad">
    <div v-if="!dtmfMode" class="auso-dial-input">
      <input
        v-model="number"
        type="tel"
        inputmode="tel"
        placeholder="Enter number"
        aria-label="Number to dial"
        @keydown.enter="dial"
      />
      <button v-if="number" type="button" aria-label="Backspace" @click="backspace">⌫</button>
    </div>

    <div class="auso-keys">
      <button v-for="[digit, letters] in KEYS" :key="digit" type="button" class="auso-key" @click="press(digit)">
        <span class="auso-digit">{{ digit }}</span>
        <span class="auso-letters">{{ letters }}</span>
      </button>
    </div>

    <button v-if="!dtmfMode" type="button" class="auso-btn auso-btn-primary" :disabled="!canDial" @click="dial">
      Call
    </button>
  </div>
</template>
