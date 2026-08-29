<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\CallRecord;
use App\Models\Customer;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Storage;

/**
 * Customer lookup (spec §5), call records and recordings (spec §10).
 */
class PhoneCallController extends Controller
{
    public function __construct()
    {
        $this->middleware('auth');
    }

    /**
     * Spec §5 — CLI → customer screen-pop.
     *
     * GET /api/customers/lookup?phone=0772615908
     */
    public function lookup(Request $request): JsonResponse
    {
        $request->validate(['phone' => ['required', 'string', 'max:32']]);

        $customer = Customer::findByPhone($request->query('phone'));

        if (! $customer) {
            // An unknown caller is not an error — the phone still screen-pops.
            return response()->json([
                'found' => false,
                'phone' => $request->query('phone'),
                'name'  => null,
            ]);
        }

        $calls = $customer->callRecords()->latest('start_time');

        return response()->json([
            'found'           => true,
            'id'              => $customer->id,
            'name'            => $customer->name,
            'company'         => $customer->company,
            'phone'           => $customer->phone,
            'email'           => $customer->email,
            'account_number'  => $customer->account_number,
            'notes'           => $customer->notes,
            'previous_calls'  => $calls->count(),
            'last_call'       => optional($calls->first())->start_time?->format('d M Y'),
        ]);
    }

    /**
     * Spec §10 — the browser reports the call it just finished.
     *
     * Treated as advisory: Asterisk's CDR is authoritative (it survives a
     * browser crash), so this upserts on call_id and never overwrites
     * server-side fields.
     */
    public function storeCallRecord(Request $request): JsonResponse
    {
        $data = $request->validate([
            'call_id'         => ['required', 'string', 'max:191'],
            'direction'       => ['nullable', 'in:inbound,outbound'],
            'customer_number' => ['nullable', 'string', 'max:32'],
            'extension'       => ['nullable', 'string', 'max:16'],
            'start_time'      => ['nullable', 'date'],
            'answer_time'     => ['nullable', 'date'],
            'end_time'        => ['nullable', 'date'],
            'duration'        => ['nullable', 'integer', 'min:0'],
            'end_reason'      => ['nullable', 'string', 'max:64'],
        ]);

        $record = CallRecord::updateOrCreate(
            ['call_id' => $data['call_id']],
            $data + [
                'agent_id'    => $request->user()->id,
                'customer_id' => Customer::findByPhone($data['customer_number'] ?? '')?->id,
            ],
        );

        return response()->json(['record' => $record], 201);
    }

    /**
     * Spec §10 (optional) — browser-recorded audio upload.
     *
     * Only reachable when browser recording is enabled; server-side MixMonitor
     * remains the primary mechanism.
     */
    public function storeRecording(Request $request): JsonResponse
    {
        abort_unless(config('ausophone.recording.browser_enabled'), 404);

        $request->validate([
            'recording'       => ['required', 'file', 'mimetypes:audio/webm,audio/ogg,audio/mp4', 'max:51200'],
            'call_id'         => ['required', 'string', 'max:191'],
            'customer_number' => ['nullable', 'string', 'max:32'],
            'duration'        => ['nullable', 'integer', 'min:0'],
        ]);

        $path = $request->file('recording')->store(
            config('ausophone.recording.path'),
            config('ausophone.recording.disk'),
        );

        $record = CallRecord::updateOrCreate(
            ['call_id' => $request->input('call_id')],
            [
                'agent_id'               => $request->user()->id,
                'customer_number'        => $request->input('customer_number'),
                'duration'               => $request->integer('duration'),
                'browser_recording_path' => $path,
            ],
        );

        return response()->json([
            'path'   => Storage::disk(config('ausophone.recording.disk'))->url($path),
            'record' => $record,
        ], 201);
    }

    /**
     * Spec §10 — Asterisk's own CDR, pushed from the dialplan hangup handler.
     *
     * Unauthenticated (there is no session behind a dialplan curl), so it is
     * guarded by a shared secret and should additionally be firewalled to the
     * PBX's address.
     */
    public function storeAsteriskCdr(Request $request): JsonResponse
    {
        abort_unless(
            hash_equals((string) config('ausophone.cdr_token'), (string) $request->query('token')),
            403,
        );

        $data = $request->validate([
            'call_id'     => ['required', 'string', 'max:191'],
            'src'         => ['nullable', 'string', 'max:32'],
            'dst'         => ['nullable', 'string', 'max:32'],
            'disposition' => ['nullable', 'string', 'max:32'],
            'billsec'     => ['nullable', 'integer', 'min:0'],
            'duration'    => ['nullable', 'integer', 'min:0'],
            'recording'   => ['nullable', 'string', 'max:191'],
            'start'       => ['nullable', 'date'],
            'end'         => ['nullable', 'date'],
        ]);

        $record = CallRecord::updateOrCreate(
            ['asterisk_unique_id' => $data['call_id']],
            [
                'customer_number' => $data['src'] ?? null,
                'extension'       => $data['dst'] ?? null,
                'disposition'     => $data['disposition'] ?? null,
                'billsec'         => $data['billsec'] ?? 0,
                'duration'        => $data['duration'] ?? 0,
                'recording_path'  => $data['recording'] ?? null,
                'start_time'      => $data['start'] ?? null,
                'end_time'        => $data['end'] ?? null,
            ],
        );

        return response()->json(['ok' => true, 'record' => $record]);
    }
}
