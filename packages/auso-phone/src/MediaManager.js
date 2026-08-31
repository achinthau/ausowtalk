import { createLogger } from './logger.js';

const log = createLogger('MediaManager');

/**
 * Owns everything audio: microphone permission, device selection, the remote
 * <audio> sink, local mute, and the ringtone/ringback tones.
 *
 * Spec §9: mute is a *local* media mute — the microphone track is disabled but
 * the speaker stays live, so the agent still hears the customer. We never send
 * a re-INVITE for mute (that is what hold is for).
 */
export class MediaManager {
  constructor(options = {}) {
    this.constraints = options.constraints ?? { audio: true, video: false };
    this.inputDeviceId = options.inputDeviceId ?? null;
    this.outputDeviceId = options.outputDeviceId ?? null;
    this.ringtoneVolume = options.ringtoneVolume ?? 0.5;
    this.enableTones = options.enableTones !== false;

    /** @type {HTMLAudioElement|null} */
    this.remoteAudio = null;
    /** @type {AudioContext|null} */
    this.toneContext = null;
    this.activeTone = null;
    this.devices = { inputs: [], outputs: [] };

    // Web Audio noise suppression DSP (noise gate + high-pass).
    // ON by default so background noise is suppressed. Routing through Web Audio
    // can weaken the browser's native echo cancellation, but the gate is gentle
    // (never muting the voice) and the source still captures with native AEC/NS/
    // AGC on the raw stream.
    this.noiseGate = options.noiseGate !== false;
    /** @type {{ context, source, destination, worklet } | null} */
    this._dsp = null;
    this._micProxyInstalled = false;
    this._originalGetUserMedia = null;

    this._onDeviceChange = () => {
      this.enumerate().catch((err) => log.warn('device enumeration failed', err));
    };
  }

  /** Enable/disable the Web Audio noise-gate + high-pass processing. */
  setNoiseGate(enabled) {
    this.noiseGate = Boolean(enabled);
    if (this.noiseGate) this._installMicProxy();
    else this._uninstallMicProxy();
  }

  /** Create the hidden <audio> element the remote stream is attached to. */
  attach(container = document.body) {
    if (this.remoteAudio) return this.remoteAudio;
    const el = document.createElement('audio');
    el.id = 'auso-phone-remote-audio';
    el.autoplay = true;
    el.setAttribute('playsinline', '');
    el.style.display = 'none';
    container.appendChild(el);
    this.remoteAudio = el;

    navigator.mediaDevices?.addEventListener?.('devicechange', this._onDeviceChange);
    if (this.noiseGate) this._installMicProxy();
    return el;
  }

  destroy() {
    if (navigator.mediaDevices && this._originalGetUserMedia) {
      navigator.mediaDevices.getUserMedia = this._originalGetUserMedia;
    }
    this._originalGetUserMedia = null;
    this._micProxyInstalled = false;
    navigator.mediaDevices?.removeEventListener?.('devicechange', this._onDeviceChange);
    this.stopTone();
    this.toneContext?.close().catch(() => {});
    this.toneContext = null;
    this._teardownDsp();
    this.remoteAudio?.remove();
    this.remoteAudio = null;
  }

  /**
   * Ask for the microphone up-front so the browser permission prompt happens at
   * login rather than mid-INVITE (which would make us miss the auto-answer
   * window). The stream is released immediately — SIP.js acquires its own.
   */
  async requestPermission() {
    this.assertSecureContext();
    // Use the raw getUserMedia (not the DSP proxy): this only asks permission and
    // releases the track immediately — there is nothing to process.
    const gUM = this._originalGetUserMedia ?? ((c) => navigator.mediaDevices.getUserMedia(c));
    const stream = await gUM(this.getConstraints());
    stream.getTracks().forEach((t) => t.stop());
    await this.enumerate();
    return true;
  }

