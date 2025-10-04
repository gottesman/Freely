# Plugin System & Manifest (V1)

This document describes the JSON-based plugin system used to add/modify plugins at runtime without writing code and explains the Manifest V1 format for that purpose.

## Overview

- Two plugin roots:
  1. Bundled (read‑only): `public/plugins`
  2. User (read/write): `<app_config_dir>/plugins`
- User plugins (by `name`) override bundled ones.
- A plugin is described by a JSON manifest plus any auxiliary assets (optionally scripts for future kinds). The current system is declarative only; no arbitrary remote code execution.
- Manifest schema versioning is tracked via the top‑level numeric `version` (currently `1`).

## Index File (`plugins/index.json`)

Located in each root. An array of entries (path of `manifest` is relative to the index file directory):

```jsonc
[
  { "name": "My Plugin", "version": "1.0.0", "directory": "myplugin", "enabled": true }
]
```

The user index (if present) is merged after bundled; duplicates by `name` replace earlier ones.

## Manifest Top-Level Shape (V1)

```jsonc
{
  "version": "1.0",          // numeric schema version
  "name": "My Plugin",       // human readable name
  "provider": "myplugin.org",// optional provider / domain label
  "kind": "torrent-indexer"  // discriminant for plugin kind
  // kind specific fields follow
}
```

Currently supported kinds:
1. `torrent-indexer`
2. `script` (early / limited; future runtime controls; executed once on app start)

---
## Kind: `torrent-indexer`

Example:
```jsonc
{
  "version": "1.0",
  "name": "Searcher",
  "provider": "example.com",
  "kind": "torrent-indexer",
  "spec": {
    "network": {
      "method": "GET", // default GET if omitted
      "url_template": "https://example.com/search?q={query}&page={page}",
      "headers": { "User-Agent": "..." },
      "pagination": { "param": "page", "start": 1, "limit": 3 },
      "throttle_ms": 800
    },
    "parse": {
      "row_selector": "table tr",
      "fields": {
        "title":   { "selector": "h3 a", "attr": "text" },
        "magnet":  { "selector": "a[href^=\"magnet:\"]", "attr": "href" },
        "seeders": { "selector": ".fa-arrow-up + .font-medium", "attr": "text", "transform": ["parseInt"] },
        "url":     { "selector": "h3 a", "attr": "href", "base_url": "https://example.com" }
      }
    }
  }
}
```

### Field Semantics
- `network.url_template`: supports `{query}` and `{page}` placeholders.
- `network.pagination.limit`: number of pages to fetch (>=1). `start` defaults to 1.
- `network.throttle_ms`: optional delay BETWEEN page fetches (per provider throttle).
- `parse.row_selector`: CSS selector for a single result row element.
- `parse.fields`: map of logical output field names → extraction rule.

Extraction rule keys:
- `selector` (required): CSS selector relative to row scope (falls back to whole doc if not found in row) 
- `attr`: `text` (default) or attribute name
- `base_url`: if present and value resolves to a relative URL, it is joined to produce an absolute URL
- `transform`: ordered list of string operation names (see transforms)

### Standard Output Fields (normalized)
- `title`: string
- `magnet`: string (magnet URI)
- `size`: number (bytes) — usually via `parseSize` transform
- `seeders`: number
- `leechers`: number
- `url`: string (optional detail URL)

---
## Transform Operations

Supported operation names (case-insensitive; dash or camel accepted):
- `trim` – trim surrounding whitespace
- `parseInt` – extract first integer number
- `parseSize` – parse human sizes (KB/MB/GB/TB → bytes)

Legacy / planned (still supported from older docs but may be normalized internally):
- `parseFloat`
- `regexReplace` (legacy structured form may be converted internally)
- `prepend` / `base_url` usage

Unknown operation names are ignored (soft-fail) but preserved internally for forward compatibility.

---
## Kind: `script`

Early example:
```jsonc
{
  "version": "1.0",
  "name": "example-javascript-plugin",
  "provider": "example.com",
  "kind": "script",
  "entry": "plugin.js",
  "notes": "Plugin demo that adds a javascript to the frontend."
}
```

---
## Validation Rules

The loader currently enforces:
- For `torrent-indexer`: `spec.network.url_template` and `spec.parse.row_selector` must be non-empty, and at least one field under `parse.fields`.
- For `script`: `entry` must be non-empty.

If validation fails the plugin is skipped with a logged warning.

---
## Security Model

- Declarative manifests only; no arbitrary code execution for indexers.
- HTTP headers may be filtered/allow-listed (dangerous headers like `Authorization` discarded unless explicitly permitted Tauri-side).
- Cookies (if ever supported in this spec) must be literal; no interactive login flows.
- HTML parsed via the Rust `scraper` crate (CSS only; no XPath, JS eval, or DOM scripting).

---
## Runtime Behavior

- Indices merged (bundled first, then user) by `name`.
- Exposed commands (Rust side examples):
  - `torrent_list_scrapers` → basic metadata (name, provider, kind, capabilities)
  - `torrent_search` → `{ query: string, provider?: string }` returning aggregated normalized rows
- Throttling: `throttle_ms` respected between sequential page fetches for a single provider.
- Multi-page: pages fetched sequentially from `start` to `start + limit - 1`.

---
## Troubleshooting

- Build logs still reference `ManifestSearch`: indicates stale code or un-migrated manifest; clean build (`cargo clean`).
- Parsing failure: check required fields (`version`, `kind`, required spec keys) and JSON syntax.
- Empty results: verify `row_selector` selects rows in fetched HTML; test the raw page with browser dev tools.
- Incorrect absolute URLs: ensure `base_url` or transforms are correct; relative path may start with `/`.

---
## Adding a User Plugin

1. Create directory: `<app_config_dir>/plugins/myindexer/` and add `manifest.json`.
2. Add (or update) entry in `<app_config_dir>/plugins/index.json`:
   ```json
   { "name": "MyIndexer", "version": "1.0.0", "directory": "myindexer", "enabled": true }
   ```
3. Restart the app.
4. Verify in UI / logs that the provider appears.

---
## Examples

Bundled: 
- `public/plugins/example/manifest.json`

---
## Roadmap / Future Extensions

- Additional transform operations (regex capture groups, hashing, date parsing)
- Multi-stage fetch pipelines (detail page enrichment)
- Script runtime sandbox constraints (timeouts, memory limits, capability flags)

---
This document will evolve as new plugin kinds and capabilities are introduced.
