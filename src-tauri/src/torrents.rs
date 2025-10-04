use std::path::PathBuf;
use serde::Serialize;
use tauri::Emitter; // for AppHandle.emit
use serde_json::json;
use std::collections::{HashMap, HashSet};
// logging macros available globally
use std::sync::Mutex;
use once_cell::sync::OnceCell;

// ================= Shared Event / Tracking State (moved from commands.rs) =================
// Track active (torrent -> set of file indices) for progress emission.
// Using HashSet avoids per-iteration sort/dedup overhead present when using Vec.
static ACTIVE_DOWNLOADS: OnceCell<Mutex<HashMap<String, HashSet<u32>>>> = OnceCell::new();
// Deduplicate emitted progress (verified,total) pairs.
static LAST_PROGRESS: OnceCell<Mutex<HashMap<(String, u32), (u64, u64)>>> = OnceCell::new();
// Completion markers so each (torrent,file) fires completion once per session.
static COMPLETED: OnceCell<Mutex<HashSet<(String, u32)>>> = OnceCell::new();
// Ensure a single background task.
static PROGRESS_LOOP_STARTED: OnceCell<()> = OnceCell::new();

fn active_downloads() -> &'static Mutex<HashMap<String, HashSet<u32>>> {
	ACTIVE_DOWNLOADS.get_or_init(|| Mutex::new(HashMap::new()))
}
fn last_progress() -> &'static Mutex<HashMap<(String, u32), (u64, u64)>> {
	LAST_PROGRESS.get_or_init(|| Mutex::new(HashMap::new()))
}
fn completed_set() -> &'static Mutex<HashSet<(String, u32)>> {
	COMPLETED.get_or_init(|| Mutex::new(HashSet::new()))
}

// Start the global async loop that emits torrent:progress + torrent:complete events.
pub fn ensure_progress_loop(app: &tauri::AppHandle) {
	if PROGRESS_LOOP_STARTED.get().is_some() { return; }
	PROGRESS_LOOP_STARTED.set(()).ok();
	let handle = app.clone();
	std::thread::spawn(move || {
		use std::time::{Duration, Instant};
		let interval = Duration::from_millis(750);
		loop {
			let snapshot: Vec<(String, Vec<u32>)> = {
				let guard = active_downloads().lock().unwrap();
				guard.iter()
					.map(|(k, set)| (k.clone(), set.iter().copied().collect::<Vec<u32>>()))
					.collect()
			};
			if snapshot.is_empty() { std::thread::sleep(Duration::from_millis(1500)); continue; }
			for (key, indices) in snapshot.into_iter() {
				for fi in indices { emit_progress_if_changed(&handle, &key, fi); }
			}
			std::thread::sleep(interval);
		}
	});
}

// Integer percent (0-100) rounded to nearest whole percent.
#[inline]
fn compute_percent(verified: u64, total: u64) -> u64 {
    if total == 0 { 0 } else { (verified * 100 + total / 2) / total }
}

// Shared logic used by both the background loop and immediate emission on registration.
fn emit_progress_if_changed(handle: &tauri::AppHandle, key: &str, file_index: u32) {
    let engine = get_engine();
    if let Ok(p) = engine.progress(key, file_index) {
        let should_emit = {
            let mut last = last_progress().lock().unwrap();
            let ek = (key.to_string(), file_index);
            let cur = (p.verified_bytes, p.total);
            match last.get(&ek) { Some(prev) if *prev == cur => false, _ => { last.insert(ek, cur); true } }
        };
        if should_emit {
            let pct = compute_percent(p.verified_bytes, p.total);
            let ts = chrono::Utc::now().timestamp_millis();
            let payload = json!({
                "id": key,
                "fileIndex": file_index,
                "bytes": p.bytes,
                "verifiedBytes": p.verified_bytes,
                "onDiskBytes": p.on_disk_bytes,
                "total": p.total,
                "peers": p.peers,
                "downSpeed": p.down_speed,
                "percent": pct,
                "ts": ts,
            });
            let _ = handle.emit("torrent:progress", payload);
            if p.total > 0 && p.verified_bytes == p.total {
                let mut completed = completed_set().lock().unwrap();
                let ek = (key.to_string(), file_index);
                if !completed.contains(&ek) {
                    completed.insert(ek.clone());
                    let cp = json!({"id": key, "fileIndex": file_index, "total": p.total, "ts": ts});
                    let _ = handle.emit("torrent:complete", cp);
                }
            }
        }
    }
}