  /**
   * `navigator.mediaDevices` only exists in a secure context. Browsers treat
   * https, localhost, 127.0.0.1 and [::1] as secure — but not a LAN IP and not
   * 0.0.0.0, which is easy to hit by copying a server's bind address into the
   * address bar. Without this check the first symptom is an opaque failure deep
   * inside SIP.js when it tries to build the local media stream.
   */
  assertSecureContext() {
    if (navigator.mediaDevices?.getUserMedia) return true;

    const origin = window.location.origin;
    throw new Error(
      window.isSecureContext
        ? `This browser does not support getUserMedia (origin ${origin}).`
        : `Microphone access needs a secure context, and ${origin} is not one. `
          + 'Open the console on http://localhost (or serve it over https). '
          + 'Browsers only treat localhost, 127.0.0.1 and [::1] as secure origins '
          + '— a LAN address or 0.0.0.0 will not work.',
    );
  }

  getConstraints() {
    // Ask the browser for full acoustic processing at capture time. These are
    // *requests* — a device/driver that lacks AEC/AGC/NS drops them, so always
    // request all three regardless of whether a specific device is chosen.
    const audio = {
      ...(this.inputDeviceId ? { deviceId: { exact: this.inputDeviceId } } : {}),
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    };
    return { audio, video: false };
  }

  // ---- Noise suppression DSP (Web Audio) ---------------------------------
  // The browser's native noise suppression handles steady background noise but
  // not other people's voices. We route the mic through a high-pass filter plus
  // an AudioWorklet noise gate that closes when nobody is speaking, so quiet
  // conference-room chatter is attenuated while the agent's voice opens it.

  /**
   * Wrap `navigator.mediaDevices.getUserMedia` so any audio-only request (ours
   * or SIP.js) returns the processed mic stream. Non-audio requests pass
   * through untouched.
   */
  _installMicProxy() {
    if (this._micProxyInstalled) return;
    const md = navigator.mediaDevices;
    if (!md?.getUserMedia) return;
    this._originalGetUserMedia = md.getUserMedia.bind(md);
    const self = this;
    md.getUserMedia = async (constraints) => {
      // Only intercept audio-only requests; let video/exact passthrough.
      if (!constraints?.video && constraints?.audio) {
        return self._getProcessedAudioStream(constraints);
      }
      return self._originalGetUserMedia(constraints);
    };
    this._micProxyInstalled = true;
    log.info('noise-suppression DSP armed (noise gate + high-pass)');
  }

  _uninstallMicProxy() {
    if (!this._micProxyInstalled) return;
    if (navigator.mediaDevices && this._originalGetUserMedia) {
      navigator.mediaDevices.getUserMedia = this._originalGetUserMedia;
    }
    this._micProxyInstalled = false;
    this._teardownDsp();
  }

  async _getProcessedAudioStream(constraints) {
    // Browsers ignore echoCancellation:true when the processed stream is fed
    // back into WebRTC, so apply AEC/AGC at the raw capture stage.
    const raw = await this._originalGetUserMedia(constraints);
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      const context = new Ctx();
      await context.audioWorklet.addModule(createNoiseGateWorkletURL());
      const source = context.createMediaStreamSource(raw);
      const highpass = context.createBiquadFilter();
      highpass.type = 'highpass';
      highpass.frequency.value = 120; // cut rumble/AC hum
      const worklet = new AudioWorkletNode(context, 'auso-noise-gate', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        parameterData: { threshold: -60, ratio: 3, floor: -32, attack: 0.05, release: 0.3 },
      });
      const destination = context.createMediaStreamDestination();
      source.connect(highpass);
      highpass.connect(worklet);
      worklet.connect(destination);

