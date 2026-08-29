/**
 * Vue 3 entry point.
 *
 *   import { AusoPhonePlugin } from 'auso-phone/vue'
 *   app.use(AusoPhonePlugin, { credentialsUrl: '/api/phone/credentials' })
 *
 * Or import individual components / the composable directly.
 */
import Phone from './Phone.vue';
import DialPad from './DialPad.vue';
import IncomingCall from './IncomingCall.vue';
import ActiveCall from './ActiveCall.vue';
import TransferDialog from './TransferDialog.vue';
import { usePhone } from './usePhone.js';
import { phone } from '../../src/AusoPhone.js';

export { Phone, DialPad, IncomingCall, ActiveCall, TransferDialog, usePhone, phone };

export const AusoPhonePlugin = {
  install(app, config = {}) {
    phone.init(config);
    app.config.globalProperties.$phone = phone;
    app.provide('ausoPhone', phone);
    app.component('AusoPhone', Phone);
    app.component('AusoDialPad', DialPad);
    app.component('AusoIncomingCall', IncomingCall);
    app.component('AusoActiveCall', ActiveCall);
    app.component('AusoTransferDialog', TransferDialog);
  },
};

export default AusoPhonePlugin;
