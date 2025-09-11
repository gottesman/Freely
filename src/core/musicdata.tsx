import { env } from './accessEnv';

// Performance constants
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_CACHE_TTL_MS = 60_000;
const DEFAULT_USER_AGENT = 'FreelyPlayer/0.11.6';

// API configuration
const API_ENDPOINTS = {
  SEARCH: '/search',
  SONGS: '/songs',
  ARTISTS: '/artists',
  ALBUMS: '/albums'
} as const;

// HTML parsing constants
const LYRICS_SELECTORS = [
  /<div[^>]+data-lyrics-container="true"[^>]*>([\s\S]*?)<\/div>/gi,
  /<div class="lyrics"[^>]*>([\s\S]*?)<\/div>/i
] as const;

const VOID_TAGS = new Set(['br', 'hr']);
const BLOCK_TAGS = ['p', 'div', 'section', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li'];
const ALLOWED_TAGS = new Set([...BLOCK_TAGS, 'strong', 'em', 'i', 'b', 'u', 'span', 'br', 'ul', 'ol', 'li']);

// HTML entity mappings for performance
const HTML_ENTITIES = {
  '&lt;': '<',
  '&gt;': '>',
  '&amp;': '&',
  '&quot;': '"',
  '&#39;': "'",
  '&nbsp;': ' ',
  '&mdash;': '—'
} as const;

export interface GeniusConfig {
	accessToken?: string;            // If provided, used directly
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

// Utility classes for better organization
class ApiClient {
  /**
   * Get the API base URL with caching
   */
  private static apiBaseCache: string | null = null;
  
  static async getApiBase(): Promise<string> {
    if (this.apiBaseCache !== null) return this.apiBaseCache;
    this.apiBaseCache = (await env('GENIUS_ENDPOINT')) || 'https://api.genius.com';
    return this.apiBaseCache;
  }

  /**
   * Safely join URL paths without double slashes
   */
  static joinUrl(base: string, path: string): string {
    if (!path) return base;
    // Keep protocol slashes (https://)
    const protocolMatch = base.match(/^([a-z0-9+.-]+:\/\/)/i);
    const protocol = protocolMatch ? protocolMatch[1] : '';
    const rest = protocol ? base.slice(protocol.length) : base;

    const left = rest.endsWith('/') ? rest.slice(0, -1) : rest;
    const right = path.startsWith('/') ? path.slice(1) : path;
    return protocol + left + '/' + right;
  }

  /**
   * Build cache key from components
   */
  static buildCacheKey(parts: unknown[]): string {
    return parts.join('::');
  }
}

class HtmlProcessor {
  /**
   * Decode HTML entities efficiently
   */
  static decodeHtmlEntities(html: string): string {
    let result = html;
    
    // Use DOM-based decoding if available
    try {
      if (typeof document !== 'undefined') {
        const textarea = document.createElement('textarea');
        textarea.innerHTML = html;
        return textarea.value;
      }
    } catch {
      // Fallback to manual replacement
    }
    
    // Manual entity replacement
    for (const [entity, char] of Object.entries(HTML_ENTITIES)) {
      result = result.replace(new RegExp(entity, 'g'), char);
    }
    
    // Handle numeric entities
    result = result
      .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
      .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCharCode(parseInt(n, 16)));
    
    return result;
  }

  /**
   * Strip HTML tags and normalize text
   */
  static stripTags(html: string): string {
    return html
      .replace(/<br\s*\/?>(?=\n?)/gi, '\n')
      .replace(/<p[^>]*>/gi, '')
      .replace(/<\/p>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  /**
   * Escape HTML characters
   */
  static escapeHtml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /**
   * Parse lyrics from HTML using multiple selectors
   */
  static parseLyricsFromHtml(html: string): string | undefined {
    for (const regex of LYRICS_SELECTORS) {
      const parts: string[] = [];
      let match: RegExpExecArray | null;
      
      while ((match = regex.exec(html)) !== null) {
        parts.push(match[1]);
      }
      
      if (parts.length) {
        const combined = parts.join('\n');
        const text = this.stripTags(this.decodeHtmlEntities(combined));
        if (text) return text;
      }
    }
    return undefined;
  }

  /**
   * Convert a plain lyrics block into structured HTML with sections and spans
   */
  static formatLyricsAsHtml(raw: string): string {
    if (!raw) return '';
    const lines = raw.replace(/\r/g, '').split('\n').map(l => l.trim());
    const sections: { name: string; lines: string[] }[] = [];
    let current = { name: 'Lyrics', lines: [] as string[] };
    
    for (const line of lines) {
      if (!line) continue; // skip blank lines
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
      const inner = s.lines.map(l => `<span>${this.escapeHtml(l)}</span>`).join('');
      return `<div class="lyrics-section" data-section="${this.escapeHtml(s.name)}">${inner}</div>`;
    }).join('\n');
  }
}

// Lightweight in-memory cache for better performance
const internalCache = new Map<string, any>();

/** Request helper with timeout + basic caching */
async function http<T>(cfg: GeniusConfig, path: string, params?: Record<string, any>, cacheTtlMs = DEFAULT_CACHE_TTL_MS): Promise<T> {
  const search = params ? '?' + new URLSearchParams(Object.entries(params).filter(([,v]) => v !== undefined) as any) : '';
  const base = await ApiClient.getApiBase();
  const url = ApiClient.joinUrl(base, path) + search;
  const cacheKey = ApiClient.buildCacheKey(['GET', url]);
  const cacheMap = cfg.cache ?? internalCache;
  
  // Check cache first
  const cached = cacheMap.get(cacheKey);
  if (cached && (Date.now() - cached.t) < cacheTtlMs) {
    return cached.v;
  }
  
  // Setup request with timeout
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  
  try {
    const token = await env('GENIUS_ACCESS_TOKEN') || '';
    const userAgent = cfg.userAgent || (await env('APP_USER_AGENT')) || DEFAULT_USER_AGENT;
    
    const response = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'User-Agent': userAgent,
      },
      signal: controller.signal
    });
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }
    
    const json = await response.json();
    cacheMap.set(cacheKey, { v: json, t: Date.now() });
    return json;
  } finally {
    clearTimeout(timeout);
  }
}

