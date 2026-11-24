/**
 * CRM dial context travels in two places: X-Auso-* SIP headers on the INVITE
 * and `dial_params` in every call event payload. Both must carry cmphotline,
 * and neither may let CRM text inject extra SIP headers.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { Call } from '../src/Call.js';
import { toDialParamHeaders } from '../src/CallManager.js';

const params = {
  type: '2',
  exten: '2002',
  num: '0772615908',
  tenant: 'auso',
  uid: 22,
  dialer: 'singer',
  cmphotline: '0112345678',
};

test('maps every CRM dial parameter to an X-Auso SIP header', () => {
  assert.deepEqual(toDialParamHeaders(params), [
    'X-Auso-Type: 2',
    'X-Auso-Exten: 2002',
    'X-Auso-Num: 0772615908',
    'X-Auso-Tenant: auso',
    'X-Auso-Uid: 22',
    'X-Auso-Dialer: singer',
    'X-Auso-Cmphotline: 0112345678',
  ]);
});

test('skips empty values and strips line breaks from header values', () => {
  const headers = toDialParamHeaders({
    ...params,
    cmphotline: null,
    dialer: 'bad\r\nX-Injected: 1',
  });

  assert.ok(!headers.some((h) => h.startsWith('X-Auso-Cmphotline:')), 'null hotline omitted');
  assert.ok(headers.includes('X-Auso-Dialer: bad X-Injected: 1'), 'CRLF folded away');
});

test('attaches the same dial context to every call event payload', () => {
  const call = new Call({
    session: { request: { callId: 'call-1' } },
    direction: 'outbound',
    remoteIdentity: '0772615908',
    dialParams: params,
  });

  assert.deepEqual(call.toJSON().dial_params, params);
});
