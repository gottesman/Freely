/**
 * Genius API Wrapper for Freely Player
 * NOTE: The official Genius API does NOT provide full lyrics via JSON responses
 * due to licensing. Lyrics retrieval here performs an HTML fetch of the song page
 * and attempts to parse visible lyric containers. Always respect copyright &
 * cache locally only for personal use.
 */

// Environment variable names expected (configure via Electron / build tooling)
// GENIUS_ACCESS_TOKEN  (Preferred: your personal access token / bearer)
// GENIUS_CLIENT_ID
// GENIUS_CLIENT_SECRET
// GENIUS_REDIRECT_URI  (Needed for OAuth browser flow)

const API_BASE = 'https://api.genius.com';

// Unified environment accessor that works in Node (Electron main) and Vite/Browser.
// Prefers actual Node process.env if available; otherwise falls back to import.meta.env.
function getEnv(name: string): string | undefined {
	// @ts-ignore - process may be undefined in browser bundle
	if (typeof process !== 'undefined' && process?.env) return process.env[name];
	// Vite exposes import.meta.env with VITE_* vars
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	if (typeof import.meta !== 'undefined' && (import.meta as any).env) {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		return (import.meta as any).env[name];
	}
	return undefined;
}

export interface GeniusConfig {
	accessToken?: string;            // If provided, used directly
	clientId?: string;               // For OAuth flow (authorization code)
	clientSecret?: string;           // For token exchange
	redirectUri?: string;            // For OAuth flow
	userAgent?: string;              // Sent in requests (helps identify app)
	timeoutMs?: number;              // Per-request timeout
	cache?: Map<string, any>;        // Optional external cache
}

export interface SearchResultHit {
	id: number;
	title: string;
	fullTitle: string;
	url: string;
	headerImageUrl?: string;
	songArtImageUrl?: string;
	primaryArtist: ArtistSummary;
	type: 'song' | string;
}

export interface ArtistSummary { id: number; name: string; url: string; imageUrl?: string; }

export interface SongDetails {
	id: number;
	title: string;
	fullTitle: string;
	url: string;
	releaseDate?: string;
	headerImageUrl?: string;
	songArtImageUrl?: string;
	artist: ArtistSummary;
	album?: AlbumSummary;
	primaryArtists: ArtistSummary[];
	featuredArtists: ArtistSummary[];
	producerArtists: ArtistSummary[];
	writerArtists: ArtistSummary[];
	relationships?: Record<string, unknown>;
	raw?: any;
}

export interface AlbumSummary { id: number; name: string; url: string; coverArtUrl?: string; }

export interface AlbumDetails extends AlbumSummary {
	fullTitle?: string;
	artist?: ArtistSummary;
	releaseDate?: string;
	songIds?: number[];
	raw?: any;
}

export interface ArtistDetails extends ArtistSummary {
	followers?: number; // The API may not expose this directly
	alternateNames?: string[];
	description?: { plain?: string; html?: string };
	raw?: any;
}

export interface LyricsResult {
	songId: number;
	url: string;
	lyrics?: string;
	source: 'parsed-html' | 'unavailable' | 'cached-error';
	error?: string;
	fetchedAt: number;
}

export interface SearchResponse { query: string; hits: SearchResultHit[]; raw?: any; }

/** Lightweight in-memory cache (key -> value) */
const internalCache = new Map<string, any>();

/** Utility for building cache keys */
function key(parts: unknown[]) { return parts.join('::'); }

