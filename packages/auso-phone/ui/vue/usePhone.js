import { onBeforeUnmount, onMounted, reactive, readonly, ref } from 'vue';
import { phone as singleton } from '../../src/AusoPhone.js';
import { ALL_EVENTS, PhoneEvents } from '../../src/events.js';

/**
 * Vue 3 composable wrapping the AusoPhone singleton.
 *
 * The phone remains the single source of truth; this just mirrors `status()`
 * into a reactive object whenever an event fires.
 */
export function usePhone(options = {}) {
  const phone = options.phone ?? singleton;
  const state = reactive(phone.status());
  const lastEvent = ref(null);
  const error = ref('');
  const unsubscribers = [];

  const sync = (evt) => {
    Object.assign(state, phone.status());
    if (evt) lastEvent.value = evt;
  };

  onMounted(() => {
    if (options.config) phone.init(options.config);
    ALL_EVENTS.forEach((e) => unsubscribers.push(phone.on(e, sync)));
    unsubscribers.push(phone.on(PhoneEvents.ERROR, (e) => {
      if (e.fatal !== false) error.value = e.message;
    }));
    sync();
    if (options.autoLogin) login().catch(() => {});
  });

  onBeforeUnmount(() => {
    unsubscribers.forEach((off) => off());
    unsubscribers.length = 0;
  });

  async function login(opts = {}) {
    error.value = '';
    try {
      const status = await phone.login(opts);
      sync();
      return status;
    } catch (err) {
      error.value = err.message;
      throw err;
    }
  }

  const wrap = (fn) => async (...args) => {
    error.value = '';
    try {
      return await fn(...args);
    } catch (err) {
      error.value = err.message;
      throw err;
    } finally {
      sync();
    }
  };

  return {
    phone,
    state: readonly(state),
    lastEvent: readonly(lastEvent),
    error,
    login,
    logout: wrap(() => phone.logout()),
    call: wrap((n, o) => phone.call(n, o)),
    answer: wrap((id) => phone.answer(id)),
    reject: wrap((id) => phone.reject(id)),
    hangup: wrap((id) => phone.hangup(id)),
    toggleHold: wrap((id) => phone.toggleHold(id)),
    toggleMute: wrap((id) => phone.toggleMute(id)),
    sendDTMF: wrap((t) => phone.sendDTMF(t)),
    transfer: wrap((t, o) => phone.transfer(t, o)),
    completeTransfer: wrap(() => phone.completeTransfer()),
    cancelTransfer: wrap(() => phone.cancelTransfer()),
    swapTransferLegs: wrap(() => phone.swapTransferLegs()),
    setAutoAnswer: (v) => { phone.setAutoAnswer(v); sync(); },
    startRecording: wrap((id) => phone.startRecording(id)),
    stopRecording: wrap((id) => phone.stopRecording(id)),
  };
}
