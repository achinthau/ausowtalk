<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        // Agents get an extension and an auto-answer preference (spec §6).
        Schema::table('users', function (Blueprint $table) {
            $table->string('extension', 16)->nullable()->unique()->after('email');
            $table->boolean('auto_answer')->default(false)->after('extension');
            // Only used when credential_strategy = 'static'. Encrypted at rest.
            $table->text('sip_password')->nullable()->after('auto_answer');
        });

        Schema::create('customers', function (Blueprint $table) {
            $table->id();
            $table->string('name');
            $table->string('company')->nullable();
            $table->string('phone', 32);
            // Last 9 digits, so 0772615908 / +94772615908 / 94772615908 match.
            $table->string('phone_normalised', 16)->index();
            $table->string('email')->nullable();
            $table->string('city')->nullable();
            $table->string('account_number', 64)->nullable();
            $table->text('notes')->nullable();
            $table->timestamps();
        });

        // Spec §10: call_id, agent_id, customer_number, recording_path,
        // start_time, end_time, duration.
        Schema::create('call_records', function (Blueprint $table) {
            $table->id();
            // The browser's SIP Call-ID.
            $table->string('call_id', 191)->nullable()->unique();
            // Asterisk's UNIQUEID, pushed by the dialplan hangup handler.
            $table->string('asterisk_unique_id', 191)->nullable()->unique();

            $table->foreignId('agent_id')->nullable()->constrained('users')->nullOnDelete();
            $table->foreignId('customer_id')->nullable()->constrained('customers')->nullOnDelete();

            $table->enum('direction', ['inbound', 'outbound', 'unknown'])->default('unknown');
            $table->string('customer_number', 32)->nullable()->index();
            $table->string('extension', 16)->nullable()->index();

            $table->timestamp('start_time')->nullable()->index();
            $table->timestamp('answer_time')->nullable();
            $table->timestamp('end_time')->nullable();

            // duration = whole call, billsec = talk time only.
            $table->unsignedInteger('duration')->default(0);
            $table->unsignedInteger('billsec')->default(0);

            $table->string('disposition', 32)->nullable();
            $table->string('end_reason', 64)->nullable();

            // MixMonitor output — the primary recording (spec §10).
            $table->string('recording_path', 191)->nullable();
            // Optional browser MediaRecorder upload.
            $table->string('browser_recording_path', 191)->nullable();

            $table->timestamps();
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('call_records');
        Schema::dropIfExists('customers');

        Schema::table('users', function (Blueprint $table) {
            $table->dropColumn(['extension', 'auto_answer', 'sip_password']);
        });
    }
};