/** Request helper with timeout + basic caching */
async function http<T>(cfg: GeniusConfig, path: string, params?: Record<string, any>, cacheTtlMs = 60_000): Promise<T> {
	const search = params ? '?' + new URLSearchParams(Object.entries(params).filter(([,v]) => v !== undefined) as any) : '';
	const url = API_BASE + path + search;
	const k = key(['GET', url]);
	const cacheMap = cfg.cache ?? internalCache;
	const cached = cacheMap.get(k);
	if (cached && (Date.now() - cached.t) < cacheTtlMs) return cached.v;
	const controller = new AbortController();
	const to = setTimeout(() => controller.abort(), cfg.timeoutMs ?? 15_000);
	try {
		const res = await fetch(url, {
			headers: {
				'Authorization': `Bearer ${resolveAccessToken(cfg)}`,
				'User-Agent': cfg.userAgent || getEnv('VITE_APP_USER_AGENT') || 'FreelyPlayer/0.1 (+https://example.local)'
			},
			signal: controller.signal
		});
		if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
		const json = await res.json();
		cacheMap.set(k, { v: json, t: Date.now() });
		return json;
	} finally { clearTimeout(to); }
}

function resolveAccessToken(cfg: GeniusConfig): string {
	return (
		cfg.accessToken ||
		getEnv('GENIUS_ACCESS_TOKEN') ||
		getEnv('VITE_GENIUS_ACCESS_TOKEN') ||
		''
	);
}

/** Genius OAuth helpers (authorization code flow). */
export function buildAuthorizeUrl(cfg: GeniusConfig, opts: { state?: string; scope?: string } = {}): string {
	const envClientId = getEnv('GENIUS_CLIENT_ID');
	if (!cfg.clientId && !envClientId) throw new Error('Missing clientId');
	const cid = cfg.clientId || envClientId!;
	const redirect = encodeURIComponent(cfg.redirectUri || getEnv('GENIUS_REDIRECT_URI') || '');
	const state = encodeURIComponent(opts.state || '');
	const scope = encodeURIComponent(opts.scope || 'me');
	return `https://api.genius.com/oauth/authorize?client_id=${cid}&redirect_uri=${redirect}&scope=${scope}&state=${state}&response_type=code`; 
}

export async function exchangeCodeForToken(code: string, cfg: GeniusConfig): Promise<{ accessToken: string; refreshToken?: string; raw: any; }> {
	if (!cfg.clientId || !cfg.clientSecret || !cfg.redirectUri) throw new Error('Missing OAuth config');
	const body = new URLSearchParams({ code, client_id: cfg.clientId, client_secret: cfg.clientSecret, redirect_uri: cfg.redirectUri, response_type: 'code', grant_type: 'authorization_code' });
	const res = await fetch('https://api.genius.com/oauth/token', { method: 'POST', body });
	if (!res.ok) throw new Error(`Token exchange failed: ${res.status}`);
	const json = await res.json();
	return { accessToken: json.access_token, refreshToken: json.refresh_token, raw: json };
}

/** High-level client */
export class GeniusClient {
	private cfg: GeniusConfig;
	constructor(cfg: GeniusConfig = {}) { this.cfg = cfg; }

	setAccessToken(token: string) { this.cfg.accessToken = token; }

	async search(query: string): Promise<SearchResponse> {
		const json: any = await http(this.cfg, '/search', { q: query });
		const hits: SearchResultHit[] = (json.response?.hits || []).map((h: any) => {
			const s = h.result;
			return {
				id: s.id,
				title: s.title,
				fullTitle: s.full_title,
				url: s.url,
				headerImageUrl: s.header_image_url,
				songArtImageUrl: s.song_art_image_url,
				primaryArtist: mapArtistSummary(s.primary_artist),
				type: s._type || 'song'
			};
		});
		return { query, hits, raw: json };
	}

	async getSong(id: number, { includeRelationships = false } = {}): Promise<SongDetails> {
		const json: any = await http(this.cfg, `/songs/${id}`, { text_format: 'plain' });
		const s = json.response?.song;
		if (!s) throw new Error('Song not found');
		const base: SongDetails = {
			id: s.id,
			title: s.title,
			fullTitle: s.full_title,
			url: s.url,
			releaseDate: s.release_date || s.release_date_for_display,
			headerImageUrl: s.header_image_url,
			songArtImageUrl: s.song_art_image_url,
			artist: mapArtistSummary(s.primary_artist),
			album: s.album ? mapAlbumSummary(s.album) : undefined,
			primaryArtists: (s.primary_artists || []).map(mapArtistSummary),
			featuredArtists: (s.featured_artists || []).map(mapArtistSummary),
			producerArtists: (s.producer_artists || []).map(mapArtistSummary),
			writerArtists: (s.writer_artists || []).map(mapArtistSummary),
			raw: s
		};
		if (includeRelationships) base.relationships = s.relationships || {};
		return base;
	}

