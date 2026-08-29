/** Inline SVG so the package ships without an icon font or sprite sheet. */
const svg = (paths, opts = {}) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${opts.w ?? 1.8}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;

export const icons = {
  phone: svg('<path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8.1 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2Z"/>'),
  phoneOff: svg('<path d="M10.7 5.1A11 11 0 0 1 12 5a11 11 0 0 1 11 6.4M2 2l20 20M5.3 9.3A11 11 0 0 0 1 11.4M8.5 12.5a15 15 0 0 0 3 3"/><path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1"/>'),
  hangup: svg('<path d="M2.5 14.5 4 13a2 2 0 0 1 1.7-.6l2.4.3a2 2 0 0 0 1.7-.7l.9-1.1a2 2 0 0 1 2.6 0l.9 1.1a2 2 0 0 0 1.7.7l2.4-.3A2 2 0 0 1 20 13l1.5 1.5a2 2 0 0 1-.3 3.1 15 15 0 0 1-18.4 0 2 2 0 0 1-.3-3.1Z" transform="rotate(135 12 14)"/>'),
  mic: svg('<rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v4M8 22h8"/>'),
  micOff: svg('<path d="M2 2l20 20"/><path d="M15 9.3V5a3 3 0 0 0-5.9-.7M9 9v2a3 3 0 0 0 4.6 2.5"/><path d="M5 11a7 7 0 0 0 10.7 6M19 11a7 7 0 0 1-.5 2.6M12 18v4M8 22h8"/>'),
  pause: svg('<rect x="7" y="5" width="3.5" height="14" rx="1"/><rect x="13.5" y="5" width="3.5" height="14" rx="1"/>'),
  play: svg('<path d="M8 5.5v13l11-6.5Z"/>'),
  transfer: svg('<path d="M3 8h14l-3.5-3.5M21 16H7l3.5 3.5"/>'),
  backspace: svg('<path d="M21 5H9L2 12l7 7h12a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1ZM17 9l-6 6M11 9l6 6"/>'),
  settings: svg('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1V21a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-2.7-1.1l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.6 1.6 0 0 0 3 15a2 2 0 1 1 0-4 1.6 1.6 0 0 0 1.1-2.7l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.6 1.6 0 0 0 9 4.6V4a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 2.7 1.1l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1A1.6 1.6 0 0 0 21 11a2 2 0 1 1 0 4Z"/>'),
  record: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="6" fill="currentColor"/></svg>',
  stop: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor"/></svg>',
  user: svg('<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>'),
  keypad: svg('<circle cx="6" cy="6" r="1.4"/><circle cx="12" cy="6" r="1.4"/><circle cx="18" cy="6" r="1.4"/><circle cx="6" cy="12" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="18" cy="12" r="1.4"/><circle cx="6" cy="18" r="1.4"/><circle cx="12" cy="18" r="1.4"/><circle cx="18" cy="18" r="1.4"/>'),
  swap: svg('<path d="M7 4 3 8l4 4M3 8h13M17 20l4-4-4-4M21 16H8"/>'),
  check: svg('<path d="M20 6 9 17l-5-5"/>', { w: 2.4 }),
  x: svg('<path d="M18 6 6 18M6 6l12 12"/>', { w: 2.2 }),
};
