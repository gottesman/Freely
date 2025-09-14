const vars: Record<string, string> = {
    // External token endpoint for spotify token (e.g. Cloudflare Worker) returning
    // { "access_token":string,"expires_in":number,"expires_at":string,"expires_at_unix":number }
    GENIUS_ENDPOINT: "https://lucky-block-579c.gabrielgonzalez-gsun.workers.dev/genius",

    // Optional: custom UA string
    APP_USER_AGENT: "FreelyPlayer/0.13.0",

    // Spotify API (Client Credentials for metadata lookups)
    SPOTIFY_DEFAULT_MARKET: "US",

    // External token endpoint for spotify token (e.g. Cloudflare Worker) returning
    // { "access_token":string,"expires_in":number,"expires_at":string,"expires_at_unix":number }
    SPOTIFY_TOKEN_ENDPOINT: "https://lucky-block-579c.gabrielgonzalez-gsun.workers.dev/getTokenSpotify",

    // External token endpoint for top charts (e.g. Cloudflare Worker) returning
    // { "chartEntryViewResponses": [{ "entries": [{ "trackMetadata":{ "trackName":string, "trackUri":string, "displayImageUri":string, "artists": [{ "name":string }] } }] }] }
    CHARTS_SPOTIFY_ENDPOINT: "https://lucky-block-579c.gabrielgonzalez-gsun.workers.dev/getChartsSpotify"
};
export async function env(name: string): Promise<string | undefined> {
    return vars[name] || undefined;
}