	async getArtist(id: number): Promise<ArtistDetails> {
		const json: any = await http(this.cfg, `/artists/${id}`);
		const a = json.response?.artist;
		if (!a) throw new Error('Artist not found');
		// Derive plain & HTML description (excluding anchor <a> tags)
		let plain: string | undefined = a.description?.plain || undefined;
		let html: string | undefined = a.description?.html || undefined; // if API ever supplies
		try {
			if (!plain && a.description?.dom) {
				plain = flattenDescriptionDom(a.description.dom)?.trim() || undefined;
			}
			if (!html && a.description?.dom) {
				html = buildDescriptionHtml(a.description.dom) || undefined;
			} else if(!html && plain) {
				// Build minimal HTML from plain paragraphs
				html = buildHtmlFromPlain(plain);
			}
		} catch (_) { /* ignore parse issues */ }
		return {
			id: a.id,
			name: a.name,
			url: a.url,
			imageUrl: a.image_url || a.header_image_url,
			alternateNames: a.alternate_names || [],
			description: { plain, html },
			raw: a
		};
	}

	async getAlbum(id: number): Promise<AlbumDetails> {
		const json: any = await http(this.cfg, `/albums/${id}`);
		const a = json.response?.album;
		if (!a) throw new Error('Album not found');
		return {
			id: a.id,
			name: a.name,
			fullTitle: a.full_title,
			url: a.url,
			coverArtUrl: a.cover_art_url,
			artist: a.artist ? mapArtistSummary(a.artist) : undefined,
			releaseDate: a.release_date,
			songIds: (a.tracks || []).map((t: any) => t.song?.id).filter(Boolean),
			raw: a
		};
	}

	/** Retrieve lyrics by scraping song HTML page (best-effort). */
	async getLyricsForSong(song: { id: number; url: string } | number): Promise<LyricsResult> {
		const s = typeof song === 'number' ? await this.getSong(song) : song;
		const url = s.url;
		const cacheMap = this.cfg.cache ?? internalCache;
		const ck = key(['LYRICS', url]);
		const cached = cacheMap.get(ck);
		if (cached) return cached;
		try {
			const htmlRes = await fetch(url, { headers: { 'User-Agent': this.cfg.userAgent ?? 'FreelyPlayer/0.1' } });
			if (!htmlRes.ok) throw new Error(`Lyrics page HTTP ${htmlRes.status}`);
			const html = await htmlRes.text();
			const lyrics = parseLyricsFromHtml(html);
			const result: LyricsResult = { songId: typeof song === 'number' ? song : song.id, url, lyrics, source: lyrics ? 'parsed-html' : 'unavailable', fetchedAt: Date.now() };
			cacheMap.set(ck, result);
			return result;
		} catch (err: any) {
			const fail: LyricsResult = { songId: typeof song === 'number' ? song : song.id, url, source: 'cached-error', error: err.message, fetchedAt: Date.now() };
			cacheMap.set(ck, fail);
			return fail;
		}
	}
}

/* ---------------- Mapping Helpers ---------------- */
function mapArtistSummary(a: any): ArtistSummary { return { id: a.id, name: a.name, url: a.url, imageUrl: a.image_url || a.header_image_url }; }
function mapAlbumSummary(a: any): AlbumSummary { return { id: a.id, name: a.name, url: a.url, coverArtUrl: a.cover_art_url }; }

/* -------------- Lyrics HTML Parsing -------------- */
// Parsing approach: Genius updates markup periodically. We try multiple known selectors.
// This is deliberately simple (regex & DOM optional). In an Electron environment you can
// use DOMParser (in renderer) or JSDOM (if added) – here we stay dependency-free.
const LYRICS_SELECTORS = [
	/<div[^>]+data-lyrics-container="true"[^>]*>([\s\S]*?)<\/div>/gi,
	/<div class="lyrics"[^>]*>([\s\S]*?)<\/div>/i
];