      this._dsp = { context, source, raw, destination };
      return destination.stream;
    } catch (err) {
      log.warn('noise-gate setup failed — falling back to raw mic', err);
      this._teardownDsp();
      return raw;
    }
  }

  _teardownDsp() {
    if (!this._dsp) return;
    try {
      this._dsp.source?.disconnect();
      this._dsp.raw?.getTracks().forEach((t) => t.stop());
      this._dsp.context?.close();
    } catch (err) { /* ignore */ }
    this._dsp = null;
  }

  async enumerate() {
    const all = await navigator.mediaDevices.enumerateDevices();
    this.devices = {
      inputs: all.filter((d) => d.kind === 'audioinput').map(pickDevice),
      outputs: all.filter((d) => d.kind === 'audiooutput').map(pickDevice),
    };
    return this.devices;
  }

  async setInputDevice(deviceId) {
    this.inputDeviceId = deviceId || null;
  }

  /** Speaker selection. Chrome/Edge only — setSinkId is not in Safari/Firefox. */
  async setOutputDevice(deviceId) {
    this.outputDeviceId = deviceId || null;
    if (this.remoteAudio && typeof this.remoteAudio.setSinkId === 'function' && deviceId) {
      try {
        await this.remoteAudio.setSinkId(deviceId);
      } catch (err) {
        log.warn('setSinkId failed (unsupported browser?)', err);
      }
    }
  }

  /** Pull the remote track(s) off the peer connection into the audio element. */
  bindRemoteStream(peerConnection) {
    if (!this.remoteAudio || !peerConnection) return;
    const stream = new MediaStream();
    peerConnection.getReceivers().forEach((receiver) => {
      if (receiver.track && receiver.track.kind === 'audio') stream.addTrack(receiver.track);
    });
    if (!stream.getAudioTracks().length) {
      log.warn('no remote audio track yet');
      return;
    }
    this.remoteAudio.srcObject = stream;
    const play = this.remoteAudio.play();
    if (play?.catch) {
      play.catch((err) => log.warn('remote audio autoplay blocked', err));
    }
    if (this.outputDeviceId) this.setOutputDevice(this.outputDeviceId);
  }

  unbindRemoteStream() {
    if (this.remoteAudio) this.remoteAudio.srcObject = null;
  }

  /**
   * Local microphone mute. Returns the new muted state.
   * @param {RTCPeerConnection} peerConnection
   * @param {boolean} muted
   */
  setMuted(peerConnection, muted) {
    if (!peerConnection) return muted;
    peerConnection.getSenders().forEach((sender) => {
      if (sender.track && sender.track.kind === 'audio') sender.track.enabled = !muted;
    });
    return muted;
  }

  /** Speaker volume 0..1 for the remote leg. */
  setVolume(volume) {
    if (this.remoteAudio) this.remoteAudio.volume = Math.min(1, Math.max(0, volume));
  }

  // ---- Tones -------------------------------------------------------------
  // Generated with WebAudio so the package ships with no binary assets.

  _ctx() {
    if (!this.toneContext) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      this.toneContext = new Ctx();
    }
    if (this.toneContext.state === 'suspended') this.toneContext.resume().catch(() => {});
    return this.toneContext;
  }

  /** Inbound ring: two tones, 2s on / 4s off (UK-style double ring). */
  startRingtone() {
    this._startTone([440, 480], { onMs: 2000, offMs: 4000 });
  }

  /** Outbound ringback heard by the agent while the far end rings. */
  startRingback() {
    this._startTone([400, 450], { onMs: 1500, offMs: 3000, gain: 0.25 });
  }

  _startTone(freqs, { onMs, offMs, gain = 0.35 }) {
    if (!this.enableTones) return;
    this.stopTone();
    const ctx = this._ctx();
    const master = ctx.createGain();
    master.gain.value = 0;
    master.connect(ctx.destination);

    const oscillators = freqs.map((f) => {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = f;
      osc.connect(master);
      osc.start();
      return osc;
    });

    const level = gain * this.ringtoneVolume;
    const cycle = () => {
      const now = ctx.currentTime;
      master.gain.setValueAtTime(level, now);
      master.gain.setValueAtTime(0, now + onMs / 1000);
    };
    cycle();
    const timer = setInterval(cycle, onMs + offMs);
    this.activeTone = { oscillators, master, timer };
  }

  stopTone() {
    if (!this.activeTone) return;
    const { oscillators, master, timer } = this.activeTone;
    clearInterval(timer);
    try {
      master.gain.value = 0;
      oscillators.forEach((o) => o.stop());
      master.disconnect();
    } catch (err) {
      log.debug('tone teardown', err);
    }
    this.activeTone = null;
  }
}