// Mapping utilities for API responses
class ResponseMapper {
  static mapArtistSummary(artist: any): ArtistSummary {
    return {
      id: artist.id,
      name: artist.name,
      url: artist.url,
      imageUrl: artist.image_url || artist.header_image_url
    };
  }

  static mapAlbumSummary(album: any): AlbumSummary {
    return {
      id: album.id,
      name: album.name,
      url: album.url,
      coverArtUrl: album.cover_art_url
    };
  }

  static mapSearchHit(hit: any): SearchResultHit {
    const song = hit.result;
    return {
      id: song.id,
      title: song.title,
      fullTitle: song.full_title,
      url: song.url,
      headerImageUrl: song.header_image_url,
      songArtImageUrl: song.song_art_image_url,
      primaryArtist: ResponseMapper.mapArtistSummary(song.primary_artist),
      type: song._type || 'song'
    };
  }
}

// Description processing utilities
class DescriptionProcessor {
  /**
   * Flatten Genius DOM description to plain text
   */
  static flattenDescriptionDom(root: GeniusDomNode | string | undefined, acc: string[] = []): string {
    if (root == null) return acc.join('');
    if (typeof root === 'string') {
      acc.push(root);
      return acc.join('');
    }
    
    const tag = root.tag?.toLowerCase();
    const isBlock = tag && BLOCK_TAGS.includes(tag);
    
    if (tag === 'br') acc.push('\n');
    
    if (Array.isArray(root.children)) {
      for (const child of root.children) {
        DescriptionProcessor.flattenDescriptionDom(child, acc);
      }
    }
    
    if (isBlock) acc.push('\n\n');
    return acc.join('').replace(/[\t\r]+/g, '');
  }

  /**
   * Build HTML from DOM excluding anchor tags
   */
  static buildDescriptionHtml(root: GeniusDomNode | string | undefined): string {
    if (root == null) return '';
    if (typeof root === 'string') return HtmlProcessor.escapeHtml(root);
    
    const tag = (root.tag || '').toLowerCase();
    let childrenHtml = '';
    
    if (Array.isArray(root.children)) {
      childrenHtml = root.children
        .map(child => DescriptionProcessor.buildDescriptionHtml(child as any))
        .join('');
    }
    
    // Strip anchor tags but keep content
    if (tag === 'a') return childrenHtml;
    if (!tag) return childrenHtml;
    if (VOID_TAGS.has(tag)) return `<${tag}>`;
    
    // Use safe tag or fallback to span
    const safeTag = ALLOWED_TAGS.has(tag) ? tag : 'span';
    return `<${safeTag}>${childrenHtml}</${safeTag}>`;
  }