function stripTags(html: string): string {
	return html
		.replace(/<br\s*\/?>(?=\n?)/gi, '\n')
		.replace(/<p[^>]*>/gi, '')
		.replace(/<\/p>/gi, '\n')
		.replace(/<[^>]+>/g, '')
		.replace(/&amp;/g, '&')
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&nbsp;/g, ' ')
		.replace(/&mdash;/g, '—')
		.replace(/\n{3,}/g, '\n\n')
		.trim();
}

function parseLyricsFromHtml(html: string): string | undefined {
	for (const re of LYRICS_SELECTORS) {
		const parts: string[] = [];
		let m: RegExpExecArray | null;
		while ((m = re.exec(html)) !== null) {
			parts.push(m[1]);
		}
		if (parts.length) {
			const combined = parts.join('\n');
			const text = stripTags(combined);
			if (text) return text;
		}
	}
	return undefined;
}

/* -------------- Genius description DOM -> plain text -------------- */
// Genius sometimes provides rich description as a DOM-like JSON tree (a.description.dom)
// Example node: { tag: 'p', children: ['Some text ', { tag:'a', children:['link text'] }, ' more'] }
// We flatten by concatenating strings, recursing into children, and separating block elements with double newlines.
interface GeniusDomNode { tag?: string; children?: Array<string | GeniusDomNode>; data?: any; attributes?: any; }
function flattenDescriptionDom(root: GeniusDomNode | string | undefined, acc: string[] = []): string {
	if (root == null) return acc.join('');
	if (typeof root === 'string') { acc.push(root); return acc.join(''); }
	const tag = root.tag?.toLowerCase();
	const isBlock = tag && ['p','div','section','br','h1','h2','h3','h4','h5','h6','ul','ol','li'].includes(tag);
	if (tag === 'br') acc.push('\n');
	if (Array.isArray(root.children)) {
		for (const child of root.children) flattenDescriptionDom(child, acc);
	}
	if (isBlock) acc.push('\n\n');
	return acc.join('').replace(/[\t\r]+/g,'');
}

// Build HTML version excluding anchor tags (<a>) but preserving basic block & inline structure
function buildDescriptionHtml(root: GeniusDomNode | string | undefined): string {
	if(root == null) return '';
	if(typeof root === 'string') return escapeHtml(root);
	const tag = (root.tag||'').toLowerCase();
	const voidTags = new Set(['br','hr']);
	const blockLike = ['p','div','section','h1','h2','h3','h4','h5','h6','ul','ol','li'];
	let childrenHtml = '';
	if(Array.isArray(root.children)) childrenHtml = root.children.map(c=> buildDescriptionHtml(c as any)).join('');
	if(tag === 'a') { // strip link tag but keep its text/children
		return childrenHtml;
	}
	if(!tag) return childrenHtml; // root without tag
	if(voidTags.has(tag)) return `<${tag}>`;
	// Only allow a whitelist of tags; others become <span>
	const allowed = new Set([...blockLike,'strong','em','i','b','u','span','br','ul','ol','li']);
	const safeTag = allowed.has(tag) ? tag : 'span';
	return `<${safeTag}>${childrenHtml}</${safeTag}>`;
}

function buildHtmlFromPlain(plain: string): string {
	return plain.split(/\n{2,}/).map(p=> `<p>${escapeHtml(p.trim())}</p>`).join('');
}

function escapeHtml(s: string): string {
	return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

/* -------------- Example Usage (Remove / Adapt) -------------- */
// const genius = new GeniusClient({ accessToken: process.env.GENIUS_ACCESS_TOKEN });
// genius.search('Daft Punk').then(r => console.log(r.hits[0]));
// genius.getSong(123).then(console.log);
// genius.getLyricsForSong(123).then(console.log);

export default GeniusClient;
