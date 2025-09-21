// core/lyrics-musixmatch.ts

// Minimal Musixmatch lyrics provider for Freely
// Mirrors core logic from onetagger musixmatch.rs: token.get + macro.subtitles.get
// Prefers richsync > subtitles (LRC) > plain lyrics. Outputs simple HTML (unsynced).

type MxHeader = { status_code: number };
type MxResponse<B> = { message: { header: MxHeader; body?: B } };
type MxMacroCalls<B> = { macro_calls: Record<string, MxResponse<B>> };

type MxLyricsBody = { lyrics: { lyrics_id: number; lyrics_body: string; lyrics_language: string } };
type MxSubtitleWrap = { subtitle: { subtitle_id: number; subtitle_body: string; subtitle_length: number; subtitle_language: string; subtitle_language_description: string } };
type MxSubtitlesBody = { subtitle_list: MxSubtitleWrap[] };
type MxRichsync = { richsync: { richsync_id: number; richsync_body: string; richsync_length: number; richssync_language: string; richsync_language_description: string } };
type MxBodyVariant = MxLyricsBody | MxSubtitlesBody | MxRichsync | Record<string, any>;

export type SyncedLyricPart = { text: string; start: number };
// **FIX**: The 'end' property is now required to match the LyricsOverlay component's needs.
export type SyncedLyricLine = { text: string; start: number; end: number; parts?: SyncedLyricPart[] };
export type SyncedLyrics = { lines: SyncedLyricLine[]; kind: 'richsync' | 'lrc' };

export type MusixmatchLyricsResult = {
  html?: string;
  synced?: SyncedLyrics;
  source: 'musixmatch-richsync' | 'musixmatch-subtitle' | 'musixmatch-plain' | 'musixmatch-unavailable' | 'musixmatch-error';
  error?: string;
};

import { runTauriCommand } from './TauriCommands';

export default class MusixmatchClient {
  private token: string | null = null;
  private base = 'https://apic-desktop.musixmatch.com/ws/1.1/';

  private async delay(ms: number) { return new Promise(res => setTimeout(res, ms)); }

  private async get<T>(action: string, query: Record<string, string>): Promise<T> {
    if (action !== 'token.get' && !this.token) {
      await this.fetchToken();
    }
    const params = new URLSearchParams({ ...query, app_id: 'web-desktop-app-v1.0', t: String(Date.now()) });
    if (this.token) params.set('usertoken', this.token);

    const url = `${this.base}${action}?${params.toString()}`;
    const res = await fetch(url, { method: 'GET' });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    return res.json() as Promise<T>;
  }

  private async fetchToken(retries = 0): Promise<void> {
    const json = await this.get<MxResponse<any>>('token.get', { user_language: 'en' });
    const status = json?.message?.header?.status_code ?? 0;
    if (status === 401) {
      if (retries >= 3) throw new Error('Musixmatch captcha/unauthorized (token)');
      await this.delay(2000 * Math.pow(2, retries));
      return this.fetchToken(retries + 1);
    }
    const token = (json as any)?.message?.body?.user_token as string | undefined;
    if (!token) throw new Error('Musixmatch token missing in response');
    this.token = token;
  }

  async fetchLyrics(title: string, artist: string): Promise<MusixmatchLyricsResult> {
    try {
      const body = await runTauriCommand<any>('musixmatch_fetch_lyrics', { title, artist });
      if (body && !(body as any).error) {
        return this.processMacroCalls(body as MxMacroCalls<MxBodyVariant>);
      }
      return { source: 'musixmatch-unavailable' };
    } catch (e: any) {
      return { source: 'musixmatch-error', error: e?.message || String(e) };
    }
  }

