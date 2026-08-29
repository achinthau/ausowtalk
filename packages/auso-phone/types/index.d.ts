export type Direction = 'inbound' | 'outbound';
export type CallState = 'new' | 'dialing' | 'ringing' | 'answered' | 'held' | 'ended';
export type RegistrationState = 'unregistered' | 'registering' | 'registered' | 'failed';
export type ConnectionState = 'disconnected' | 'connecting' | 'connected';

export type PhoneEventName =
  | 'connecting' | 'connected' | 'disconnected'
  | 'registered' | 'unregistered' | 'registration_failed'
  | 'incoming' | 'dialing' | 'ringing' | 'answered' | 'hangup'
  | 'hold' | 'unhold' | 'mute' | 'unmute'
  | 'transfer' | 'transfer_started' | 'transfer_completed' | 'transfer_failed'
  | 'dtmf' | 'recording_started' | 'recording_stopped' | 'recording_uploaded'
  | 'call_updated' | 'devices_changed' | 'error'
  | '*';

/** The payload shape documented in spec §3 and §5. */
export interface CallPayload {
  call_id: string;
  direction: Direction;
  cli: string;
  remote_identity: string;
  remote_display_name: string;
  state: CallState;
  muted: boolean;
  held: boolean;
  recording: boolean;
  consultation: boolean;
  duration: number;
  created_at: string;
  answered_at: string | null;
  ended_at: string | null;
  end_reason: string | null;
  customer: Record<string, unknown> | null;
}

export interface PhoneEvent {
  event: PhoneEventName;
  at: string;
  call?: CallPayload;
  calls?: CallPayload[];
  [key: string]: unknown;
}

export interface Branding {
  logo?: string | null;
  company_name?: string;
  primary_color?: string;
  show_powered_by?: boolean;
  theme?: string;
}

/** What Laravel's credentials endpoint must return (spec §2). */
export interface SipCredentials {
  extension: string;
  sip_domain: string;
  ws_url: string;
  password: string;
  auth_user?: string;
  display_name?: string;
  expires_in?: number;
  register_expires?: number;
  ice_servers?: RTCIceServer[];
  auto_answer?: boolean;
  branding?: Branding;
  agent?: Record<string, unknown>;
}

export interface AusoPhoneConfig {
  credentialsUrl?: string;
  lookupUrl?: string | null;
  callRecordUrl?: string | null;
  headers?: Record<string, string>;
  credentialsMode?: RequestCredentials;
  sip_domain?: string | null;
  iceServers?: RTCIceServer[];
  iceGatheringTimeout?: number;
  registerExpires?: number;
  autoAnswer?: boolean;
  autoAnswerDelayMs?: number;
  credentialRefreshLeadSeconds?: number;
  traceSip?: boolean;
  logLevel?: 'debug' | 'info' | 'warn' | 'error' | 'silent';
  branding?: Branding;
  recording?: {
    enabled?: boolean;
    autoStart?: boolean;
    autoUpload?: boolean;
    uploadUrl?: string;
  };
}

export interface PhoneStatus {
  initialised: boolean;
  connection: ConnectionState;
  registration: RegistrationState;
  registered: boolean;
  extension: string | null;
  agent: Record<string, unknown> | null;
  auto_answer: boolean;
  branding: Required<Branding>;
  active_call: CallPayload | null;
  calls: CallPayload[];
  transfer: PendingTransfer | null;
  credentials_expire_at: string | null;
}

export interface PendingTransfer {
  type: 'attended';
  stage: 'consulting' | 'ringing' | 'connected';
  primaryCallId: string;
  consultCallId: string | null;
  target: string;
}

export interface MediaDeviceSummary {
  deviceId: string;
  label: string;
  kind: string;
}

export declare class AusoPhone {
  config: Required<AusoPhoneConfig>;
  initialised: boolean;

  init(config?: AusoPhoneConfig): this;
  login(opts?: { extension?: string; credentials?: SipCredentials; requestMedia?: boolean }): Promise<PhoneStatus>;
  logout(): Promise<PhoneStatus>;
  destroy(): Promise<void>;
  fetchCredentials(opts?: { extension?: string }): Promise<SipCredentials>;

  call(number: string, opts?: { consultation?: boolean; extraHeaders?: Record<string, string> }): Promise<CallPayload>;
  answer(callId?: string): Promise<CallPayload>;
  reject(callId?: string, opts?: { statusCode?: number; reason?: string }): Promise<CallPayload>;
  hangup(callId?: string): Promise<CallPayload>;

  hold(callId?: string): Promise<CallPayload>;
  unhold(callId?: string): Promise<CallPayload>;
  toggleHold(callId?: string): Promise<CallPayload>;

  mute(callId?: string): CallPayload;
  unmute(callId?: string): CallPayload;
  toggleMute(callId?: string): CallPayload;

  sendDTMF(tones: string, opts?: { mode?: 'auto' | 'rtp' | 'info'; duration?: number }): Promise<string>;

  transfer(target: string, opts?: { type?: 'blind' | 'attended'; callId?: string }): Promise<unknown>;
  attendedTransfer(target: string, callId?: string): Promise<unknown>;
  completeTransfer(): Promise<unknown>;
  cancelTransfer(): Promise<unknown>;
  swapTransferLegs(): Promise<CallPayload | null>;

  setAutoAnswer(enabled: boolean, opts?: { delayMs?: number }): boolean;
  getAutoAnswer(): boolean;

  startRecording(callId?: string): unknown;
  stopRecording(callId?: string, opts?: { upload?: boolean }): Promise<unknown>;

  listDevices(): Promise<{ inputs: MediaDeviceSummary[]; outputs: MediaDeviceSummary[] }>;
  setInputDevice(deviceId: string): Promise<void>;
  setOutputDevice(deviceId: string): Promise<void>;
  setVolume(volume: number): void;

  lookupCustomer(cli: string, callId?: string): Promise<Record<string, unknown> | null>;
  attachCustomer(callId: string, customer: Record<string, unknown>): CallPayload | null;

  status(): PhoneStatus;
  getCalls(): CallPayload[];
  getActiveCall(): CallPayload | null;
  eventLog(): PhoneEvent[];

  on(event: PhoneEventName, handler: (e: PhoneEvent) => void): () => void;
  once(event: PhoneEventName, handler: (e: PhoneEvent) => void): () => void;
  off(event: PhoneEventName, handler?: (e: PhoneEvent) => void): void;
}

export declare const phone: AusoPhone;
export declare const PhoneEvents: Record<string, PhoneEventName>;
export declare function setLogLevel(level: string): void;
export declare function defineAusoPhoneElement(tag?: string): string;
export declare class AusoPhoneElement extends HTMLElement {
  phone: AusoPhone;
  configure(options?: AusoPhoneConfig): this;
  login(opts?: { extension?: string; config?: AusoPhoneConfig }): Promise<PhoneStatus>;
  logout(): Promise<PhoneStatus>;
}

declare global {
  interface Window {
    AusoPhone: AusoPhone;
  }
}

export default phone;
