use crate::paths::PathConfig;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
// logging macros available globally
use std::fs;
use std::path::{Path, PathBuf};
// no extra io traits needed here

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PluginIndexEntry {
    pub name: String,
    #[serde(default)]
    pub version: String,
    #[serde(default)]
    pub manifest: String,
    #[serde(default)]
    pub directory: Option<String>,
    #[serde(default)]
    pub enabled: Option<bool>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ManifestPagination {
    #[serde(default = "default_pagination_start")] 
    pub start: u32,
    pub param: Option<String>,
    pub limit: Option<u32>,
}

fn default_pagination_start() -> u32 { 1 }


#[derive(Debug, Deserialize, Serialize, Clone)]
// NOTE: Manifest files in repository and documentation use snake_case keys
// (url_template, row_selector, throttle_ms, base_url, etc.).
// Previously this struct (and related ones) declared `rename_all = "kebab-case"`,
// causing serde to expect keys like `url-template` which did not match the JSON,
// leading to parse failures and runtime warnings: "manifest parse failed".
// Switching to snake_case fixes compatibility with existing manifests.
#[serde(rename_all = "snake_case")]
pub struct ManifestV1Network {
    #[serde(default = "default_get_method")] pub method: String,
    pub url_template: String,
    #[serde(default)] pub headers: Option<HashMap<String,String>>,
    #[serde(default)] pub throttle_ms: Option<u64>,
    #[serde(default)] pub pagination: Option<ManifestPagination>,
}

fn default_get_method() -> String { "GET".to_string() }

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "snake_case")]
pub struct ManifestV1ParseField {
    pub selector: String,
    #[serde(default)] pub attr: Option<String>,
    #[serde(default)] pub base_url: Option<String>,
    #[serde(default)] pub transform: Option<Vec<String>>, // will map to legacy JSON value
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "snake_case")]
pub struct ManifestV1ParseSpec {
    pub row_selector: String,
    pub fields: HashMap<String, ManifestV1ParseField>,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "snake_case")]
pub struct ManifestV1TorrentSpec {
    pub network: ManifestV1Network,
    pub parse: ManifestV1ParseSpec,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "snake_case")]