// Register a newly started download; emits immediate progress/completion if already done.
pub fn register_download(app: &tauri::AppHandle, key: &str, file_index: u32) {
	{
		let mut guard = active_downloads().lock().unwrap();
		let entry = guard.entry(key.to_string()).or_default();
		entry.insert(file_index);
	}
	ensure_progress_loop(app);
	// Immediate emission moved to background thread to avoid calling block_on from async context.
	let key_owned = key.to_string();
	let app_handle = app.clone();
	std::thread::spawn(move || emit_progress_if_changed(&app_handle, &key_owned, file_index));
}

pub fn unregister_download(key: &str) {
	if let Ok(mut guard) = active_downloads().lock() { guard.remove(key); }
	if let Ok(mut completed) = completed_set().lock() { completed.retain(|(k,_ )| k != key); }
}

#[derive(Clone, Debug)]
pub struct TorrentFileInfo {
	pub index: u32,
	pub name: String,
	pub length: u64,
}

#[derive(Clone, Debug, Default)]
pub struct TorrentProgress {
	// Backward-compatible field: now represents verified_bytes (hash-verified)
	pub bytes: u64,
	pub total: u64,
	pub peers: u32,
	// Estimated instantaneous download speed for this file (bytes/sec)
	pub down_speed: u64,
	// New: strictly hash-verified bytes (same as bytes; explicit for clarity)
	pub verified_bytes: u64,
	// New: raw on-disk file length (may include unverified/preallocated bytes)
	pub on_disk_bytes: u64,
}

pub trait TorrentEngine: Send + Sync + 'static {
	fn list_files(&self, magnet_or_infohash: &str) -> Result<Vec<TorrentFileInfo>, String>;
	fn start_download(&self, magnet_or_infohash: &str, file_index: u32, save_dir: &PathBuf) -> Result<(), String>;
	fn pause(&self, magnet_or_infohash: &str) -> Result<(), String>;
	fn resume(&self, magnet_or_infohash: &str) -> Result<(), String>;
	fn remove(&self, magnet_or_infohash: &str, remove_data: bool) -> Result<(), String>;
	fn progress(&self, magnet_or_infohash: &str, file_index: u32) -> Result<TorrentProgress, String>;
	fn file_path(&self, magnet_or_infohash: &str, file_index: u32, save_dir: &PathBuf) -> Result<PathBuf, String>;
}

// Dummy engine used when feature is disabled
struct NoopEngine;
impl TorrentEngine for NoopEngine {
	fn list_files(&self, _m: &str) -> Result<Vec<TorrentFileInfo>, String> { Err("torrent engine not enabled".into()) }
	fn start_download(&self, _m: &str, _i: u32, _d: &PathBuf) -> Result<(), String> { Err("torrent engine not enabled".into()) }
	fn pause(&self, _m: &str) -> Result<(), String> { Err("torrent engine not enabled".into()) }
	fn resume(&self, _m: &str) -> Result<(), String> { Err("torrent engine not enabled".into()) }
	fn remove(&self, _m: &str, _r: bool) -> Result<(), String> { Err("torrent engine not enabled".into()) }
	fn progress(&self, _m: &str, _i: u32) -> Result<TorrentProgress, String> { Err("torrent engine not enabled".into()) }
	fn file_path(&self, _m: &str, _i: u32, _d: &PathBuf) -> Result<PathBuf, String> { Err("torrent engine not enabled".into()) }
}

#[cfg(feature = "torrent-rqbit")]
mod rqbit_impl {
	use super::*;
	use librqbit::api::Api;
	use librqbit::{AddTorrent, AddTorrentOptions, Session};
	use once_cell::sync::OnceCell;
	use std::sync::Mutex;
	use std::collections::HashMap;
	use std::time::Instant;
	use std::future::Future;

	// ---------------------------------------------------------------------
	// Internal caching & helpers
	// ---------------------------------------------------------------------

	// Global API singleton
	static API: OnceCell<Mutex<Api>> = OnceCell::new();
	// Global map: key (info_hash or original magnet) -> torrent numeric id for later handle lookup via public Api
	static TORRENT_IDS: OnceCell<Mutex<HashMap<String, usize>>> = OnceCell::new();
	// Speed cache: info_hash -> (file_index -> (last_bytes, last_instant))
	static SPEED_CACHE: OnceCell<Mutex<HashMap<String, HashMap<u32, (u64, Instant)>>>> = OnceCell::new();
	// Torrent details cache: user supplied key (magnet or infohash) -> cached data
	static DETAILS_CACHE: OnceCell<Mutex<HashMap<String, CachedTorrent>>> = OnceCell::new();
	// User override of output folder (info_hash or original key -> chosen save_dir)
	static SAVE_DIR_OVERRIDES: OnceCell<Mutex<HashMap<String, PathBuf>>> = OnceCell::new();

