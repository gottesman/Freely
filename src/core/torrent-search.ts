import fetch from 'node-fetch';
import * as cheerio from 'cheerio';

// helper: always request with a forced cache policy and a Cache-Control header
function fetchCached(url: string, init?: any) {
  const opts = Object.assign({}, init || {}, {
    cache: 'force-cache',
    headers: Object.assign({}, init && init.headers ? init.headers : {}, {
      'Cache-Control': 'max-age=31536000'
    })
  });
  return fetch(url, opts);
}

export type TorrentResult = {
  title: string;
  infoHash?: string;
  magnetURI?: string;
  size?: string;
  seeders?: number;
  leechers?: number;
  source: string;
  url?: string;
};

export type SearchOptions = { query: string, page?: number };

export type Scraper = {
  id: string;
  name: string;
  search: (opts: SearchOptions) => Promise<TorrentResult[]>;
};

const registry = new Map<string, Scraper>();

export function registerScraper(scraper: Scraper){
  registry.set(scraper.id, scraper);
}

export function listScrapers(){
  return Array.from(registry.values()).map(s=> ({ id: s.id, name: s.name }));
}

export async function searchAll(opts: SearchOptions){
  const tasks = Array.from(registry.values()).map(s=> s.search(opts).catch(e=>{ console.warn('Scraper failed', s.id, e); return [] as TorrentResult[]; }));
  const results = await Promise.all(tasks);
  const flat = results.flat();
  // Filter: title must contain at least one word from opts.query (letters only)
  const q = String(opts?.query || '').toLowerCase();
  const qWords = q.replace(/[^a-z]+/g, ' ').trim().split(/\s+/).filter(Boolean);
  let filtered = flat;
  if (qWords.length) {
    filtered = flat.filter(r => {
      if (!r?.title) return false;
      const title = String(r.title).toLowerCase().replace(/[^a-z]+/g, ' ');
      return qWords.some(w => title.includes(w));
    });
  }
  return filtered.sort((a,b)=> (b.seeders||0) - (a.seeders||0));
}

// --- Example: ThePirateBay (public gateway scraping) ---
registerScraper({
  id: 'tpb',
  name: 'The Pirate Bay',
  search: async ({ query, page=0 }) => {
    const url = `https://tpb.party/search/${encodeURIComponent(query)}/${page}/99/0`;
  const res = await fetchCached(url, { headers: { 'User-Agent': 'freely/1.0' } });
    if(!res.ok) throw new Error('TPB fetch failed');
    const html = await res.text();
    const $ = cheerio.load(html);
    const rows = $('#searchResult tr').slice(1);
    const out: TorrentResult[] = [];
    rows.each((i: number, el: any)=>{
      // TPB has two common layouts: a .detName-based list and a table-based row where the
      // title is the second <td>. Try the .detName selector first, then fall back to
      // selecting the 2nd td's first <a>.
      let title = $(el).find('.detName a').text().trim();
      let url = $(el).find('.detName a').attr('href');
      if (!title) {
        const td = $(el).find('td').eq(1);
        const a = td.find('a').first();
        title = a.text().trim();
        url = url || a.attr('href');
      }
      const magnet = $(el).find('a[title="Download this torrent using magnet"]').attr('href');
      const size = $(el).find('td').eq(4).text() || '';
      const seeders = parseInt($(el).find('td').eq(5).text()) || 0;
      const leechers = parseInt($(el).find('td').eq(6).text()) || 0;
      out.push({ title, magnetURI: magnet, size, seeders, leechers, source: 'ThePirateBay', url });
    });
    return out;
  }
});

