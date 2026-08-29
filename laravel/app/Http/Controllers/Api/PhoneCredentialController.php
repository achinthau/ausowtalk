<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Services\SipCredentialProvisioner;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Log;
use Throwable;

/**
 * Spec §2 — the endpoint the browser phone calls at login.
 *
 * The agent never types SIP credentials: they authenticate to Laravel, and
 * Laravel decides which extension they may register as and issues a
 * short-lived password for it.
 */
class PhoneCredentialController extends Controller
{
    public function __construct(private readonly SipCredentialProvisioner $provisioner)
    {
        // Never cache a credential response anywhere.
        $this->middleware('auth');
        $this->middleware('throttle:60,1');
    }

    public function show(Request $request): JsonResponse
    {
        $agent = $request->user();

        if (! $agent->extension) {
            return response()->json([
                'message' => 'No SIP extension is assigned to this agent.',
            ], 422);
        }

        // The client may *hint* at an extension, but the server decides —
        // otherwise any agent could register as any extension.
        if (($requested = $request->query('extension')) && $requested !== $agent->extension) {
            Log::warning('Agent requested a different extension', [
                'agent_id'  => $agent->id,
                'requested' => $requested,
                'assigned'  => $agent->extension,
            ]);
        }

        try {
            $credential = $this->provisioner->issue($agent->extension);
        } catch (Throwable $e) {
            Log::error('Could not issue SIP credentials', [
                'agent_id' => $agent->id,
                'error'    => $e->getMessage(),
            ]);

            return response()->json(['message' => 'The phone system is unavailable.'], 503);
        }

        return response()->json([
            // The four fields from the spec §2 example.
            'extension'  => $agent->extension,
            'sip_domain' => config('ausophone.sip_domain'),
            'ws_url'     => config('ausophone.ws_url'),
            'password'   => $credential['password'],

            // Everything else the phone understands.
            'display_name'     => $agent->name,
            'expires_in'       => $credential['expires_in'],
            'register_expires' => config('ausophone.register_expires'),
            'ice_servers'      => config('ausophone.ice_servers'),
            'auto_answer'      => (bool) $agent->auto_answer,
            'branding'         => $this->brandingFor($agent),
            'agent'            => [
                'id'        => $agent->id,
                'name'      => $agent->name,
                'extension' => $agent->extension,
            ],
        ])->header('Cache-Control', 'no-store, private');
    }

    /** Spec §13 — logout must revoke, not just close the socket. */
    public function destroy(Request $request): JsonResponse
    {
        $this->provisioner->revoke($request->user()->extension);

        return response()->json(['ok' => true]);
    }

    /**
     * Spec §11 — per-tenant branding. Falls back to the app defaults when the
     * agent's tenant has not customised anything.
     */
    private function brandingFor($agent): array
    {
        $tenant = $agent->tenant ?? null;

        return array_filter([
            'logo'            => $tenant?->logo_url ?? config('ausophone.branding.logo'),
            'company_name'    => $tenant?->name ?? config('ausophone.branding.company_name'),
            'primary_color'   => $tenant?->primary_color ?? config('ausophone.branding.primary_color'),
            'show_powered_by' => config('ausophone.branding.show_powered_by'),
            'theme'           => config('ausophone.branding.theme'),
        ], fn ($v) => $v !== null);
    }
}
