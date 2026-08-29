<?php

return [
    /*
    |--------------------------------------------------------------------------
    | PBX connection
    |--------------------------------------------------------------------------
    | These values are handed to the browser phone at login. `ws_url` must be a
    | wss:// URL served by Asterisk's HTTP server (http.conf tlsbindaddr) with a
    | certificate the agent's browser trusts.
    */
    'sip_domain' => env('AUSOPHONE_SIP_DOMAIN', 'pbx.ausoworld.com'),
    'ws_url'     => env('AUSOPHONE_WS_URL', 'wss://pbx.ausoworld.com:8089/ws'),

    /*
    |--------------------------------------------------------------------------
    | Credential strategy
    |--------------------------------------------------------------------------
    | 'rotate' — generate a fresh random SIP password per agent session and push
    |            it to Asterisk (recommended; see SipCredentialProvisioner).
    | 'static' — return the password stored on the agent record. Simplest, but
    |            the permanent PBX password reaches the browser.
    */
    'credential_strategy' => env('AUSOPHONE_CREDENTIAL_STRATEGY', 'rotate'),

    // How long an issued credential is advertised as valid (seconds). The phone
    // re-fetches shortly before this elapses.
    'credential_ttl' => (int) env('AUSOPHONE_CREDENTIAL_TTL', 3600),

    // SIP registration expiry (seconds).
    'register_expires' => (int) env('AUSOPHONE_REGISTER_EXPIRES', 300),

    /*
    |--------------------------------------------------------------------------
    | PJSIP realtime storage
    |--------------------------------------------------------------------------
    | With 'rotate', credentials are written to the ps_auths table that Asterisk
    | reads through res_config_odbc. Point this at the connection configured in
    | config/database.php for your Asterisk database.
    */
    'realtime_connection' => env('AUSOPHONE_REALTIME_CONNECTION', 'asterisk'),

    /*
    |--------------------------------------------------------------------------
    | Asterisk Manager Interface
    |--------------------------------------------------------------------------
    | Only needed if you are not using realtime and must issue `pjsip reload`,
    | or if you want to originate calls from Laravel.
    */
    'ami' => [
        'enabled' => (bool) env('AUSOPHONE_AMI_ENABLED', false),
        'host'    => env('AUSOPHONE_AMI_HOST', '127.0.0.1'),
        'port'    => (int) env('AUSOPHONE_AMI_PORT', 5038),
        'username' => env('AUSOPHONE_AMI_USER'),
        'secret'   => env('AUSOPHONE_AMI_SECRET'),
    ],

    /*
    |--------------------------------------------------------------------------
    | ICE servers
    |--------------------------------------------------------------------------
    | Empty is correct when agents and Asterisk share a network. Add a TURN
    | server for agents behind restrictive NAT / working from home.
    */
    'ice_servers' => array_values(array_filter([
        env('AUSOPHONE_STUN_URL') ? ['urls' => env('AUSOPHONE_STUN_URL')] : null,
        env('AUSOPHONE_TURN_URL') ? [
            'urls'       => env('AUSOPHONE_TURN_URL'),
            'username'   => env('AUSOPHONE_TURN_USER'),
            'credential' => env('AUSOPHONE_TURN_PASS'),
        ] : null,
    ])),

    /*
    |--------------------------------------------------------------------------
    | Branding (spec §11) — per-tenant white labelling
    |--------------------------------------------------------------------------
    */
    'branding' => [
        'logo'            => env('AUSOPHONE_LOGO', '/images/logo.png'),
        'company_name'    => env('AUSOPHONE_COMPANY', 'Auso World'),
        'primary_color'   => env('AUSOPHONE_PRIMARY_COLOR', '#0f766e'),
        'show_powered_by' => (bool) env('AUSOPHONE_POWERED_BY', true),
        'theme'           => env('AUSOPHONE_THEME', 'default'),
    ],

    /*
    |--------------------------------------------------------------------------
    | Recording (spec §10)
    |--------------------------------------------------------------------------
    | Asterisk MixMonitor is the primary mechanism. Browser recording is the
    | optional fallback and is off by default.
    */
    'recording' => [
        'browser_enabled' => (bool) env('AUSOPHONE_BROWSER_RECORDING', false),
        'disk'            => env('AUSOPHONE_RECORDING_DISK', 'local'),
        'path'            => env('AUSOPHONE_RECORDING_PATH', 'call-recordings'),
    ],

    // Shared secret the Asterisk dialplan uses to post CDRs back to Laravel.
    'cdr_token' => env('AUSOPHONE_CDR_TOKEN'),
];
