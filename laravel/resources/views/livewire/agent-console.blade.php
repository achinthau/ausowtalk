{{--
  Spec §12/§13 — agent console.

  The phone element owns the SIP connection and lives OUTSIDE any Livewire
  re-render (wire:ignore). Livewire only renders CRM state and reacts to events.
--}}
<div class="grid grid-cols-1 gap-6 lg:grid-cols-[360px_1fr]">

    {{-- ------------------------------------------------------------------ --}}
    {{-- The phone. wire:ignore is essential: a Livewire DOM patch would    --}}
    {{-- tear down the live RTCPeerConnection and drop the call.            --}}
    {{-- ------------------------------------------------------------------ --}}
    <div wire:ignore>
        <auso-phone
            id="auso-phone"
            credentials-url="{{ route('api.phone.credentials') }}"
            lookup-url="{{ route('api.customers.lookup') }}"
            call-record-url="{{ route('api.phone.call-records') }}"
            company-name="{{ config('ausophone.branding.company_name') }}"
            logo="{{ config('ausophone.branding.logo') }}"
            primary-color="{{ config('ausophone.branding.primary_color') }}"
            @if(auth()->user()->auto_answer) auto-answer @endif
            auto-login
        ></auso-phone>
    </div>

    <div class="space-y-6">
        {{-- Registration status --}}
        <div class="flex items-center gap-3 text-sm">
            <span @class([
                'h-2.5 w-2.5 rounded-full',
                'bg-green-500' => $registration === 'registered',
                'bg-red-500'   => $registration === 'failed',
                'bg-slate-400' => ! in_array($registration, ['registered', 'failed']),
            ])></span>
            <span class="capitalize">{{ $registration }}</span>
            <span class="text-slate-400">·</span>
            <span>Ext {{ auth()->user()->extension }}</span>

            <button wire:click="toggleAutoAnswer"
                    class="ml-auto rounded-lg border px-3 py-1.5 text-xs font-semibold
                           {{ $autoAnswer ? 'border-teal-600 bg-teal-50 text-teal-700' : 'border-slate-300' }}">
                Auto answer {{ $autoAnswer ? 'on' : 'off' }}
            </button>
        </div>

        {{-- Screen-pop (spec §5) --}}
        <div class="rounded-xl border bg-white p-5 shadow-sm">
            @if ($activeCall)
                <div class="flex flex-wrap items-baseline gap-3 border-b pb-3">
                    <span class="text-xl font-semibold">{{ $customer['name'] ?? 'Unknown caller' }}</span>
                    <span class="rounded-full bg-teal-100 px-2 py-0.5 text-xs font-bold uppercase text-teal-800">
                        {{ $activeCall['direction'] }}
                    </span>
                    <span class="tabular-nums text-slate-500">{{ $activeCall['cli'] }}</span>
                </div>

                <dl class="mt-3 grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
                    @if ($customer)
                        @foreach ([
                            'Company'        => $customer['company'] ?? null,
                            'Account'        => $customer['account_number'] ?? null,
                            'Email'          => $customer['email'] ?? null,
                            'Previous calls' => $customer['previous_calls'] ?? null,
                            'Last call'      => $customer['last_call'] ?? null,
                            'Notes'          => $customer['notes'] ?? null,
                        ] as $label => $value)
                            @if ($value !== null && $value !== '')
                                <dt class="text-slate-500">{{ $label }}</dt>
                                <dd class="font-medium">{{ $value }}</dd>
                            @endif
                        @endforeach
                    @else
                        <dt class="text-slate-500">Lookup</dt>
                        <dd class="font-medium text-amber-600">No customer matched this number</dd>
                    @endif
                    <dt class="text-slate-500">State</dt>
                    <dd class="font-medium">{{ $activeCall['state'] }}</dd>
                </dl>
            @else
                <p class="text-sm text-slate-500">
                    No active call. The customer record appears here as soon as an
                    <code class="rounded bg-slate-100 px-1">incoming</code> event arrives.
                </p>
            @endif
        </div>

        {{-- Recent calls --}}
        <div class="overflow-hidden rounded-xl border bg-white shadow-sm">
            <table class="w-full text-sm">
                <thead class="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                    <tr>
                        <th class="p-3 text-left">When</th>
                        <th class="p-3 text-left">Direction</th>
                        <th class="p-3 text-left">Number</th>
                        <th class="p-3 text-left">Talk time</th>
                        <th class="p-3 text-left">Recording</th>
                    </tr>
                </thead>
                <tbody>
                    @forelse ($recentCalls as $call)
                        <tr class="border-t">
                            <td class="p-3 tabular-nums">{{ $call->start_time?->format('d M H:i') }}</td>
                            <td class="p-3">{{ $call->direction }}</td>
                            <td class="p-3 tabular-nums">
                                <button wire:click="dial('{{ $call->customer_number }}')"
                                        class="text-teal-700 hover:underline">{{ $call->customer_number }}</button>
                            </td>
                            <td class="p-3 tabular-nums">{{ gmdate('i:s', $call->billsec ?: $call->duration) }}</td>
                            <td class="p-3">
                                @if ($call->recording_path)
                                    <audio controls preload="none" class="h-7"
                                           src="{{ route('recordings.show', $call) }}"></audio>
                                @else
                                    <span class="text-slate-400">—</span>
                                @endif
                            </td>
                        </tr>
                    @empty
                        <tr><td colspan="5" class="p-5 text-center italic text-slate-400">No calls yet</td></tr>
                    @endforelse
                </tbody>
            </table>
        </div>

        {{-- Event trace, useful while wiring the CRM up --}}
        @if ($recentEvents)
            <div class="rounded-xl bg-slate-900 p-3 font-mono text-xs text-slate-300">
                @foreach ($recentEvents as $e)
                    <div class="flex gap-3 border-b border-white/5 py-0.5">
                        <span class="text-slate-500">{{ $e['at'] }}</span>
                        <span class="font-bold">{{ $e['event'] }}</span>
                        <span class="text-slate-400">{{ $e['detail'] }}</span>
                    </div>
                @endforeach
            </div>
        @endif
    </div>
