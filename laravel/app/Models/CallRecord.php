<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

/**
 * The call_records table from spec §10.
 */
class CallRecord extends Model
{
    use HasFactory;

    protected $fillable = [
        'call_id', 'asterisk_unique_id', 'agent_id', 'customer_id',
        'direction', 'customer_number', 'extension',
        'start_time', 'answer_time', 'end_time',
        'duration', 'billsec', 'disposition', 'end_reason',
        'recording_path', 'browser_recording_path',
    ];

    protected $casts = [
        'start_time'  => 'datetime',
        'answer_time' => 'datetime',
        'end_time'    => 'datetime',
        'duration'    => 'integer',
        'billsec'     => 'integer',
    ];

    public function agent(): BelongsTo
    {
        return $this->belongsTo(User::class, 'agent_id');
    }

    public function customer(): BelongsTo
    {
        return $this->belongsTo(Customer::class);
    }

    public function getWasAnsweredAttribute(): bool
    {
        return $this->answer_time !== null || $this->disposition === 'ANSWERED';
    }
}
