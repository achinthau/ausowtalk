/**
 * Shadow-DOM stylesheet. Every colour derives from --auso-primary so spec §11
 * branding (`primary_color`) restyles the whole phone from one variable.
 */
export const styles = `
:host {
  --auso-primary: #0f766e;
  --auso-primary-ink: #ffffff;
  --auso-bg: #ffffff;
  --auso-surface: #f8fafc;
  --auso-border: #e2e8f0;
  --auso-text: #0f172a;
  --auso-muted: #64748b;
  --auso-danger: #dc2626;
  --auso-success: #16a34a;
  --auso-warn: #d97706;
  --auso-radius: 14px;
  --auso-shadow: 0 8px 30px rgba(15, 23, 42, .12);

  display: block;
  width: 340px;
  font-family: ui-sans-serif, -apple-system, "Segoe UI", Roboto, sans-serif;
  color: var(--auso-text);
  -webkit-font-smoothing: antialiased;
}

:host([theme="dark"]) {
  --auso-bg: #0f172a;
  --auso-surface: #1e293b;
  --auso-border: #334155;
  --auso-text: #f1f5f9;
  --auso-muted: #94a3b8;
  --auso-shadow: 0 8px 30px rgba(0, 0, 0, .5);
}

:host([hidden]) { display: none; }

* { box-sizing: border-box; }

.phone {
  background: var(--auso-bg);
  border: 1px solid var(--auso-border);
  border-radius: var(--auso-radius);
  box-shadow: var(--auso-shadow);
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

/* ---- Header ---- */
.header {
  display: flex; align-items: center; gap: 10px;
  padding: 12px 14px;
  background: var(--auso-primary);
  color: var(--auso-primary-ink);
}
.header img { height: 26px; width: auto; max-width: 110px; object-fit: contain; border-radius: 4px; }
.header .brand { font-weight: 650; font-size: 14px; letter-spacing: .01em; flex: 1; min-width: 0;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.header .ext { font-size: 12px; opacity: .85; font-variant-numeric: tabular-nums; }
.icon-btn {
  appearance: none; border: 0; background: transparent; color: inherit; cursor: pointer;
  padding: 6px; border-radius: 8px; display: grid; place-items: center; line-height: 0;
}
.icon-btn:hover { background: rgba(255,255,255,.18); }
.icon-btn svg { width: 18px; height: 18px; }

/* ---- Status strip ---- */
.status {
  display: flex; align-items: center; gap: 8px;
  padding: 7px 14px; font-size: 12px;
  background: var(--auso-surface);
  border-bottom: 1px solid var(--auso-border);
  color: var(--auso-muted);
}
.dot { width: 8px; height: 8px; border-radius: 50%; background: var(--auso-muted); flex: none; }
.dot.registered { background: var(--auso-success); box-shadow: 0 0 0 3px color-mix(in srgb, var(--auso-success) 22%, transparent); }
.dot.connecting { background: var(--auso-warn); animation: pulse 1.2s ease-in-out infinite; }
.dot.failed { background: var(--auso-danger); }
@keyframes pulse { 50% { opacity: .3; } }
.status .spacer { flex: 1; }
.pill {
  font-size: 10.5px; font-weight: 600; letter-spacing: .03em; text-transform: uppercase;
  padding: 2px 7px; border-radius: 999px;
  background: color-mix(in srgb, var(--auso-primary) 12%, transparent);
  color: var(--auso-primary);
}
:host([theme="dark"]) .pill { color: #5eead4; }

/* ---- Body ---- */
.body { padding: 14px; display: flex; flex-direction: column; gap: 12px; }

/* ---- Dial pad ---- */
.dial-input {
  display: flex; align-items: center; gap: 6px;
  border: 1px solid var(--auso-border); border-radius: 10px;
  background: var(--auso-surface); padding: 4px 4px 4px 12px;
}
.dial-input input {
  flex: 1; min-width: 0; border: 0; background: transparent; outline: none;
  font-size: 20px; font-variant-numeric: tabular-nums; letter-spacing: .02em;
  color: var(--auso-text); padding: 8px 0;
}
.dial-input .icon-btn { color: var(--auso-muted); }
.dial-input .icon-btn:hover { background: var(--auso-border); }

.keys { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
.key {
  appearance: none; cursor: pointer;
  border: 1px solid var(--auso-border); background: var(--auso-bg); color: var(--auso-text);
  border-radius: 10px; padding: 10px 0 8px;
  display: flex; flex-direction: column; align-items: center; gap: 1px;
  transition: transform .06s ease, background .12s ease;
}
.key:hover { background: var(--auso-surface); }
.key:active { transform: scale(.96); }
.key .digit { font-size: 19px; font-weight: 550; line-height: 1; font-variant-numeric: tabular-nums; }
.key .letters { font-size: 8.5px; letter-spacing: .12em; color: var(--auso-muted); height: 10px; }

/* ---- Buttons ---- */
.btn {
  appearance: none; cursor: pointer; border: 1px solid transparent;
  border-radius: 10px; padding: 11px 14px; font-size: 13.5px; font-weight: 600;
  display: inline-flex; align-items: center; justify-content: center; gap: 7px;
  transition: filter .12s ease, background .12s ease;
}
.btn:disabled { opacity: .45; cursor: not-allowed; }
.btn:not(:disabled):hover { filter: brightness(.94); }
.btn svg { width: 17px; height: 17px; flex: none; }
.btn-primary { background: var(--auso-primary); color: var(--auso-primary-ink); }
.btn-success { background: var(--auso-success); color: #fff; }
.btn-danger  { background: var(--auso-danger);  color: #fff; }
.btn-ghost   { background: var(--auso-surface); color: var(--auso-text); border-color: var(--auso-border); }
.btn-ghost.active { background: var(--auso-primary); color: var(--auso-primary-ink); border-color: transparent; }
.btn-block { width: 100%; }
.btn-row { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }

/* ---- Call card ---- */
.call-card {
  border: 1px solid var(--auso-border); border-radius: 12px;
  background: var(--auso-surface); padding: 14px; text-align: center;
}
.call-card.incoming { border-color: var(--auso-success); animation: ring 1.6s ease-in-out infinite; }
@keyframes ring {
  0%, 100% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--auso-success) 40%, transparent); }
  50%      { box-shadow: 0 0 0 7px color-mix(in srgb, var(--auso-success) 0%, transparent); }
}
.call-card .label {
  font-size: 11px; text-transform: uppercase; letter-spacing: .09em;
  color: var(--auso-muted); font-weight: 650;
}
.call-card .cli {
  font-size: 23px; font-weight: 620; margin: 5px 0 2px;
  font-variant-numeric: tabular-nums; word-break: break-all;
}
.call-card .who { font-size: 13px; color: var(--auso-muted); min-height: 18px; }
.call-card .timer {
  font-size: 26px; font-variant-numeric: tabular-nums; font-weight: 300;
  letter-spacing: .04em; margin: 6px 0 10px;
}
.call-card .badges { display: flex; gap: 6px; justify-content: center; flex-wrap: wrap; margin-bottom: 10px; min-height: 0; }
.badge {
  font-size: 10.5px; font-weight: 650; letter-spacing: .04em; text-transform: uppercase;
  padding: 3px 8px; border-radius: 999px; border: 1px solid currentColor;
}
.badge.hold { color: var(--auso-warn); }
.badge.mute { color: var(--auso-danger); }
.badge.rec  { color: var(--auso-danger); animation: pulse 1.6s ease-in-out infinite; }
.badge.auto { color: var(--auso-primary); }

.controls { display: grid; grid-template-columns: repeat(2, 1fr); gap: 8px; }
.controls .btn { padding: 10px 8px; font-size: 12.5px; }
.controls-4 { grid-template-columns: repeat(4, 1fr); }
.controls-4 .btn { flex-direction: column; gap: 4px; font-size: 10.5px; padding: 9px 2px; }

/* ---- Customer screen-pop ---- */
.customer {
  border: 1px solid var(--auso-border); border-left: 3px solid var(--auso-primary);
  border-radius: 8px; background: var(--auso-bg); padding: 9px 11px; text-align: left;
  margin-bottom: 10px;
}
.customer .name { font-weight: 650; font-size: 13.5px; }
.customer .meta { font-size: 11.5px; color: var(--auso-muted); margin-top: 2px; }

/* ---- Transfer / settings panels ---- */
.panel {
  border: 1px solid var(--auso-border); border-radius: 12px;
  background: var(--auso-surface); padding: 13px;
}
.panel h4 { margin: 0 0 10px; font-size: 12.5px; text-transform: uppercase; letter-spacing: .07em; color: var(--auso-muted); }
.field { display: flex; flex-direction: column; gap: 5px; margin-bottom: 10px; }
.field label { font-size: 11.5px; font-weight: 600; color: var(--auso-muted); }
.field input, .field select {
  width: 100%; padding: 9px 10px; font-size: 14px; color: var(--auso-text);
  border: 1px solid var(--auso-border); border-radius: 8px; background: var(--auso-bg);
  outline: none;
}
.field input:focus, .field select:focus { border-color: var(--auso-primary); }
.seg { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; margin-bottom: 10px; }
.seg .btn { padding: 8px; font-size: 12px; }
.toggle { display: flex; align-items: center; gap: 9px; cursor: pointer; padding: 5px 0; font-size: 13px; }
.toggle input { width: 16px; height: 16px; accent-color: var(--auso-primary); cursor: pointer; }
.hint { font-size: 11px; color: var(--auso-muted); line-height: 1.45; margin-top: -4px; }

.error {
  font-size: 12px; color: var(--auso-danger); background: color-mix(in srgb, var(--auso-danger) 9%, transparent);
  border: 1px solid color-mix(in srgb, var(--auso-danger) 35%, transparent);
  border-radius: 8px; padding: 8px 10px; line-height: 1.4;
}

.footer {
  padding: 7px 14px; font-size: 10px; color: var(--auso-muted);
  text-align: center; border-top: 1px solid var(--auso-border); background: var(--auso-surface);
}
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
`;