function pickDevice(d) {
  return { deviceId: d.deviceId, label: d.label || `${d.kind} (${d.deviceId.slice(0, 6)})`, kind: d.kind };
}

/**
 * The AudioWorklet source for the noise gate, delivered as a Blob URL so it
 * ships inside the bundled IIFE with no extra file to fetch.
 *
 * The gate is a RMS-tracking expander: when the smoothed signal level drops
 * below `threshold` it reduces gain toward `floor` (attenuating background
 * voices/noise when nobody is speaking), and when signal rises above threshold
 * it opens back up with a configurable attack. Attack/release are smoothed so
 * the gate doesn't chop words.
 */
const NOISE_GATE_WORKLET = `
// A gentle RMS-tracking expander / noise gate.
// - Threshold: only material BELOW this level gets attenuated, so genuine
//   speech (which is much louder) passes untouched and stays natural.
// - Ratio is low (mild expansion, not a hard gate) so nothing is ever chopped.
// - Floor is moderate: the quiet gaps between sentences are softened, never
//   silenced to digital zero.
class AusoNoiseGate extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'threshold', defaultValue: -60, minValue: -120, maxValue: 0 },
      { name: 'ratio', defaultValue: 3, minValue: 1, maxValue: 20 },
      { name: 'floor', defaultValue: -32, minValue: -120, maxValue: 0 },
      { name: 'attack', defaultValue: 0.05, minValue: 0.001, maxValue: 1 },
      { name: 'release', defaultValue: 0.30, minValue: 0.01, maxValue: 2 },
    ];
  }
  constructor() {
    super();
    this.gain = 1;  // current linear gain
    this.env = 0;   // envelope (mean square)
  }
  process(inputs, outputs, parameters) {
    const threshold = parameters.threshold[0];
    const ratioDB = parameters.ratio[0];
    const floorDB = parameters.floor[0];
    const floorLin = Math.pow(10, floorDB / 20);
    const atkCoef = 1 - Math.exp(-1 / (parameters.attack[0] * sampleRate));
    const relCoef = 1 - Math.exp(-1 / (parameters.release[0] * sampleRate));

    const input = inputs[0];
    const output = outputs[0];
    const n = Math.min(input.length, output.length);
    for (let ch = 0; ch < n; ch++) {
      const inBuf = input[ch];
      const outBuf = output[ch];
      if (!inBuf) { if (outBuf && outBuf.length) outBuf.fill(0); continue; }
      for (let i = 0; i < outBuf.length; i++) {
        const x = inBuf[i];
        // Fast-attack / slow-release mean-square detector.
        const coef = (x * x) > this.env ? 0.3 : 0.002;
        this.env += coef * (x * x - this.env);
        const envDb = 10 * Math.log10(this.env + 1e-12);

        let target;
        if (envDb >= threshold) {
          target = 1;                       // speech -> wide open
        } else {
          const below = threshold - envDb;  // how far under the threshold
          target = Math.pow(10, (below * ratioDB) / 20); // mild expansion
          target = Math.min(1, Math.max(floorLin, target));
        }
        const coef2 = target > this.gain ? atkCoef : relCoef;
        this.gain += coef2 * (target - this.gain);
        this.gain = Math.min(1, Math.max(floorLin, this.gain));
        outBuf[i] = x * this.gain;
      }
    }
    return true;
  }
}
registerProcessor('auso-noise-gate', AusoNoiseGate);
`;

function createNoiseGateWorkletURL() {
  return URL.createObjectURL(new Blob([NOISE_GATE_WORKLET], { type: 'application/javascript' }));
}