  /**
   * Build HTML from plain text
   */
  static buildHtmlFromPlain(plain: string): string {
    return plain
      .split(/\n{2,}/)
      .map(paragraph => `<p>${HtmlProcessor.escapeHtml(paragraph.trim())}</p>`)
      .join('');
  }
}

/** High-level client */
export class GeniusClient {
  private cfg: GeniusConfig;
  
  constructor() { 
    this.cfg = {}; 
  }

  async search(query: string): Promise<SearchResponse> {
    const json: any = await http(this.cfg, API_ENDPOINTS.SEARCH, { q: query });
    const hits: SearchResultHit[] = (json.response?.hits || []).map(ResponseMapper.mapSearchHit);
    return { query, hits, raw: json };
  }

  async getSong(id: number, { includeRelationships = false } = {}): Promise<SongDetails> {
    const json: any = await http(this.cfg, `${API_ENDPOINTS.SONGS}/${id}`, { text_format: 'plain' });
    const song = json.response?.song;
    if (!song) throw new Error('Song not found');
    
    const base: SongDetails = {
      id: song.id,
      title: song.title,
      fullTitle: song.full_title,
      embed_content: song.embed_content,
      url: song.url,
      releaseDate: song.release_date || song.release_date_for_display,
      headerImageUrl: song.header_image_url,
      songArtImageUrl: song.song_art_image_url,
      artist: ResponseMapper.mapArtistSummary(song.primary_artist),
      album: song.album ? ResponseMapper.mapAlbumSummary(song.album) : undefined,
      primaryArtists: (song.primary_artists || []).map(ResponseMapper.mapArtistSummary),
      featuredArtists: (song.featured_artists || []).map(ResponseMapper.mapArtistSummary),
      producerArtists: (song.producer_artists || []).map(ResponseMapper.mapArtistSummary),
      writerArtists: (song.writer_artists || []).map(ResponseMapper.mapArtistSummary),
      raw: song
    };
    
    if (includeRelationships) {
      base.relationships = song.relationships || {};
    }
    
    return base;
  }

  async getArtist(id: number): Promise<ArtistDetails> {
    const json: any = await http(this.cfg, `${API_ENDPOINTS.ARTISTS}/${id}`);
    const artist = json.response?.artist;
    if (!artist) throw new Error('Artist not found');
    
    // Process description with enhanced error handling
    let plain: string | undefined = artist.description?.plain || undefined;
    let html: string | undefined = artist.description?.html || undefined;
    
    try {
      if (!plain && artist.description?.dom) {
        plain = DescriptionProcessor.flattenDescriptionDom(artist.description.dom)?.trim() || undefined;
      }
      if (!html && artist.description?.dom) {
        html = DescriptionProcessor.buildDescriptionHtml(artist.description.dom) || undefined;
      } else if (!html && plain) {
        html = DescriptionProcessor.buildHtmlFromPlain(plain);
      }
    } catch (error) {
      console.warn('[Genius] Description processing failed:', error);
    }
    
    return {
      id: artist.id,
      name: artist.name,
      url: artist.url,
      imageUrl: artist.image_url || artist.header_image_url,
      alternateNames: artist.alternate_names || [],
      description: { plain, html },
      raw: artist
    };
  }

  async getAlbum(id: number): Promise<AlbumDetails> {
    const json: any = await http(this.cfg, `${API_ENDPOINTS.ALBUMS}/${id}`);
    const album = json.response?.album;
    if (!album) throw new Error('Album not found');
    
    return {
      id: album.id,
      name: album.name,
      fullTitle: album.full_title,
      url: album.url,
      coverArtUrl: album.cover_art_url,
      artist: album.artist ? ResponseMapper.mapArtistSummary(album.artist) : undefined,
      releaseDate: album.release_date,
      songIds: (album.tracks || []).map((track: any) => track.song?.id).filter(Boolean),
      raw: album
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
		const ck = `LYRICS_${url}`;
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
							const text = HtmlProcessor.parseLyricsFromHtml(cleaned) || HtmlProcessor.stripTags(cleaned) || undefined;
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
			const parsed = HtmlProcessor.parseLyricsFromHtml(html);
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

			const formatted = chosenLyrics ? HtmlProcessor.formatLyricsAsHtml(chosenLyrics) : undefined;
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
// Interface for Genius DOM nodes
interface GeniusDomNode { 
  tag?: string; 
  children?: Array<string | GeniusDomNode>; 
  data?: any; 
  attributes?: any; 
}

export default GeniusClient;
