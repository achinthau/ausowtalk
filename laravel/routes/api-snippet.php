<?php

/*
|------------------------------------------------------------------------------
| Paste into routes/api.php (or routes/web.php if you rely on session auth).
|------------------------------------------------------------------------------
| The phone sends the session cookie, so these must sit behind the same
| auth guard as the rest of the CRM. Route names match the Blade view.
*/

use App\Http\Controllers\Api\PhoneCallController;
use App\Http\Controllers\Api\PhoneCredentialController;
use Illuminate\Support\Facades\Route;

Route::middleware(['web', 'auth'])->group(function () {
    // Spec §2 — automatic registration.
    Route::get('/api/phone/credentials', [PhoneCredentialController::class, 'show'])
        ->name('api.phone.credentials');
    Route::delete('/api/phone/credentials', [PhoneCredentialController::class, 'destroy'])
        ->name('api.phone.credentials.revoke');

    // Spec §5 — CLI screen-pop.
    Route::get('/api/customers/lookup', [PhoneCallController::class, 'lookup'])
        ->name('api.customers.lookup');

    // Spec §10 — call records and the optional browser recording upload.
    Route::post('/api/phone/call-records', [PhoneCallController::class, 'storeCallRecord'])
        ->name('api.phone.call-records');
    Route::post('/api/phone/recordings', [PhoneCallController::class, 'storeRecording'])
        ->name('api.phone.recordings');
});

/*
| Called by the Asterisk dialplan hangup handler, which has no session. It
| authenticates with a shared secret (config('ausophone.cdr_token')).
|
| Restrict this to the PBX's address at the firewall or web-server level too:
|     Route::...->middleware('throttle:120,1');
*/
Route::get('/api/asterisk/cdr', [PhoneCallController::class, 'storeAsteriskCdr'])
    ->middleware('throttle:120,1')
    ->name('api.asterisk.cdr');

/*
| Streams a MixMonitor recording. Authorise per-record — a call recording is
| some of the most sensitive data the CRM holds.
*/
Route::middleware(['web', 'auth'])->get('/recordings/{callRecord}', function (\App\Models\CallRecord $callRecord) {
    abort_unless(auth()->user()->can('view', $callRecord), 403);
    abort_unless($callRecord->recording_path, 404);

    // MixMonitor writes to the PBX; mount or sync that directory, then:
    return response()->file(
        rtrim(config('ausophone.recording.local_mount', '/var/spool/asterisk/recordings'), '/')
        .'/'.basename($callRecord->recording_path)
    );
})->name('recordings.show');