// --- Example: 1337x ---
registerScraper({
  id: '1337x',
  name: '1337x',
  search: async ({ query, page=1 }) => {
    const url = `https://www.1337x.to/search/${encodeURIComponent(query)}/${page}/`;
  const res = await fetchCached(url, { headers: { 'User-Agent': 'freely/1.0' } });
    if(!res.ok) throw new Error('1337x fetch failed');
    const html = await res.text();
    const $ = cheerio.load(html);
    const rows = $('table.table-list tbody tr');
    const out: TorrentResult[] = [];
    rows.each((i: number, el: any)=>{
      const title = $(el).find('td.coll-1 a').text().trim();
      const detailPath = $(el).find('td.coll-1 a').attr('href');
      const seeders = parseInt($(el).find('td.coll-2').text()) || 0;
      const leechers = parseInt($(el).find('td.coll-3').text()) || 0;
      const sizeText = $(el).find('td.coll-4').text().trim();
      const url = detailPath ? `https://www.1337x.to${detailPath}` : undefined;
      out.push({ title, seeders, leechers, size: sizeText, source: '1337x', url });
    });
    const promises = out.map(async r => {
      if(!r.url) return r;
      try {
        const dres = await fetch(r.url, { headers: { 'User-Agent': 'freely/1.0' } });
        const dhtml = await dres.text();
        const $$ = cheerio.load(dhtml);
        const magnet = $$('.download a').first().attr('href') || $$('.torrent-detail ul li a[href^="magnet:"]').attr('href');
        if(magnet) r.magnetURI = magnet;
      } catch(e){ /* ignore */ }
      return r;
    });
    return Promise.all(promises);
  }
});

// --- KickassTorrents (generic mirror tolerant) ---
registerScraper({
  id: 'kickass',
  name: 'KickassTorrents',
  search: async ({ query, page = 0 }) => {
    const url = `https://kickasstorrents.cc/search.php?q=${encodeURIComponent(query)}&field=seeders&sorder=desc&page=${page}`;
  const res = await fetchCached(url, { headers: { 'User-Agent': 'freely/1.0' } });
    if (!res.ok) throw new Error('Kickass fetch failed');
    const html = await res.text();
    const $ = cheerio.load(html);
    const out: TorrentResult[] = [];
    $('table.data tr.even').each((i, tr) => {
      try {
        const $a = $(tr).find('a');
        const title = ($a.attr('title') || $a.text() || $a.parent().text() || '').trim();
        const href = $a.attr('href') && !$a.attr('href')?.startsWith('magnet:') ? $a.attr('href') : undefined;
        const seeders = parseInt($(tr).find('td.green').text()) || 0;
        const leechers = parseInt($(tr).find('td.red').text()) || 0;
        const size = ($(tr).find('td').filter((i, el) => /MiB|GiB|KB|MB/i.test($(el).text())).first().text() || '').trim() || undefined;
        out.push({ title, size, seeders, leechers, source: 'KickAss', url: href });
      } catch (e) {}
    });
    return out.filter(r => r.title || r.magnetURI);
  }
});

// --- TorrentGalaxy ---
registerScraper({
  id: 'torrentgalaxy',
  name: 'TorrentGalaxy',
  search: async ({ query, page = 1 }) => {
    const url = `https://torrentgalaxy.hair/lmsearch?q=${encodeURIComponent(query)}&page=${page}&category=lmsearch`;
  const res = await fetchCached(url, { headers: { 'User-Agent': 'freely/1.0' } });
    if (!res.ok) throw new Error('TorrentGalaxy fetch failed');
    const html = await res.text();
    const $ = cheerio.load(html);
    const out: TorrentResult[] = [];
    $('tbody.torsearch tr').each((i, tr) => {
      const $a = $(tr).find('td.tdleft a');
      const title = ($a.attr('id-text') || $a.text() || '').trim();
      const href = $a.attr('href');
      const seeders = parseInt($(tr).find('td.tdleech').text()) || 0;
      const leechers = parseInt($(tr).find('td.tdseed').text()) || 0;
      const size = ($(tr).find('td.tdnormal').filter((i, el) => /GB|KB|MB/i.test($(el).text())).first().text() || '').trim() || undefined;
      if (title) out.push({ title, source: 'TorrentGalaxy', url: href ? href : undefined, seeders, leechers, size });
    });

    // Fetch detail pages to extract magnet URIs
    const promises = out.map(async r => {
      if (!r.url) return r;
      try {
        const detailUrl = /^https?:\/\//i.test(r.url) ? r.url : `https://torrentgalaxy.hair${r.url.startsWith('/') ? r.url : '/' + r.url}`;
  const dres = await fetchCached(detailUrl, { headers: { 'User-Agent': 'freely/1.0' } });
        if (!dres.ok) return r;
        const dhtml = await dres.text();
        const $$ = cheerio.load(dhtml);
        const magnet = $$('ul.download-links-dontblock a[href^="magnet:"]').first().attr('href');
        if (magnet) r.magnetURI = magnet;
      } catch (e) { /* ignore */ }
      return r;
    });

    return Promise.all(promises);
  }
});

