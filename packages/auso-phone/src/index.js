/**
 * auso-phone — reusable WebRTC softphone for Auso Call Hub.
 *
 * Browser build: exposes `window.AusoPhone` (spec §12) and registers the
 * `<auso-phone>` custom element.
 * Bundler build: import { AusoPhone, phone, PhoneEvents } from 'auso-phone'.
 */
import { AusoPhone, phone } from './AusoPhone.js';
import { AusoPhoneElement, defineAusoPhoneElement } from '../ui/AusoPhoneElement.js';
import {
  ALL_EVENTS,
  CallState,
  ConnectionState,
  Direction,
  PhoneEvents,
  RegistrationState,
  TRANSFER_UMBRELLA,
} from './events.js';
import { setLogLevel } from './logger.js';

export {
  AusoPhone,
  AusoPhoneElement,
  defineAusoPhoneElement,
  phone,
  PhoneEvents,
  CallState,
  ConnectionState,
  Direction,
  RegistrationState,
  ALL_EVENTS,
  TRANSFER_UMBRELLA,
  setLogLevel,
};

// Attach useful statics to the singleton so the global feels like one object.
Object.assign(phone, {
  Events: PhoneEvents,
  CallState,
  Direction,
  RegistrationState,
  ConnectionState,
  setLogLevel,
  version: '1.0.0',
});

if (typeof window !== 'undefined') {
  window.AusoPhone = phone;
  if (typeof customElements !== 'undefined') defineAusoPhoneElement();
}

export default phone;