	// Refresh / staleness threshold for cached torrent metadata (seconds).
	// Lowered to 2s so newly started downloads reflect custom output folder sooner.
	const DETAILS_TTL_SECS: f64 = 2.0; // small so UI stays fresh but avoids metadata spam

	#[derive(Clone, Debug)]
	struct CachedFile {
		components: Vec<String>,
		name: String,
		length: u64,
	}

	#[derive(Clone, Debug)]
	struct CachedTorrent {
		info_hash: String,
		output_folder: String,
		files: Vec<CachedFile>,
		last_update: Instant,
	}

	// Persistent runtime for all torrent operations so background tasks remain alive.
	static RUNTIME: OnceCell<tokio::runtime::Runtime> = OnceCell::new();
	fn rt() -> &'static tokio::runtime::Runtime {
		RUNTIME.get_or_init(|| {
			tokio::runtime::Builder::new_multi_thread()
				.enable_all()
				.thread_name("freely-torrent")
				.build()
				.expect("build runtime")
		})
	}
	fn rt_block_on<F: Future>(fut: F) -> F::Output { rt().block_on(fut) }

	fn get_api() -> &'static Mutex<Api> {
		API.get_or_init(|| {
			let default_dir = std::env::temp_dir().join("freely-torrents");
			let session = rt_block_on(Session::new(default_dir))
				.expect("create librqbit session");
			Mutex::new(Api::new(session, None))
		})
	}

	fn get_torrent_ids() -> &'static Mutex<HashMap<String, usize>> { TORRENT_IDS.get_or_init(|| Mutex::new(HashMap::new())) }

	fn get_speed_cache() -> &'static Mutex<HashMap<String, HashMap<u32, (u64, Instant)>>> {
		SPEED_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
	}

	fn get_details_cache() -> &'static Mutex<HashMap<String, CachedTorrent>> {
		DETAILS_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
	}

	fn get_save_dir_overrides() -> &'static Mutex<HashMap<String, PathBuf>> {
		SAVE_DIR_OVERRIDES.get_or_init(|| Mutex::new(HashMap::new()))
	}

	fn join_components(components: &[String]) -> PathBuf {
		let mut pb = PathBuf::new();
		for c in components {
			pb.push(c);
		}
		pb
	}

	pub struct RqbitEngine;
	impl RqbitEngine {
		pub fn new() -> Self {
			Self
		}
	}

	impl TorrentEngine for RqbitEngine {
		fn list_files(&self, magnet_or_infohash: &str) -> Result<Vec<TorrentFileInfo>, String> {
			let cached = self.get_or_fetch_details(magnet_or_infohash)?;
			Ok(cached.files
				.iter()
				.enumerate()
				.map(|(i, f)| TorrentFileInfo {
					index: i as u32,
					name: if f.components.is_empty() {
						f.name.clone()
					} else {
						join_components(&f.components)
							.to_string_lossy()
							.to_string()
					},
					length: f.length,
				})
				.collect())
		}

		fn start_download(
			&self,
			magnet_or_infohash: &str,
			file_index: u32,
			save_dir: &PathBuf,
		) -> Result<(), String> {
			// Path B: bypass high-level api_add_torrent to capture native handle immediately via Session
			let api_locked = get_api().lock().map_err(|_| "api poisoned")?;
			let session = api_locked.session().clone();
			drop(api_locked); // release lock early
			let opts = AddTorrentOptions {
				list_only: false,
				only_files: Some(vec![file_index as usize]),
				output_folder: Some(save_dir.to_string_lossy().to_string()),
				overwrite: true,
				..Default::default()
			};
			let add_result = rt_block_on(session.add_torrent(AddTorrent::from_url(magnet_or_infohash), Some(opts)) )
				.map_err(|e| format!("session.add_torrent: {e}"))?;
			let (info_hash_str, id_opt) = match add_result {
				librqbit::AddTorrentResponse::AlreadyManaged(id, handle) => (handle.info_hash().as_string(), Some(id)),
				librqbit::AddTorrentResponse::Added(id, handle) => (handle.info_hash().as_string(), Some(id)),
				librqbit::AddTorrentResponse::ListOnly(_) => { return Err("unexpected ListOnly response while list_only=false".into()); }
			};
			if let Some(id) = id_opt { if let Ok(mut ids) = get_torrent_ids().lock() { ids.insert(info_hash_str.clone(), id); ids.insert(magnet_or_infohash.to_string(), id); } }
			// Record override path under both info_hash and original key
			if let Ok(mut ov) = get_save_dir_overrides().lock() {
				ov.insert(info_hash_str.clone(), save_dir.clone());
				ov.insert(magnet_or_infohash.to_string(), save_dir.clone());
			}
			if std::env::var("FREELY_TORRENT_DEBUG").is_ok() {
														log_debug!("[torrent-debug] Added (Path B) info_hash={} override_dir={:?} file_index={}", info_hash_str, save_dir, file_index);
			}
			self.invalidate_cache_keys(magnet_or_infohash);
			Ok(())
		}

		fn pause(&self, magnet_or_infohash: &str) -> Result<(), String> {
			let api = get_api().lock().map_err(|_| "api poisoned")?.clone();
			let idx = self.resolve_torrent_id(&api, magnet_or_infohash)?;
			rt_block_on(api.api_torrent_action_pause(idx))
				.map_err(|e| format!("pause failed: {e}"))?;
			Ok(())
		}

		fn resume(&self, magnet_or_infohash: &str) -> Result<(), String> {
			let api = get_api().lock().map_err(|_| "api poisoned")?.clone();
			let idx = self.resolve_torrent_id(&api, magnet_or_infohash)?;
			rt_block_on(api.api_torrent_action_start(idx))
				.map_err(|e| format!("resume failed: {e}"))?;
			Ok(())
		}

		fn remove(&self, magnet_or_infohash: &str, remove_data: bool) -> Result<(), String> {
			let api = get_api().lock().map_err(|_| "api poisoned")?.clone();
			let idx = self.resolve_torrent_id(&api, magnet_or_infohash)?;
			if remove_data {
				rt_block_on(api.api_torrent_action_delete(idx))
					.map_err(|e| format!("delete failed: {e}"))?;
			} else {
				rt_block_on(api.api_torrent_action_forget(idx))
					.map_err(|e| format!("forget failed: {e}"))?;
			}
			// Clean caches (both magnet + infohash aliases)
			self.invalidate_cache_keys(magnet_or_infohash);
			Ok(())
		}

		fn progress(&self, magnet_or_infohash: &str, file_index: u32) -> Result<TorrentProgress, String> {
			use std::fs;
			let mut details = self.get_or_fetch_details(magnet_or_infohash)?;
			let f = details.files.get(file_index as usize).ok_or_else(|| "file index out of range".to_string())?;
			let total = f.length;
			let rel = if f.components.is_empty() { PathBuf::from(&f.name) } else { join_components(&f.components) };
			let override_dir = get_save_dir_overrides().lock().ok().and_then(|m| {
				m.get(&details.info_hash).cloned().or_else(|| m.get(magnet_or_infohash).cloned())
			});
			let effective_dir: PathBuf = override_dir.clone().unwrap_or_else(|| PathBuf::from(&details.output_folder));
			let path = effective_dir.join(&rel);
			let mut disk_bytes = fs::metadata(&path).map(|m| m.len().min(total)).unwrap_or(0);
			let debug_enabled = std::env::var("FREELY_TORRENT_DEBUG").is_ok();
			if disk_bytes == 0 && details.last_update.elapsed().as_secs_f64() > 1.0 {
				self.invalidate_cache_keys(magnet_or_infohash);
				if let Ok(newd) = self.get_or_fetch_details(magnet_or_infohash) { details = newd; }
				disk_bytes = fs::metadata(&path).map(|m| m.len().min(total)).unwrap_or(0);
				if debug_enabled { log_debug!("[torrent-debug] Refreshed metadata; output_folder={} disk_bytes_now={}", details.output_folder, disk_bytes); }
			}
			if debug_enabled && disk_bytes == 0 {
				let meta_dir = &details.output_folder;
				if let Some(ovd) = override_dir.as_ref() {
					let override_lossy = ovd.to_string_lossy();
							if meta_dir.as_str() != override_lossy.as_ref() {
								log_debug!("[torrent-debug] Path mismatch meta='{}' override='{}' using_effective='{}'", meta_dir, override_lossy, effective_dir.display());
							}
				}
				if path.exists() { log_debug!("[torrent-debug] File exists but size 0: {:?}", path); } else { log_debug!("[torrent-debug] File not yet created: {:?}", path); }
			}

			// Attempt native stats via Api -> handle lookup using stored torrent id
			let mut verified_bytes = None;
			let mut live_speed_bytes_per_s = None;
			if let Ok(ids) = get_torrent_ids().lock() {
				let key_id = ids.get(magnet_or_infohash).or_else(|| ids.get(&details.info_hash)).copied();
				if let Some(tid) = key_id {
					if let Ok(api) = get_api().lock() {
						// Use api_stats_v1 to obtain TorrentStats (public API)
						if let Ok(stats) = api.api_stats_v1(tid.into()) {
							if let Some(b) = stats.file_progress.get(file_index as usize) { verified_bytes = Some((*b).min(total)); }
							if let Some(live) = &stats.live { live_speed_bytes_per_s = Some((live.download_speed.mbps * 1024.0 * 1024.0) as u64); }
						}
					}
				}
			}
			let bytes = verified_bytes.unwrap_or(disk_bytes); // alias -> verified
			let peers: u32 = 0; // TODO: derive peer count if exposed later.
			let mut down_speed: u64 = {
				let now = Instant::now();
				let mut cache = get_speed_cache().lock().map_err(|_| "speed cache poisoned")?;
				let entry = cache.entry(details.info_hash.clone()).or_default();
				if let Some((last_bytes, last_t)) = entry.get(&file_index).cloned() {
					let dt = now.duration_since(last_t).as_secs_f64();
					let mut rate = 0u64;
					if dt >= 0.2 {
						let delta = bytes.saturating_sub(last_bytes) as f64;
						if delta > 0.0 { rate = (delta / dt).round().max(0.0) as u64; }
					}
					entry.insert(file_index, (bytes, now));
					rate
				} else {
					entry.insert(file_index, (bytes, now));
					0
				}
			};
			if let Some(ls) = live_speed_bytes_per_s { down_speed = ls; }
			Ok(TorrentProgress { bytes, total, peers, down_speed, verified_bytes: bytes, on_disk_bytes: disk_bytes })
		}

		fn file_path(
			&self,
			magnet_or_infohash: &str,
			file_index: u32,
			save_dir: &PathBuf,
		) -> Result<PathBuf, String> {
			let details = self.get_or_fetch_details(magnet_or_infohash)?;
			let f = details.files.get(file_index as usize).ok_or_else(|| "file index out of range".to_string())?;
			let rel = if f.components.is_empty() { PathBuf::from(&f.name) } else { join_components(&f.components) };
			let override_dir = get_save_dir_overrides().lock().ok().and_then(|m| {
				m.get(&details.info_hash).cloned().or_else(|| m.get(magnet_or_infohash).cloned())
			});
			let mut p = if let Some(ov) = override_dir.as_ref() { ov.join(&rel) } else { PathBuf::from(&details.output_folder).join(&rel) };
			if !p.exists() {
				let alt = save_dir.join(&rel);
				if alt.exists() {
					p = alt;
				}
			}
			Ok(p)
		}
	}

	impl RqbitEngine {
		// Attempt to extract an infohash from the user input without network calls.
		fn extract_infohash(&self, s: &str) -> Option<String> {
			// Direct hex (40 chars)
			if s.len() == 40 && s.chars().all(|c| c.is_ascii_hexdigit()) {
				return Some(s.to_lowercase());
			}
			// Base32 (32 chars) – treat as already normalized.
			if s.len() == 32 && s.chars().all(|c| c.is_ascii_alphanumeric()) && !s.contains(':') && !s.starts_with("magnet:") {
				return Some(s.to_uppercase());
			}
			if let Some(pos) = s.find("xt=urn:btih:") {
				let after = &s[pos + 12..];
				let end = after.find('&').unwrap_or(after.len());
				let ih = &after[..end];
				let ih_clean = ih.trim();
				if (ih_clean.len() == 40 && ih_clean.chars().all(|c| c.is_ascii_hexdigit())) || (ih_clean.len() == 32 && ih_clean.chars().all(|c| c.is_ascii_alphanumeric())) {
					return Some(ih_clean.to_string());
				}
			}
			None
		}

		// Resolve TorrentIdOrHash using local parsing first; fallback to list_only metadata if needed.
		fn resolve_torrent_id(&self, api: &Api, magnet_or_infohash: &str) -> Result<librqbit::api::TorrentIdOrHash, String> {
			use std::convert::TryFrom;
			use librqbit::api::TorrentIdOrHash;
			if let Some(ih) = self.extract_infohash(magnet_or_infohash) {
				if let Ok(idx) = TorrentIdOrHash::try_from(ih.as_str()) { return Ok(idx); }
			}
			// Fallback: list_only add to discover infohash (network call)
			let opts = AddTorrentOptions { list_only: true, ..Default::default() };
			let resp = rt_block_on(api.api_add_torrent(AddTorrent::from_url(magnet_or_infohash), Some(opts)))
				.map_err(|e| format!("rqbit api_add_torrent(list_only): {e}"))?;
			TorrentIdOrHash::try_from(resp.details.info_hash.as_str()).map_err(|e| format!("bad info hash: {e}"))
		}

		// Get cached details or fetch via list_only (with minimal locking / await).
		fn get_or_fetch_details(&self, key: &str) -> Result<CachedTorrent, String> {
			// 1. Fast path: fresh cache
			if let Ok(cache) = get_details_cache().lock() {
				if let Some(cached) = cache.get(key) {
					if cached.last_update.elapsed().as_secs_f64() < DETAILS_TTL_SECS { return Ok(cached.clone()); }
				}
				// If key is magnet and we already have canonical infohash entry, return that as well
				if !key.is_empty() && key.starts_with("magnet:") {
					if let Some(ih) = self.extract_infohash(key) {
						if let Some(cached) = cache.get(&ih) {
							if cached.last_update.elapsed().as_secs_f64() < DETAILS_TTL_SECS { return Ok(cached.clone()); }
						}
					}
				}
			}
			// 2. Need fresh details – fetch outside lock
			let api = get_api().lock().map_err(|_| "api poisoned")?.clone();
			let opts = AddTorrentOptions { list_only: true, ..Default::default() };
			let resp = rt_block_on(api.api_add_torrent(AddTorrent::from_url(key), Some(opts)))
				.map_err(|e| format!("rqbit api_add_torrent(list_only): {e}"))?;
			let details = resp.details;
			let files_src = details.files.unwrap_or_default();
			let files: Vec<CachedFile> = files_src.into_iter().map(|f| CachedFile { components: f.components, name: f.name, length: f.length as u64 }).collect();
			let cached = CachedTorrent { info_hash: details.info_hash.clone(), output_folder: details.output_folder.clone(), files, last_update: Instant::now() };
			// 3. Store back into cache
			if let Ok(mut cache) = get_details_cache().lock() {
				cache.insert(key.to_string(), cached.clone());
				// Also store under canonical infohash to unify lookups
				cache.insert(cached.info_hash.clone(), cached.clone());
			}
			Ok(cached)
		}

		fn invalidate_cache_keys(&self, key: &str) {
			if let Ok(mut cache) = get_details_cache().lock() {
				cache.remove(key);
				if let Some(ih) = self.extract_infohash(key) { cache.remove(&ih); }
			}
			if let Ok(mut speed) = get_speed_cache().lock() {
				speed.remove(key);
				if let Some(ih) = self.extract_infohash(key) { speed.remove(&ih); }
			}
		}
	}

	pub fn make_engine() -> Box<dyn TorrentEngine> {
		Box::new(RqbitEngine::new())
	}
}