  private processMacroCalls(body?: MxMacroCalls<MxBodyVariant>): MusixmatchLyricsResult {
    const calls = body?.macro_calls || {};
    // Prefer richsync
    const rich = calls['track.richsync.get']?.message?.body as any;
    const richsync = rich?.richsync as MxRichsync['richsync'] | undefined;
    if (richsync?.richsync_body) {
      try {
        const arr = JSON.parse(richsync.richsync_body) as Array<{ ts?: number; te?: number; x?: string; l?: Array<{ c: string; o: number }> }>;
        const lines: SyncedLyricLine[] = [];
        for (let i = 0; i < arr.length; i++) {
          const item = arr[i];
          const text = (item.x ?? '').trim();
          if (!text) continue;

          const start = typeof item.ts === 'number' ? item.ts : 0;
          // **FIX**: Guarantee an 'end' time. Prioritize 'te', then the next line's 'ts', then a fallback.
          const end = typeof item.te === 'number' ? item.te : (arr[i + 1]?.ts ?? start + 5);

          const parts: SyncedLyricPart[] | undefined = Array.isArray(item.l)
            ? item.l.map(p => ({
                text: p.c ?? '',
                start: start + (p.o ?? 0),
              }))
            : undefined;
          
          lines.push({ text, start, end, parts });
        }
        if (lines.length) {
          const html = this.formatPlainAsHtml(lines.map(l => l.text).join('\n'));
          return { html, synced: { lines, kind: 'richsync' }, source: 'musixmatch-richsync' };
        }
      } catch (_) { /* ignore parse errors */ }
    }

    // Then subtitles (LRC)
    const sub = calls['track.subtitles.get']?.message?.body as any;
    const list = sub?.subtitle_list as MxSubtitleWrap[] | undefined;
    const first = Array.isArray(list) && list.length ? list[0] : undefined;
    const lrc = first?.subtitle?.subtitle_body;
    if (lrc) {
      const parsed = this.parseLrc(lrc);
      if (parsed.length > 0) {
        const linesWithEndTimes = this.inferEndTimes(parsed);
        const html = this.formatPlainAsHtml(linesWithEndTimes.map(l => l.text).join('\n'));
        return { html, synced: { lines: linesWithEndTimes, kind: 'lrc' }, source: 'musixmatch-subtitle' };
      }
    }

    // Finally plain lyrics
    const lyr = calls['track.lyrics.get']?.message?.body as any;
    const lyricsBody = (lyr?.lyrics as any)?.lyrics_body as string | undefined;
    if (lyricsBody && lyricsBody.trim()) {
      const cleaned = this.cleanMusixmatchPlain(lyricsBody);
      const html = this.formatPlainAsHtml(cleaned);
      if (html) return { html, source: 'musixmatch-plain' };
    }

    return { source: 'musixmatch-unavailable' };
  }

  private parseLrc(lrc: string): Omit<SyncedLyricLine, 'end'>[] {
    const lines = lrc.split(/\r?\n/);
    const out: Omit<SyncedLyricLine, 'end'>[] = [];
    for (const raw of lines) {
      if (!raw || /^\s*\[(ti|ar|al|by|offset):/i.test(raw)) continue;
      const matches = Array.from(raw.matchAll(/\[(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?\]/g));
      const text = raw.replace(/\[[^\]]+\]/g, '').trim();
      if (!matches.length || !text) continue;
      for (const m of matches) {
        const min = Number(m[1] || 0);
        const sec = Number(m[2] || 0);
        const ms = Number(m[3] || 0);
        const start = min * 60 + sec + ms / (m[3]?.length === 3 ? 1000 : 100);
        out.push({ text, start });
      }
    }
    out.sort((a, b) => a.start - b.start);
    return out;
  }

  private inferEndTimes(lines: Omit<SyncedLyricLine, 'end'>[]): SyncedLyricLine[] {
    const out: SyncedLyricLine[] = [];
    for (let i = 0; i < lines.length; i++) {
      const cur = lines[i];
      const next = lines[i + 1];
      // **FIX**: The end is the start of the next line, or for the last line, add a default duration.
      const end = next ? next.start : cur.start + 5;
      out.push({ ...cur, end });
    }
    return out;
  }

  private cleanMusixmatchPlain(s: string): string {
    const lines = s.split(/\r?\n/).filter(l => !/\*{3,}/.test(l));
    return lines.join('\n').trim();
  }

  private formatPlainAsHtml(raw: string | undefined): string | undefined {
    if (!raw) return undefined;
    const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    const paragraphs = raw.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean).map(p => `<p>${esc(p).replace(/\n/g, '<br/>')}</p>`);
    return paragraphs.join('');
  }
}