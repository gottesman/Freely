use crate::cache::{create_cache_filename, get_cache_dir};
use once_cell::sync::Lazy;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::Emitter; // for app.emit
use tokio::sync::Notify;

// Control state for a single download (keyed by base name from create_cache_filename)
pub struct DownloadControl {
    paused: AtomicBool,
    cancel: AtomicBool,
    notify: Notify,
}

impl DownloadControl {
    fn new() -> Self {
        Self {
            paused: AtomicBool::new(false),
            cancel: AtomicBool::new(false),
            notify: Notify::new(),
        }
    }
}

static CONTROLS: Lazy<Mutex<HashMap<String, Arc<DownloadControl>>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

fn get_or_insert_control(base: &str) -> Arc<DownloadControl> {
    let mut g = CONTROLS.lock().unwrap();
    g.entry(base.to_string())
        .or_insert_with(|| Arc::new(DownloadControl::new()))
        .clone()
}

pub fn ensure_control_for(base: &str) {
    let _ = get_or_insert_control(base);
}

pub fn clear_control(base: &str) {
    let mut g = CONTROLS.lock().unwrap();
    g.remove(base);
}

pub fn set_paused(base: &str, pause: bool) -> bool {
    let ctrl = get_or_insert_control(base);
    ctrl.paused.store(pause, Ordering::SeqCst);
    // Wake any waiters so they can re-check state
    ctrl.notify.notify_waiters();
    true
}

pub fn request_cancel(base: &str) -> bool {
    let ctrl = get_or_insert_control(base);
    ctrl.cancel.store(true, Ordering::SeqCst);
    // Wake any waiters so they can observe cancel
    ctrl.notify.notify_waiters();
    true
}

pub fn is_cancelled(base: &str) -> bool {
    let g = CONTROLS.lock().unwrap();
    if let Some(ctrl) = g.get(base) {
        ctrl.cancel.load(Ordering::SeqCst)
    } else {
        false
    }
}

pub fn is_paused(base: &str) -> bool {
    let g = CONTROLS.lock().unwrap();
    if let Some(ctrl) = g.get(base) {
        ctrl.paused.load(Ordering::SeqCst)
    } else {
        false
    }
}

pub async fn wait_while_paused_or_until_cancel(base: &str) {
    loop {
        // Fast path: not paused, just return
        if !is_paused(base) {
            return;
        }
        // Check cancel as well
        if is_cancelled(base) {
            return;
        }
        // Wait for a notify, then loop to re-check
        let ctrl_opt: Option<Arc<DownloadControl>> = {
            let g = CONTROLS.lock().unwrap();
            g.get(base).cloned()
        };
        if let Some(ctrl) = ctrl_opt {
            ctrl.notify.notified().await;
        } else {
            return;
        }
    }
}

// Tauri commands for controlling manual cache downloads
pub async fn downloads_pause(
    app: tauri::AppHandle,
    track_id: String,
    source_type: String,
    source_hash: String,
) -> Result<bool, String> {
    let base = create_cache_filename(&track_id, &source_type, &source_hash);
    let _ = set_paused(&base, true);
    let _ = app.emit(
        "cache:download:paused",
        serde_json::json!({
            "trackId": track_id,
            "sourceType": source_type,
            "sourceHash": source_hash,
            "id": base
        }),
    );
    Ok(true)
}

pub async fn downloads_resume(
    app: tauri::AppHandle,
    track_id: String,
    source_type: String,
    source_hash: String,
) -> Result<bool, String> {
    let base = create_cache_filename(&track_id, &source_type, &source_hash);
    let _ = set_paused(&base, false);
    // Notify waiters
    {
        let g = CONTROLS.lock().unwrap();
        if let Some(ctrl) = g.get(&base) {
            ctrl.notify.notify_waiters();
        }
    }
    let _ = app.emit(
        "cache:download:resumed",
        serde_json::json!({
            "trackId": track_id,
            "sourceType": source_type,
            "sourceHash": source_hash,
            "id": base
        }),
    );
    Ok(true)
}

pub async fn downloads_remove(
    app: tauri::AppHandle,
    track_id: String,
    source_type: String,
    source_hash: String,
) -> Result<bool, String> {
    let base = create_cache_filename(&track_id, &source_type, &source_hash);
    let _ = request_cancel(&base);
    // Best-effort removal of .part file (actual download loop will also honor cancel)
    if let Some(dir) = get_cache_dir() {
        let part = dir.join(format!("{}.part", base));
        if part.exists() {
            let _ = std::fs::remove_file(&part);
        }
    }
    let _ = app.emit(
        "cache:download:removed",
        serde_json::json!({
            "trackId": track_id,
            "sourceType": source_type,
            "sourceHash": source_hash,
            "id": base
        }),
    );
    Ok(true)
}
