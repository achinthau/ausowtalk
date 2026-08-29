import { createLogger } from './logger.js';
import { PhoneEvents } from './events.js';

const log = createLogger('RecordingManager');

/**
 * Optional browser-side recording (spec §10).
 *
 * The spec is explicit that server-side Asterisk MixMonitor is the primary
 * mechanism because it survives a browser crash — this class exists for the
 * "optional feature" row in the matrix. It mixes the local mic and the remote
 * stream into one track via WebAudio, records with MediaRecorder, and uploads
 * the blob to Laravel.
 */
export class RecordingManager {
  constructor({ events, config }) {
    this.events = events;
    this.config = config;
    /** @type {Map<string, object>} callId → recording session */
    this.sessions = new Map();
  }

  get supported() {
    return typeof window !== 'undefined' && typeof window.MediaRecorder !== 'undefined';
  }

  /** Pick a container the browser actually supports. Chrome → webm/opus. */
  _mimeType() {
    const candidates = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/ogg;codecs=opus',
      'audio/mp4',
    ];
    return candidates.find((t) => MediaRecorder.isTypeSupported(t)) ?? '';
  }

  /**
   * @param {import('./Call.js').Call} call
   */
  start(call) {
    if (!this.supported) throw new Error('MediaRecorder is not available in this browser');
    if (this.sessions.has(call.id)) return this.sessions.get(call.id).info;

    const pc = call.peerConnection;
    if (!pc) throw new Error('Call has no peer connection yet');

    const Ctx = window.AudioContext || window.webkitAudioContext;
    const ctx = new Ctx();
    const destination = ctx.createMediaStreamDestination();
    let trackCount = 0;

    // Outbound (agent microphone)
    pc.getSenders().forEach((sender) => {
      if (sender.track?.kind !== 'audio') return;
      ctx.createMediaStreamSource(new MediaStream([sender.track])).connect(destination);
      trackCount += 1;
    });
    // Inbound (customer)
    pc.getReceivers().forEach((receiver) => {
      if (receiver.track?.kind !== 'audio') return;
      ctx.createMediaStreamSource(new MediaStream([receiver.track])).connect(destination);
      trackCount += 1;
    });

    if (!trackCount) {
      ctx.close().catch(() => {});
      throw new Error('No audio tracks to record');
    }

    const mimeType = this._mimeType();
    const recorder = new MediaRecorder(destination.stream, mimeType ? { mimeType } : undefined);
    const chunks = [];
    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunks.push(e.data);
    };
    recorder.onerror = (e) => {
      log.error('recorder error', e.error);
      this.events.emit(PhoneEvents.ERROR, { scope: 'recording', message: String(e.error) });
    };

    recorder.start(1000); // 1s timeslice so a crash still leaves usable data
    call.recording = true;

    const info = { call_id: call.id, started_at: new Date().toISOString(), mime_type: mimeType };
    this.sessions.set(call.id, { recorder, chunks, ctx, info, call });
    this.events.emit(PhoneEvents.RECORDING_STARTED, { call: call.toJSON(), recording: info });
    return info;
  }

  /**
   * Stop and (optionally) upload. Resolves with `{ blob, info, upload }`.
   * @param {string} callId
   * @param {object} [opts]
   * @param {boolean} [opts.upload] defaults to config.recording.autoUpload
   */
  async stop(callId, opts = {}) {
    const session = this.sessions.get(callId);
    if (!session) return null;
    this.sessions.delete(callId);

    const { recorder, chunks, ctx, info, call } = session;
    const blob = await new Promise((resolve) => {
      recorder.onstop = () => resolve(new Blob(chunks, { type: info.mime_type || 'audio/webm' }));
      if (recorder.state !== 'inactive') recorder.stop();
      else resolve(new Blob(chunks, { type: info.mime_type || 'audio/webm' }));
    });
    ctx.close().catch(() => {});
    call.recording = false;

    const finished = {
      ...info,
      ended_at: new Date().toISOString(),
      size_bytes: blob.size,
      duration: call.durationSeconds,
    };
    this.events.emit(PhoneEvents.RECORDING_STOPPED, { call: call.toJSON(), recording: finished });

    const shouldUpload = opts.upload ?? this.config.recording?.autoUpload ?? false;
    let upload = null;
    if (shouldUpload && blob.size > 0) {
      upload = await this.upload(blob, finished, call).catch((err) => {
        log.error('recording upload failed', err);
        this.events.emit(PhoneEvents.ERROR, { scope: 'recording', message: err.message });
        return null;
      });
    }
    return { blob, info: finished, upload };
  }

  /** POST the blob to the Laravel endpoint as multipart/form-data. */
  async upload(blob, info, call) {
    const url = this.config.recording?.uploadUrl;
    if (!url) throw new Error('recording.uploadUrl is not configured');

    const form = new FormData();
    const ext = (info.mime_type || '').includes('mp4') ? 'm4a' : 'webm';
    form.append('recording', blob, `${info.call_id}.${ext}`);
    form.append('call_id', info.call_id);
    form.append('direction', call.direction);
    form.append('customer_number', call.cli);
    form.append('started_at', info.started_at);
    form.append('ended_at', info.ended_at);
    form.append('duration', String(info.duration));

    const res = await fetch(url, {
      method: 'POST',
      body: form,
      credentials: this.config.credentialsMode ?? 'same-origin',
      headers: this.config.headers ?? {},
    });
    if (!res.ok) throw new Error(`Upload failed: HTTP ${res.status}`);
    const json = await res.json().catch(() => ({}));
    this.events.emit(PhoneEvents.RECORDING_UPLOADED, { call: call.toJSON(), recording: info, response: json });
    return json;
  }

  /** Stop everything without uploading — used on teardown. */
  async abortAll() {
    await Promise.allSettled([...this.sessions.keys()].map((id) => this.stop(id, { upload: false })));
  }
}
