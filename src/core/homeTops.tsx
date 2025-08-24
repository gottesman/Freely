const chartsUrl = 'https://round-boat-07c7.gabrielgonzalez-gsun.workers.dev/';

/**
 * Parse a spotify uri formatted as "spotify:type:id" -> { type, id }
 */
function parseSpotifyUri(uri: string | null | undefined) {
	if (!uri || typeof uri !== 'string') return null;
	const parts = uri.split(':');
	if (parts.length < 3 || parts[0] !== 'spotify') return null;
	return { type: parts[1], id: parts.slice(2).join(':') };
}

function normalizeArtistsArray(arr: any[]) {
	if (!Array.isArray(arr)) return [];
	return arr.map(a => {
		const spotifyUri = a.spotifyUri || a.spotify_uri || a.uri || a.spotifyUri || a.spotifyUriString || a.spotify_uri_string || a.spotifyUri;
		const parsed = parseSpotifyUri(spotifyUri);
		return {
			name: a.name || a.artistName || '',
			uri: spotifyUri || null,
			id: parsed ? parsed.id : null,
		};
	});
}

function normalizeEntry(entry: any) {
	// rank
	const rank = entry?.chartEntryData?.currentRank ?? null;

	// Determine metadata container - common keys differ for songs/albums/artists
	// Prefer explicit metadata shapes
	const metaTrack = entry.trackMetadata || entry.track_metadata;
	const metaAlbum = entry.albumMetadata || entry.album_metadata;
	const metaArtist = entry.artistMetadata || entry.artist_metadata;
	let name = '';
	let image = null;
	let uri = null;
	let type = null;
	let id = null;
	let artists: Array<{ name?: string; id?: string | null; uri?: string | null }> = [];

	if (metaTrack) {
		name = metaTrack.trackName || metaTrack.name || '';
		image = metaTrack.displayImageUri || metaTrack.imageUri || null;
		uri = metaTrack.trackUri || metaTrack.track_uri || null;
		artists = normalizeArtistsArray(metaTrack.artists || entry.artists || []);
	} else if (metaAlbum) {
		name = metaAlbum.albumName || metaAlbum.name || '';
		image = metaAlbum.displayImageUri || metaAlbum.imageUri || null;
		uri = metaAlbum.albumUri || metaAlbum.album_uri || null;
		artists = normalizeArtistsArray(metaAlbum.artists || entry.artists || []);
	} else if (metaArtist) {
		name = metaArtist.artistName || metaArtist.name || '';
		image = metaArtist.displayImageUri || metaArtist.imageUri || null;
		uri = metaArtist.artistUri || metaArtist.artist_uri || null;
		artists = [];
	} else {
		// Fallback to older/unknown shapes
		const meta = entry.trackMetadata || entry.albumMetadata || entry.artistMetadata || entry.track_metadata || entry.album_metadata || entry.artist_metadata || {};
		name = meta.trackName || meta.albumName || meta.artistName || meta.name || '';
		image = meta.displayImageUri || meta.imageUri || meta.display_image_uri || null;
		uri = meta.trackUri || meta.albumUri || meta.artistUri || meta.track_uri || meta.album_uri || meta.artist_uri || null;
		artists = normalizeArtistsArray(meta.artists || entry.artists || []);
	}

	const parsed = parseSpotifyUri(uri);
	if (parsed) { type = parsed.type; id = parsed.id; }

	return { rank, type, id, name, image, uri, artists, raw: entry };
}

/**
 * Parse a chart group (songs/albums/artists) into normalized entries
 * chartGroup is expected to have an `entries` array.
 */
function parseChartGroup(chartGroup: any, limit?: number) {
	if (!chartGroup || !Array.isArray(chartGroup.entries)) return [];
	const list = chartGroup.entries.map(normalizeEntry);
	if (typeof limit === 'number') return list.slice(0, limit);
	return list;
}

/**
 * Fetch weekly charts and return normalized lists for songs, albums and artists.
 * Returns { songs: [], albums: [], artists: [] }
 * limit - optional number to limit each list
 */
export async function getWeeklyTops({ limit }: { limit?: number } = {}): Promise<{ songs: any[]; albums: any[]; artists: any[]; raw: any }> {
	try {
		const res = await fetch(chartsUrl);
		if (!res.ok) throw new Error('charts fetch failed: ' + res.status);
		const json = await res.json();

		// The API returns an array named chartEntryViewResponses
		const groups = json?.chartEntryViewResponses || json?.chart_entry_view_responses || [];

		// We expect order: [songs, albums, artists]
		const songsGroup = groups[0] || {};
		const albumsGroup = groups[1] || {};
		const artistsGroup = groups[2] || {};

		return {
			songs: parseChartGroup(songsGroup, limit),
			albums: parseChartGroup(albumsGroup, limit),
			artists: parseChartGroup(artistsGroup, limit),
			raw: json,
		};
	} catch (e) {
		console.warn('getWeeklyTops error', e);
		return { songs: [], albums: [], artists: [], raw: null };
	}
}

export default { chartsUrl, getWeeklyTops };