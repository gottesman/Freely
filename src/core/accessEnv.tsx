// Default values used when no environment overrides are provided.
const DEFAULTS: Record<string, string> = {
    // External token endpoint for genius proxy
    GENIUS_ENDPOINT: "https://lucky-block-579c.gabrielgonzalez-gsun.workers.dev/genius",

    // Optional: custom UA string
    APP_USER_AGENT: "FreelyPlayer/1.3.0-test",

    // Spotify API (Client Credentials for metadata lookups)
    SPOTIFY_DEFAULT_MARKET: "US",

    // External token endpoint for spotify token (e.g. Cloudflare Worker) returning
    // { "access_token":string,"expires_in":number,"expires_at":string,"expires_at_unix":number }
    SPOTIFY_TOKEN_ENDPOINT: "https://lucky-block-579c.gabrielgonzalez-gsun.workers.dev/getTokenSpotify",

    // External token endpoint for top charts (e.g. Cloudflare Worker)
    // { "chartEntryViewResponses": [{ "entries": [{ "trackMetadata":{ "trackName":string, "trackUri":string, "displayImageUri":string, "artists": [{ "name":string }] } }] }] }
    CHARTS_SPOTIFY_ENDPOINT: "https://lucky-block-579c.gabrielgonzalez-gsun.workers.dev/getChartsSpotify"
};

// Mapping of canonical keys to Vite-exposed variable names for overrides.
const VITE_KEYS: Record<string, string> = {
    GENIUS_ENDPOINT: "VITE_GENIUS_ENDPOINT",
    APP_USER_AGENT: "VITE_APP_USER_AGENT",
    SPOTIFY_DEFAULT_MARKET: "VITE_SPOTIFY_DEFAULT_MARKET",
    SPOTIFY_TOKEN_ENDPOINT: "VITE_SPOTIFY_TOKEN_ENDPOINT",
    CHARTS_SPOTIFY_ENDPOINT: "VITE_CHARTS_SPOTIFY_ENDPOINT",
};

function readViteEnv(key: string): string | undefined {
    try {
        // Vite replaces import.meta.env at build-time; only VITE_* are exposed.
        const viteEnv = (import.meta as any)?.env as Record<string, string | undefined> | undefined;
        return viteEnv ? viteEnv[key] : undefined;
    } catch {
        return undefined;
    }
}

function readNodeEnv(key: string): string | undefined {
    try {
        // In some runtimes, process.env may exist (e.g., Tauri main, tests)
        const p: any = (typeof process !== 'undefined') ? process : undefined;
        return p?.env?.[key];
    } catch {
        return undefined;
    }
}

export async function env(name: string): Promise<string | undefined> {
    const viteKey = VITE_KEYS[name] || `VITE_${name}`;
    // Priority: Vite override -> Node override -> default
    return (
        readViteEnv(viteKey)
        ?? readNodeEnv(viteKey)
        ?? readNodeEnv(name)
        ?? DEFAULTS[name]
        ?? undefined
    );
}