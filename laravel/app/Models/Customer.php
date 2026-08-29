<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\HasMany;

class Customer extends Model
{
    use HasFactory;

    protected $fillable = [
        'name', 'company', 'phone', 'phone_normalised',
        'email', 'city', 'account_number', 'notes',
    ];

    public function callRecords(): HasMany
    {
        return $this->hasMany(CallRecord::class);
    }

    /**
     * Spec §5 lookup.
     *
     * A CLI arrives in whatever format the carrier sends: 0772615908,
     * +94772615908, 94772615908. Matching on the last 9 digits handles all
     * three. `phone_normalised` is maintained by the saving hook below and is
     * indexed, so this stays a single indexed lookup rather than a scan.
     */
    public static function findByPhone(?string $phone): ?self
    {
        $key = self::normalise($phone);

        return $key === '' ? null : static::where('phone_normalised', $key)->first();
    }

    public static function normalise(?string $phone): string
    {
        $digits = preg_replace('/\D/', '', (string) $phone);

        return strlen($digits) > 9 ? substr($digits, -9) : $digits;
    }

    protected static function booted(): void
    {
        static::saving(function (self $customer) {
            $customer->phone_normalised = self::normalise($customer->phone);
        });
    }
}
