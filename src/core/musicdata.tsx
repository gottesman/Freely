import { env } from './accessEnv';

const API_BASE = env('GENIUS_ENDPOINT');

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
	embed_content?: string;
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
	source: 'parsed-html' | 'embed-js' | 'unavailable' | 'cached-error';
	error?: string;
	fetchedAt: number;
}

export interface SearchResponse { query: string; hits: SearchResultHit[]; raw?: any; }

/** Lightweight in-memory cache (key -> value) */
const internalCache = new Map<string, any>();

/** Utility for building cache keys */
function key(parts: unknown[]) { return parts.join('::'); }

/** Safely join a base URL and a path segment without producing `//` (except after protocol)
 * Examples:
 *  joinUrl('https://api.example.com', '/foo') => 'https://api.example.com/foo'
 *  joinUrl('https://api.example.com/', 'foo') => 'https://api.example.com/foo'
 *  joinUrl('https://api.example.com/', '/foo') => 'https://api.example.com/foo'
 */
function joinUrl(base: string, path: string) {
	if (!path) return base;
	// Keep protocol slashes (https://)
	const protocolMatch = base.match(/^([a-z0-9+.-]+:\/\/)/i);
	const protocol = protocolMatch ? protocolMatch[1] : '';
	const rest = protocol ? base.slice(protocol.length) : base;

	const left = rest.endsWith('/') ? rest.slice(0, -1) : rest;
	const right = path.startsWith('/') ? path.slice(1) : path;
	return protocol + left + '/' + right;
}

/** Request helper with timeout + basic caching */
async function http<T>(cfg: GeniusConfig, path: string, params?: Record<string, any>, cacheTtlMs = 60_000): Promise<T> {
		const search = params ? '?' + new URLSearchParams(Object.entries(params).filter(([,v]) => v !== undefined) as any) : '';
		const base = (await API_BASE) || 'https://api.genius.com';
		const url = joinUrl(base, path) + search;
	const k = key(['GET', url]);
	const cacheMap = cfg.cache ?? internalCache;
	const cached = cacheMap.get(k);
	if (cached && (Date.now() - cached.t) < cacheTtlMs) return cached.v;
	const controller = new AbortController();
	const to = setTimeout(() => controller.abort(), cfg.timeoutMs ?? 15_000);
	try {
		const token = await env('GENIUS_ACCESS_TOKEN') || '';
		const res = await fetch(url, {
			headers: {
				'Authorization': `Bearer ${token}`,
				'User-Agent': cfg.userAgent || (await env('APP_USER_AGENT') || ''),
			},
			signal: controller.signal
		});
		if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
		const json = await res.json();
		cacheMap.set(k, { v: json, t: Date.now() });
		return json;
	} finally { clearTimeout(to); }
}

/** High-level client */
export class GeniusClient {
	private cfg: GeniusConfig;
	constructor() { this.cfg = {}; }

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
			embed_content: s.embed_content,
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


