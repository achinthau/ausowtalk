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

    this._onDeviceChange = () => {
      this.enumerate().catch((err) => log.warn('device enumeration failed', err));
    };
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
    return el;
  }

  destroy() {
    navigator.mediaDevices?.removeEventListener?.('devicechange', this._onDeviceChange);
    this.stopTone();
    this.toneContext?.close().catch(() => {});
    this.toneContext = null;
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
    const stream = await navigator.mediaDevices.getUserMedia(this.getConstraints());
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
    const audio = this.inputDeviceId
      ? { deviceId: { exact: this.inputDeviceId }, echoCancellation: true, noiseSuppression: true }
      : { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
    return { audio, video: false };
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