#[cfg(not(feature = "torrent-rqbit"))]
mod rqbit_impl {
	use super::*;
	pub fn make_engine() -> Box<dyn TorrentEngine> { Box::new(super::NoopEngine) }
}

static ENGINE: OnceCell<Box<dyn TorrentEngine>> = OnceCell::new();

pub fn get_engine() -> &'static dyn TorrentEngine {
	ENGINE.get_or_init(|| rqbit_impl::make_engine());
	// SAFETY: OnceCell initialized above; unwrap ok
	ENGINE.get().map(|b| &**b).unwrap()
}

// Thin wrappers used by command layer to avoid re-exporting internal tracking details.
#[derive(Serialize)]
pub struct ProgressData {
	pub bytes: u64,
	pub verified_bytes: u64,
	pub on_disk_bytes: u64,
	pub total: u64,
	pub peers: u32,
	pub down_speed: u64,
}

pub fn engine_progress(key: &str, index: u32) -> Result<ProgressData, String> {
	match get_engine().progress(key, index) {
		Ok(p) => Ok(ProgressData {
			bytes: p.bytes,
			verified_bytes: p.verified_bytes,
			on_disk_bytes: p.on_disk_bytes,
			total: p.total,
			peers: p.peers,
			down_speed: p.down_speed,
		}),
		Err(e) => Err(e),
	}
}