// --- magnetDL ---
registerScraper({
  id: 'magnetdl',
  name: 'magnetDL',
  search: async ({ query, page = 1 }) => {
    const url = `https://magnetdl.app/search/?q=${encodeURIComponent(query)}&m=${page}`;
  const res = await fetchCached(url, { headers: { 'User-Agent': 'freely/1.0' } });
    if (!res.ok) throw new Error('magnetDL fetch failed');
    const html = await res.text();
    const $ = cheerio.load(html);
    const out: TorrentResult[] = [];
    $('tbody.torsearch tr').each((i, tr) => {
      const $tr = $(tr);
      const title = ($tr.find('td').eq(1).text() || '').trim();
      const url = $tr.find('td.m a').attr('href');
      const seeders = parseInt($tr.find('td.s').text()) || 0;
      const leechers = parseInt($tr.find('td.l').text()) || 0;
      const size = ($tr.find('td').eq(4).filter((i, el) => /GB|KB|MB/i.test($(el).text())).first().text() || '').trim() || undefined;
      out.push({ title, url, source: 'magnetDL', seeders, leechers, size });
    });

    // Fetch detail pages on magnetdl.app to extract magnet URIs
    const promises = out.map(async r => {
      if (!r.url) return r;
      try {
        let detailUrl = r.url;
        if (!/^https?:\/\//i.test(detailUrl)) {
          // normalize path to absolute URL
          if (detailUrl.startsWith('/')) detailUrl = `https://magnetdl.app${detailUrl}`;
          else detailUrl = `https://magnetdl.app/${detailUrl}`;
        }
  const dres = await fetchCached(detailUrl, { headers: { 'User-Agent': 'freely/1.0' } });
        if (!dres.ok) return r;
        const dhtml = await dres.text();
        const $$ = cheerio.load(dhtml);
        const anchor = $$('.fill-content').first().find('.col1').find('a').first();
        const magnet = anchor.attr('href');
        if (magnet) r.magnetURI = magnet;
      } catch (e) {
        // ignore per-scrape errors
      }
      return r;
    });

    return Promise.all(promises);
  }
});

// --- torrent9 ---
registerScraper({
  id: 'torrent9',
  name: 'torrent9',
  search: async ({ query, page = 1 }) => {
    const url = `https://torrent9.to/search_torrent/musique/${encodeURIComponent(query.replace(/\s/g, '-'))}.html`;
  const res = await fetchCached(url, { headers: { 'User-Agent': 'freely/1.0' } });
    if (!res.ok) throw new Error('torrent9 fetch failed');
    const html = await res.text();
    const $ = cheerio.load(html);
    const out: TorrentResult[] = [];
    $("table.table-striped tbody tr").each((i, tr) => {
      const $tr = $(tr);
      const title = ($tr.find('td').eq(0).text() || '').trim();
      const url = $tr.find('td').eq(0).find('a').attr('href') || undefined;
      const seeders = parseInt($tr.find('span.seed_ok').text()) || 0;
      const leechers = parseInt($tr.find('td').last().text()) || 0;
      const size = ($tr.find('td').eq(2).filter((i, el) => /Go|Ko|Mo/i.test($(el).text())).first().text().replace(/o/g,'B') || '').trim() || undefined;
      out.push({ title, url, source: 'torrent9', seeders, leechers, size });
    });

    // Fetch detail pages to extract magnet URIs where available
    const promises = out.map(async r => {
      if(!r.url) return r;
      try {
        const detailUrl = r.url.startsWith('http') ? r.url : `https://torrent9.to${r.url}`;
  const dres = await fetchCached(detailUrl, { headers: { 'User-Agent': 'freely/1.0' } });
        const dhtml = await dres.text();
        const $$ = cheerio.load(dhtml);
        const magnet = $$('div.download-btn a[href^="magnet:"]').first().attr('href');
        if(magnet) r.magnetURI = magnet;
      } catch(e){ }
      return r;
    });
    return Promise.all(promises);
  }
});

export default {
  registerScraper,
  listScrapers,
  searchAll,
};