</div>

@script
<script>
    // ---------------------------------------------------------------------
    // Bridge: browser phone events  →  Livewire
    //
    // The phone dispatches every event from spec §3 on `window` as
    // `ausophone:<event>`. We forward only the ones the server component acts
    // on — forwarding all of them (including the 1 Hz `call_updated` tick)
    // would cause a Livewire round-trip every second.
    // ---------------------------------------------------------------------
    const forward = {
        registered:          () => $wire.dispatch('phone-registered'),
        unregistered:        () => $wire.dispatch('phone-unregistered'),
        registration_failed: () => $wire.dispatch('phone-registration-failed'),
        incoming:  (e) => $wire.dispatch('phone-incoming', { call: e.call }),
        answered:  (e) => $wire.dispatch('phone-answered', { call: e.call }),
        hangup:    (e) => $wire.dispatch('phone-hangup',   { call: e.call }),
        hold:      (e) => $wire.dispatch('phone-hold',     { call: e.call }),
        unhold:    (e) => $wire.dispatch('phone-unhold',   { call: e.call }),
        transfer_started:   (e) => $wire.dispatch('phone-transfer', { stage: 'transfer_started', target: e.target }),
        transfer_completed: (e) => $wire.dispatch('phone-transfer', { stage: 'transfer_completed', target: e.target }),
        transfer_failed:    (e) => $wire.dispatch('phone-transfer', { stage: 'transfer_failed', target: e.target }),
    };

    for (const [name, handler] of Object.entries(forward)) {
        window.addEventListener(`ausophone:${name}`, (ev) => handler(ev.detail));
    }

    // ---------------------------------------------------------------------
    // Bridge: Livewire  →  phone commands (spec §4)
    // ---------------------------------------------------------------------
    $wire.on('phone-command', ({ command, argument }) => {
        window.AusoPhone[command](argument);
    });

    $wire.on('set-auto-answer', ({ enabled }) => {
        window.AusoPhone.setAutoAnswer(enabled);
    });

    // Spec §13: unregister when the agent navigates away so the Asterisk
    // endpoint goes unavailable immediately rather than waiting for expiry.
    window.addEventListener('beforeunload', () => {
        if (window.AusoPhone?.status().registered) window.AusoPhone.logout();
    });
</script>
@endscript
