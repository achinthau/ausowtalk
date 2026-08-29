<?php

namespace App\Livewire;

use App\Models\CallRecord;
use App\Models\Customer;
use Livewire\Attributes\On;
use Livewire\Component;

/**
 * Spec §12/§13 — the Livewire side of the agent console.
 *
 * Livewire deliberately does NOT own the SIP/WebRTC connection: a Livewire
 * round-trip re-renders the DOM, and re-rendering a live RTCPeerConnection
 * would drop the call. The browser phone owns the connection and emits events;
 * this component only listens and renders CRM state.
 */
class AgentConsole extends Component
{
    /** Mirrors the phone's registration state for the status indicator. */
    public string $registration = 'unregistered';

    public ?array $activeCall = null;

    public ?array $customer = null;

    public bool $autoAnswer = false;

    /** @var array<int, array{at: string, event: string, detail: string}> */
    public array $recentEvents = [];

    public function mount(): void
    {
        $this->autoAnswer = (bool) auth()->user()->auto_answer;
    }

    /**
     * The phone dispatches every event on `window` as `ausophone:<event>`.
     * The Blade view forwards the ones we care about into Livewire.
     */
    #[On('phone-registered')]
    public function onRegistered(): void
    {
        $this->registration = 'registered';
    }

    #[On('phone-unregistered')]
    public function onUnregistered(): void
    {
        $this->registration = 'unregistered';
    }

    #[On('phone-registration-failed')]
    public function onRegistrationFailed(): void
    {
        $this->registration = 'failed';
    }

    /**
     * Spec §5 — screen-pop. The phone gives us the CLI; we do the lookup here
     * so it is subject to the same authorisation as the rest of the CRM.
     */
    #[On('phone-incoming')]
    public function onIncoming(array $call): void
    {
        $this->activeCall = $call;
        $this->customer = Customer::findByPhone($call['cli'])?->only([
            'id', 'name', 'company', 'phone', 'email', 'account_number', 'notes',
        ]);

        if ($this->customer) {
            $this->customer['previous_calls'] = CallRecord::where('customer_id', $this->customer['id'])->count();
            $this->customer['last_call'] = CallRecord::where('customer_id', $this->customer['id'])
                ->latest('start_time')->value('start_time')?->format('d M Y');
        }

        $this->log('incoming', $call['cli']);
    }

    #[On('phone-answered')]
    public function onAnswered(array $call): void
    {
        $this->activeCall = $call;
        $this->log('answered', $call['cli']);
    }

    #[On('phone-hangup')]
    public function onHangup(array $call): void
    {
        $this->activeCall = null;
        $this->customer = null;
        $this->log('hangup', $call['cli'].' ('.$call['duration'].'s)');
    }

    #[On('phone-hold')]
    public function onHold(array $call): void
    {
        $this->activeCall = $call;
        $this->log('hold', $call['cli']);
    }

    #[On('phone-unhold')]
    public function onUnhold(array $call): void
    {
        $this->activeCall = $call;
        $this->log('unhold', $call['cli']);
    }

    #[On('phone-transfer')]
    public function onTransfer(string $stage, ?string $target = null): void
    {
        $this->log($stage, (string) $target);
    }

    /** Spec §6 — admin/agent toggle, persisted so it survives a reload. */
    public function toggleAutoAnswer(): void
    {
        $this->autoAnswer = ! $this->autoAnswer;
        auth()->user()->update(['auto_answer' => $this->autoAnswer]);

        // Push the new setting down to the phone.
        $this->dispatch('set-auto-answer', enabled: $this->autoAnswer);
    }

    /** Let the CRM place a call, e.g. a click-to-dial link on a customer row. */
    public function dial(string $number): void
    {
        $this->dispatch('phone-command', command: 'call', argument: $number);
    }

    private function log(string $event, string $detail = ''): void
    {
        array_unshift($this->recentEvents, [
            'at'     => now()->format('H:i:s'),
            'event'  => $event,
            'detail' => $detail,
        ]);

        $this->recentEvents = array_slice($this->recentEvents, 0, 25);
    }

    public function render()
    {
        return view('livewire.agent-console', [
            'recentCalls' => CallRecord::where('agent_id', auth()->id())
                ->latest('start_time')
                ->limit(15)
                ->get(),
        ]);
    }
}