	/** Retrieve lyrics by scraping song HTML page or embed.js (best-effort).
	 * Will attempt embed.js approach and use it only if it yields better results
	 * than the regular HTML scraping method.
	 */
	async getLyricsForSong(song: { id: number; url: string } | number): Promise<LyricsResult> {
		const s = typeof song === 'number' ? await this.getSong(song) : song;
		const url = s.url;
		const cacheMap = this.cfg.cache ?? internalCache;
		const ck = key(['LYRICS', url]);
		//const cached = cacheMap.get(ck);
		//if (cached) return cached;
		try {
			// Helper: attempt embed.js method if we have a numeric song id
			let embedLyrics: string | undefined;
			if (s && typeof s.id === 'number') {
				try {
					const embedUrl = `https://genius.com/songs/${s.id}/embed.js`;
					const res = await fetch(embedUrl, { headers: { 'User-Agent': this.cfg.userAgent ?? 'FreelyPlayer/0.1' } });
					if (res.ok) {
						const txt = await res.text();
						// Try to extract a JSON.parse("...") argument
						let extractedHtml: string | undefined;
						const m = txt.match(/JSON\.parse\((['\"`])([\s\S]*?)\1\)/m);
						
						if (m && m[2]) {
							try {
								const quote = m[1] || '"';
								const inner = m[2];
								// Strategy A: evaluate the reconstructed quoted literal (handles most JS escapes)
								try {
									extractedHtml = Function('"use strict"; return ' + quote + inner + quote)();
								} catch (e) {
									// ignore - will try other strategies below
								}
								// Helper to detect remaining escape sequences like "\n" or unicode escapes
								const looksEscaped = (s?: string) => !!s && /\\n|\\r|\\t|\\u[0-9a-fA-F]{4}|\\\"|\\'/.test(s);
								// If the result still looks escaped or is empty, try JSON.parse on a safely-quoted candidate
								if (!extractedHtml || looksEscaped(extractedHtml) || (/^['"`].*['"`]$/.test(String(extractedHtml)))) {
									let candidate = inner;
									// If the captured inner already begins/ends with a quote, strip it
									if ((candidate.startsWith('"') && candidate.endsWith('"')) || (candidate.startsWith("'") && candidate.endsWith("'")) || (candidate.startsWith('`') && candidate.endsWith('`'))) {
										candidate = candidate.slice(1, -1);
									}
									// Try JSON.parse by wrapping candidate in double-quotes and escaping inner double-quotes/backslashes
									try {
										extractedHtml = JSON.parse('"' + candidate.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"');
									} catch (_) {
										// Last resort: simple unescape of common sequences
										try {
											extractedHtml = candidate.replace(/(\\*)\\n/g, '\n').replace(/(\\*)\\r/g, '\r').replace(/(\\*)\\t/g, '\t').replace(/(\\*)\\"/g, '"').replace(/(\\*)\\'/g, "'");
										} catch (_) { /* ignore */ }
									}
								}
								// Normalize common JS escape sequences. Some embed.js payloads are
								// double-escaped ("\\n"), so run a few iterations to fully unescape
								// them into real characters.
								if (typeof extractedHtml === 'string') {
									const unescapeJs = (input: string) => {
										let out = input;
										for (let i = 0; i < 6; i++) {
											const prev = out;
											// First collapse double-escaped backslashes then common escapes
											out = out
												.replace(/\\\\/g, '\\')   // \\\\ -> \\\ -> \\
												.replace(/\\n/g, '\n')
												.replace(/\\r/g, '\r')
												.replace(/\\t/g, '\t')
												.replace(/\\"/g, '\"')
												.replace(/\\'/g, "\\'")
												// Then convert single-escaped sequences into real characters
												.replace(/\\n/g, '\n')
												.replace(/\\r/g, '\r')
												.replace(/\\t/g, '\t')
												.replace(/\\"/g, '"')
												.replace(/\\'/g, "'")
												// unicode escapes
												.replace(/\\u([0-9a-fA-F]{4})/g, (_, u) => String.fromCharCode(parseInt(u, 16)));
											if (out === prev) break;
										}
										// Strip surrounding quotes if present
										if ((out.startsWith('"') && out.endsWith('"')) || (out.startsWith("'") && out.endsWith("'"))) {
											out = out.slice(1, -1);
										}
										return out;
									};
									extractedHtml = unescapeJs(extractedHtml);
								}
							} catch (_) { /* ignore parse */ }
						}
						
						// Fallback: try to find a JS object with an "html" property
						if (!extractedHtml) {
							const objMatch = txt.match(/var\s+\w+\s*=\s*(\{[\s\S]*?\});/);
							if (objMatch && objMatch[1]) {
								try {
									const obj = JSON.parse(objMatch[1]);
									if (obj && typeof obj.html === 'string') extractedHtml = obj.html;
								} catch (_) { /* ignore */ }
							}
						}
						// Another fallback: document.write('...') literal
						if (!extractedHtml) {
							const dw = txt.match(/document\.write\((['\"`])([\s\S]*?)\1\)/);
							if (dw && dw[2]) {
								extractedHtml = dw[2];
							}
						}
						if (extractedHtml) {
							// Prefer parsing the extracted payload as HTML so we can reliably
							// select the embed body element (.rg_embed_body). Use DOMParser
							// in browser-like environments, fall back to creating a temporary
							// element if `document` is available, and finally fall back to
							// the previous regex heuristic when no DOM APIs exist.
							let inner: string = extractedHtml;
							try {
								if (typeof DOMParser !== 'undefined') {
									const doc = new DOMParser().parseFromString(extractedHtml, 'text/html');
									// remove any footer elements before extracting the body
									const footers = doc.querySelectorAll('.rg_embed_footer');
									footers.forEach(f => f.remove());
									const node = doc.querySelector('.rg_embed_body');
									inner = node ? (node as HTMLElement).innerHTML : (doc.body?.innerHTML || extractedHtml);
								} else if (typeof document !== 'undefined') {
									const wrapper = document.createElement('div');
									wrapper.innerHTML = extractedHtml;
									// remove any footer elements from the wrapper
									const footers = wrapper.querySelectorAll('.rg_embed_footer');
									footers.forEach(f => f.remove());
									const node = wrapper.querySelector('.rg_embed_body');
									inner = node ? (node as HTMLElement).innerHTML : wrapper.innerHTML;
								} else {
									// No DOM available; fall back to regex
									const bodyMatch = extractedHtml.match(/<div[^>]*class=(?:'|\")?[^'\"\>]*rg_embed_body[^'\"\>]*(?:'|\")?[^>]*>([\s\S]*?)<\/div>/i);
									inner = bodyMatch && bodyMatch[1] ? bodyMatch[1] : extractedHtml;
									// strip any rg_embed_footer markup if present
									inner = inner.replace(/<div[^>]*class=(?:'|\")?[^'\"\>]*rg_embed_footer[^'\"\>]*(?:'|\")?[^>]*>[\s\S]*?<\/div>/gi, '');
								}
							} catch (e) {
								// Parsing failed; fall back to regex as last resort
								const bodyMatch = extractedHtml.match(/<div[^>]*class=(?:'|\")?[^'\"\>]*rg_embed_body[^'\"\>]*(?:'|\")?[^>]*>([\s\S]*?)<\/div>/i);
								inner = bodyMatch && bodyMatch[1] ? bodyMatch[1] : extractedHtml;
								// strip any rg_embed_footer markup if present
								inner = inner.replace(/<div[^>]*class=(?:'|\")?[^'\"\>]*rg_embed_footer[^'\"\>]*(?:'|\")?[^>]*>[\s\S]*?<\/div>/gi, '');
							}
							// Decode HTML entities (some embed payloads escape HTML as entities)
							const decodeHtml = (html: string) => {
								try {
									if (typeof document !== 'undefined') {
										const ta = document.createElement('textarea');
										ta.innerHTML = html;
										return ta.value;
									}
								} catch (_) { /* ignore */ }
								// Fallback decoder for non-DOM environments
								return html
									.replace(/&lt;/g, '<')
									.replace(/&gt;/g, '>')
									.replace(/&amp;/g, '&')
									.replace(/&quot;/g, '"')
									.replace(/&#39;/g, "'")
									.replace(/&nbsp;/g, ' ')
									.replace(/&mdash;/g, '—')
									.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
									.replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCharCode(parseInt(n, 16)));
							};

							let cleaned = decodeHtml(inner);
							// Remove stray backslashes before tag characters that sometimes remain (e.g. <\/a>)
							cleaned = cleaned.replace(/\\(?=[\/<\>])/g, '');
							const text = parseLyricsFromHtml(cleaned) || stripTags(cleaned) || undefined;
							if (text && text.trim().length) embedLyrics = text.trim();
						}
					}
				} catch (e) {
					// ignore embed errors and fall back to HTML scraping
				}
			}
			/*
			// Now perform the original HTML scraping method
			const htmlRes = await fetch(url, { headers: { 'User-Agent': this.cfg.userAgent ?? 'FreelyPlayer/0.1' } });
			if (!htmlRes.ok) throw new Error(`Lyrics page HTTP ${htmlRes.status}`);
			const html = await htmlRes.text();
			const parsed = parseLyricsFromHtml(html);
			*/

			// Decide which result to use: prefer embedLyrics if it appears "better"
			let chosenLyrics: string | undefined = embedLyrics;
			let source: LyricsResult['source'] = 'embed-js';
			/*
			if (embedLyrics && embedLyrics.length > 40 && (!parsed || embedLyrics.length > (parsed.length || 0))) {
				chosenLyrics = embedLyrics;
				source = 'embed-js';
				// note: mark as 'parsed-html' for compatibility, but we could use 'embed-js'
				// use 'embed-js' if you'd like explicit source
				// prefer embed when it's substantially longer
				// fallthrough
			}
			if (!chosenLyrics) {
				if (parsed && parsed.length) {
					chosenLyrics = parsed;
					source = 'parsed-html';
				}
			}
			*/

			const formatted = chosenLyrics ? formatLyricsAsHtml(chosenLyrics) : undefined;
			const result: LyricsResult = { songId: typeof song === 'number' ? song : song.id, url, lyrics: formatted, source: chosenLyrics ? source : 'unavailable', fetchedAt: Date.now() };
			cacheMap.set(ck, result);
			return result;
		} catch (err: any) {
			const fail: LyricsResult = { songId: typeof song === 'number' ? song : song.id, url, source: 'cached-error', error: err?.message || String(err), fetchedAt: Date.now() };
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
// const genius = new GeniusClient();
// genius.search('Daft Punk').then(r => console.log(r.hits[0]));
// genius.getSong(123).then(console.log);
// genius.getLyricsForSong(123).then(console.log);

export default GeniusClient;

// Convert a plain lyrics block into structured HTML with sections and spans.
function formatLyricsAsHtml(raw: string): string {
	if (!raw) return '';
	const lines = raw.replace(/\r/g, '').split('\n').map(l => l.trim());
	const sections: { name: string; lines: string[] }[] = [];
	let current = { name: 'Lyrics', lines: [] as string[] };
	for (const line of lines) {
		if (!line) continue; // skip blank lines (removes double line breaks)
		const m = line.match(/^\s*\[(.+?)\]\s*$/);
		if (m) {
			// new section
			if (current.lines.length) sections.push(current);
			current = { name: m[1].trim(), lines: [] };
		} else {
			current.lines.push(line);
		}
	}
	if (current.lines.length) sections.push(current);
	// Build HTML
	return sections.map(s => {
		const inner = s.lines.map(l => `<span>${escapeHtml(l)}</span>`).join('');
		return `<div class="lyrics-section" data-section="${escapeHtml(s.name)}">${inner}</div>`;
	}).join('\n');
}