pub struct ManifestV1ScriptRuntime {
    pub language: String,
    #[serde(default)] pub sandbox: Option<bool>,
    #[serde(default)] pub timeout_ms: Option<u64>,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "snake_case")]
pub struct ManifestV1ScriptSpec {
    pub entry: String,
    #[serde(default)] pub runtime: Option<ManifestV1ScriptRuntime>,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum ManifestV1Kind {
    #[serde(rename = "torrent-indexer")] TorrentIndexer { spec: ManifestV1TorrentSpec },
    #[serde(rename = "script")] Script { entry: String, #[serde(default)] runtime: Option<ManifestV1ScriptRuntime> },
}

#[derive(Debug, Deserialize, Serialize, Clone)]
// Top-level keys already appear in mixed / expected explicit forms (`version`, `name`, `provider`).
// We do not apply rename_all here to avoid unintended transformations; only nested structs needed correction.
pub struct ManifestV1 {
    pub version: String,
    pub name: String,
    #[serde(default)] pub provider: Option<String>,
    #[serde(default)] pub notes: Option<String>,
    #[serde(flatten)] pub kind: ManifestV1Kind,
    #[serde(default)] pub enabled: Option<bool>,
}

fn parse_manifest_v1(path: &Path) -> Option<ManifestV1> {
    let s = fs::read_to_string(path).ok()?;
    match serde_json::from_str::<ManifestV1>(&s) {
        Ok(m) => Some(m),
        Err(e) => {
            #[cfg(debug_assertions)]
            log_warn!("[plugins] manifest json error at {}: {}", path.display(), e);
            None
        }
    }
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct LoadedPlugin {
    pub name: String,
    pub version: String,
    pub provider: Option<String>,
    pub manifest_path: PathBuf,
    pub manifest: ManifestV1,
    pub enabled_from_index: Option<bool>,
}

fn read_index(root: &Path) -> Vec<PluginIndexEntry> {
    let index_path = root.join("index.json");
    if !index_path.exists() { return vec![]; }
    match fs::read_to_string(&index_path) {
        Ok(s) => match serde_json::from_str::<Vec<PluginIndexEntry>>(&s) {
            Ok(v) => v,
            Err(e) => {
                log_warn!("[plugins] Bad index at {}: {}", index_path.display(), e);
                vec![]
            }
        },
        Err(e) => {
            log_warn!("[plugins] Failed reading {}: {}", index_path.display(), e);
            vec![]
        }
    }
}

fn resolve_manifest_path(root: &Path, entry: &PluginIndexEntry) -> PathBuf {
    // Prefer directory if provided — assume manifest.json inside it
    if let Some(dir) = entry.directory.as_ref() {
        let d = dir.trim();
        if !d.is_empty() {
            let trimmed = d.trim_start_matches(['/', '\\']);
            let out = root.join(trimmed).join("manifest.json");
            #[cfg(debug_assertions)]
            log_debug!("[plugins] resolve (directory) dir='{}' root='{}' -> {}", d, root.display(), out.display());
            return out;
        }
    }
    // Normalize string first to avoid Windows-root semantics for "\\foo" or "/foo" when joining
    let raw = entry.manifest.trim();
    let has_drive = raw.chars().nth(1) == Some(':'); // e.g., "D:\\..."
    let is_unc = raw.starts_with("\\\\?\\") || raw.starts_with("\\\\");
    // Treat only true absolute Windows paths as absolute. Leading '/' or '\\' (rooted) are handled below
    let is_absolute = has_drive || is_unc;

    if is_absolute {
        // Honor truly absolute paths as-is
        #[cfg(debug_assertions)]
    log_debug!("[plugins] resolve (absolute) raw='{}' -> {}", raw, PathBuf::from(raw).display());
        return PathBuf::from(raw);
    }

    // Trim any leading root markers so PathBuf::join won't root to drive (D:\\...)
    let trimmed = raw.trim_start_matches(['/', '\\']);

    // If manifest path is rooted under "plugins/...", it expects resolution against the parent of plugins root
    let lowered = trimmed.to_ascii_lowercase();
    if lowered.starts_with("plugins/") || lowered.starts_with("plugins\\") {
        let base = root.parent().unwrap_or(root);
        let out = base.join(trimmed);
        #[cfg(debug_assertions)]
    log_debug!("[plugins] resolve (plugins-root) raw='{}' base='{}' trimmed='{}' -> {}", raw, base.display(), trimmed, out.display());
        return out;
    }

    let out = root.join(trimmed);
    #[cfg(debug_assertions)]
    log_debug!("[plugins] resolve (relative) raw='{}' root='{}' trimmed='{}' -> {}", raw, root.display(), trimmed, out.display());
    out
}

fn read_manifest(path: &Path) -> Option<ManifestV1> { parse_manifest_v1(path) }

/// Build an enabled map from index.json files across roots.
/// Precedence: user index > resource index > dev public index.
fn load_enabled_map(config: &PathConfig) -> HashMap<String, bool> {
    let mut map: HashMap<String, bool> = HashMap::new();
    for root in plugin_roots(config) {
        if !root.exists() { continue; }
        for entry in read_index(&root) {
            let name = entry.name.clone();
            if !map.contains_key(&name) {
                map.insert(name, entry.enabled.unwrap_or(true));
            }
        }
    }
    map
}

/// Return potential roots for plugins: user dir, resource dir, and dev public dir
fn plugin_roots(config: &PathConfig) -> Vec<PathBuf> {
    let mut roots = Vec::new();
    // User-provided plugins directory
    roots.push(config.app_config_dir.join("plugins"));
    // Bundled resources (packaged builds)
    roots.push(config.resource_dir.join("plugins"));
    // Dev fallbacks: handle both running in project root and in src-tauri/
    if let Ok(cwd) = std::env::current_dir() {
        let p1 = cwd.join("public").join("plugins");
        roots.push(p1);
        if let Some(parent) = cwd.parent() {
            let p2 = parent.join("public").join("plugins");
            roots.push(p2);
        }
    }
    #[cfg(debug_assertions)]
    {
    log_debug!("[plugins] roots: {}", roots.iter().map(|p| p.display().to_string()).collect::<Vec<_>>().join(" | "));
    }
    roots
}

pub fn load_plugins(config: &PathConfig) -> Vec<LoadedPlugin> {
    let mut map: HashMap<String, LoadedPlugin> = HashMap::new();
    for root in plugin_roots(config) {
        if !root.exists() { continue; }
        let entries = read_index(&root);
        #[cfg(debug_assertions)]
    log_debug!("[plugins] read index at {} -> {} entries", root.join("index.json").display(), entries.len());
        for entry in entries {
            #[cfg(debug_assertions)]
            log_debug!("[plugins] entry '{}' manifest raw='{}'", entry.name, entry.manifest);
            let manifest_path = resolve_manifest_path(&root, &entry);
            #[cfg(debug_assertions)]
            log_debug!("[plugins] resolve {} -> {}", entry.name, manifest_path.display());
            if !manifest_path.exists() {
                #[cfg(debug_assertions)]
                log_debug!("[plugins] manifest not found: {}", manifest_path.display());
                continue;
            }
            if let Some(manifest) = read_manifest(&manifest_path) {
                // Basic validation depending on kind
                let valid = match &manifest.kind {
                    ManifestV1Kind::TorrentIndexer { spec } => !spec.network.url_template.is_empty() && !spec.parse.row_selector.is_empty(),
                    ManifestV1Kind::Script { entry, .. } => !entry.is_empty(),
                };
                if !valid {
                    #[cfg(debug_assertions)]
                    log_warn!("[plugins] invalid manifest (kind requirements) at {}", manifest_path.display());
                    continue;
                }
                let lp = LoadedPlugin {
                    name: entry.name.clone(),
                    version: entry.version.clone(),
                    provider: manifest.provider.clone(),
                    manifest_path: manifest_path.clone(),
                    manifest,
                    enabled_from_index: entry.enabled,
                };
                map.insert(lp.name.clone(), lp);
            } else {
                #[cfg(debug_assertions)]
                log_warn!("[plugins] manifest parse failed: {}", manifest_path.display());
            }
        }
    }
    #[cfg(debug_assertions)]
    log_debug!("[plugins] total loaded: {}", map.len());
    map.into_values().collect()
}

#[derive(Debug, Serialize)]
pub struct PublicPluginInfo {
    pub name: String,
    pub version: String,
    pub provider: Option<String>,
    pub kind: String,
    pub enabled: bool,
}

pub fn list_public_info(config: &PathConfig) -> Vec<serde_json::Value> {
    let enabled_map = load_enabled_map(config);
    let mut list: Vec<serde_json::Value> = load_plugins(config)
        .into_iter()
        .map(|p| {
            let enabled = enabled_map.get(&p.name).copied().unwrap_or(true);
            let kind_str = match &p.manifest.kind { ManifestV1Kind::TorrentIndexer {..} => "torrent-indexer", ManifestV1Kind::Script {..} => "script" };
            serde_json::json!({
                "name": p.name,
                "version": p.version,
                "provider": p.provider,
                "kind": kind_str,
                "enabled": enabled,
            })
        })
        .collect();
    list.sort_by(|a, b| {
        let an = a.get("name").and_then(|v| v.as_str()).unwrap_or("");
        let bn = b.get("name").and_then(|v| v.as_str()).unwrap_or("");
        an.to_lowercase().cmp(&bn.to_lowercase())
    });
    list
}

/// Return a list of script plugin sources (name + code) for enabled script-kind plugins.
/// The frontend will evaluate these early at startup.
pub fn list_script_sources(config: &PathConfig) -> Vec<serde_json::Value> {
    let enabled_map = load_enabled_map(config);
    let mut out = Vec::new();
    for p in load_plugins(config).into_iter() {
        let enabled = enabled_map.get(&p.name).copied().unwrap_or(true);
        if !enabled { continue; }
        if let ManifestV1Kind::Script { entry, .. } = &p.manifest.kind {
            // Resolve script file relative to manifest path directory
            let dir = p.manifest_path.parent().unwrap_or(Path::new(""));
            let script_path = dir.join(entry);
            match std::fs::read_to_string(&script_path) {
                Ok(code) => out.push(serde_json::json!({
                    "name": p.name,
                    "provider": p.provider,
                    "entry": entry,
                    "code": code,
                })),
                Err(e) => {
                    #[cfg(debug_assertions)]
                    log_warn!("[plugins] failed reading script '{}' for plugin '{}': {}", script_path.display(), p.name, e);
                }
            }
        }
    }
    out
}

/// Perform a search across all matching plugins (optionally filtered by provider/name)
pub async fn search_plugins(config: &PathConfig, query: &str, provider: Option<&str>) -> Result<Vec<serde_json::Value>, String> {
    let mut out: Vec<serde_json::Value> = Vec::new();
    let mut plugins = load_plugins(config);
    // Filter out disabled plugins according to enabled map derived from indices
    let enabled_map = load_enabled_map(config);
    plugins.retain(|p| enabled_map.get(&p.name).copied().unwrap_or(true));
    if let Some(f) = provider {
        let fl = f.to_lowercase();
        plugins.retain(|p| p.name.to_lowercase() == fl || p.provider.as_deref().unwrap_or("").to_lowercase() == fl);
    }
    for p in plugins.iter() {
        if let ManifestV1Kind::TorrentIndexer { spec } = &p.manifest.kind {
            let items = crate::scrape::search_torrent_indexer(spec, query).await.unwrap_or_default();
            for mut item in items {
                if let Some(map) = item.as_object_mut() { map.insert("provider".to_string(), serde_json::json!(p.name)); }
                out.push(item);
            }
        }
    }
    Ok(out)
}
