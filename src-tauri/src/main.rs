#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
// Allowlist non-critical warnings during active development to keep build output focused.
// These can be tightened later by addressing each warning individually.
#![allow(unused_imports, dead_code, unused_variables, unused_mut)]

mod bass;
mod cache;
mod commands;
mod downloads;
mod playback;
mod server;
mod utils;
mod window;

use cache::{cache_clear, cache_download_and_store, cache_get_file, cache_get_stats};
use commands::{db, external, search, torrent, youtube};
use server::{server_start, server_status, PathState};
use window::{handle_window_resize, WindowState};

use once_cell::sync::Lazy;
use std::sync::Mutex;
use std::path::PathBuf;
use tauri::{
    Emitter,
    Manager,
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
};
use tauri_plugin_dialog::DialogExt;

// Global app handle for event emission
static APP_HANDLE: Lazy<Mutex<Option<tauri::AppHandle>>> = Lazy::new(|| Mutex::new(None));

#[tauri::command]
async fn save_file_dialog(app: tauri::AppHandle) -> Option<String> {
    // The plugin exposes an async callback-based API on the `app` via DialogExt
    // We'll use a oneshot channel to turn the callback into an awaitable future.
    let (tx, rx) = tokio::sync::oneshot::channel::<Option<tauri_plugin_dialog::FilePath>>();

    // Use the plugin dialog extension to show the save dialog
    // This runs on the main thread and invokes the callback with an Option<FilePath>
    app.dialog().file().save_file(move |file_path| {
        // send selected path (or None) back through channel; ignore send errors
        let _ = tx.send(file_path);
    });

    match rx.await {
        Ok(Some(fp)) => {
            // FilePath may be a FilePath::Path or FilePath::Url; convert to OS string when possible
            match fp {
                tauri_plugin_dialog::FilePath::Path(p) => Some(p.to_string_lossy().to_string()),
                tauri_plugin_dialog::FilePath::Url(u) => Some(u.to_string()),
            }
        }
        _ => None,
    }
}

#[tauri::command]
async fn app_ready(app_handle: tauri::AppHandle) {
    // Called when the React app is fully ready
    println!("App is ready, transitioning from splashscreen to main window");

    // Close splashscreen and show main window
    if let Some(splashscreen) = app_handle.get_webview_window("splashscreen") {
        let _ = splashscreen.emit("close-splashscreen", ());
        tokio::time::sleep(std::time::Duration::from_millis(300)).await; // Wait for fade animation
        let _ = splashscreen.close();
    }

    if let Some(main_window) = app_handle.get_webview_window("main") {
        let _ = main_window.show();
        let _ = main_window.set_focus();
    }
}

#[tauri::command]
async fn update_loading_status(
    app_handle: tauri::AppHandle,
    status: String,
    progress: Option<u32>,
    details: Option<String>,
) {
    // Send loading status update to splashscreen
    if let Some(splashscreen) = app_handle.get_webview_window("splashscreen") {
        let payload = serde_json::json!({
            "status": status,
            "progress": progress.unwrap_or(0),
            "details": details.unwrap_or_default()
        });
        let _ = splashscreen.emit("loading-status", payload);
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_prevent_default::init()) // ::init() makes the app ignore default browser shortcuts and context menu, ::debug() enables them in dev mode
        .setup(|app| {
            // Initialize application directories
            let resource_dir = app
                .path()
                .resource_dir()
                .expect("Failed to find resource directory");
            let app_log_dir = app
                .path()
                .app_log_dir()
                .expect("Failed to find app log directory");
            let app_config_dir = app
                .path()
                .app_config_dir()
                .expect("Failed to find app config directory");

            // Ensure directories exist
            for dir in [&app_log_dir, &app_config_dir] {
                if !dir.exists() {
                    std::fs::create_dir_all(dir)?;
                }
            }

            // Initialize path state
            let paths = PathState {
                server_script: resource_dir.join("server-dist").join("server.bundle.js"),
                pid_file: app_config_dir.join(".server.pid"),
                log_file: app_log_dir.join("server.log"),
                err_file: app_log_dir.join("server.err.log"),
                db_file: app_config_dir.join("freely.db"),
            };

            app.manage(paths);

            // On Windows, ensure the resources/bin directory is on PATH so bass*.dll plugins can be located by the loader
            #[cfg(target_os = "windows")]
            {
                use std::env;
                let resources_bin = resource_dir.join("bin");
                if resources_bin.exists() {
                    if let Some(bin_str) = resources_bin.to_str() {
                        let sep = ";";
                        let new_path = match env::var("PATH") {
                            Ok(p) => format!("{}{}{}", bin_str, sep, p),
                            Err(_) => bin_str.to_string(),
                        };
                        // Best-effort set. Even if this fails, we still have explicit plugin loading with fallback paths.
                        let _ = env::set_var("PATH", &new_path);
                        println!("Added resources/bin to PATH: {}", bin_str);
                    }
                }
            }

            // Initialize audio cache
            cache::init_cache(&app_config_dir)
                .map_err(|e| format!("Failed to initialize audio cache: {}", e))?;

            // Initialize window state
            let main_window = app.handle().get_webview_window("main").unwrap();
            let initial_maximized = main_window.is_maximized().unwrap_or(false);
            app.manage(WindowState::new(initial_maximized));

            // Start initialization tasks and handle splashscreen
            let app_handle = app.handle().clone();

            // Store global app handle for event emission
            *APP_HANDLE.lock().unwrap() = Some(app_handle.clone());

            tauri::async_runtime::spawn(async move {
                // Start server in background
                let paths_state = app_handle.state::<PathState>();
                match server_start(paths_state).await {
                    Ok(status) => {
                        println!("Server started on localhost:{}", status.port.unwrap_or(0));
                    }
                    Err(e) => {
                        eprintln!("Failed to start server: {}", e);
                    }
                }
                // Note: No longer auto-closing splashscreen here
                // The React app will call app_ready() when it's fully loaded
            });

            let quit_i = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&quit_i])?;

            let tray = TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "quit" => {
                        println!("quit menu item was clicked");
                        app.exit(0);
                    }
                    _ => {
                        println!("menu item {:?} not handled", event.id);
                    }
                })
                .menu(&menu)
                .show_menu_on_left_click(false)
                .build(app)?;

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // Window commands
            app_ready,
            save_file_dialog,
            save_file_and_write,
            update_loading_status,
            get_executable_dir_path,
            // Database commands
            db::db_path,
            db::db_read,
            db::db_write,
            // Server commands
            server_status,
            server_start,
            // Torrent commands
            torrent::torrent_list_scrapers,
            torrent::torrent_get_files,
            // Search commands
            search::source_search,
            // YouTube commands
            youtube::youtube_get_info,
            // (no fs command)
            // Playback commands
            commands::playback::playback_start,
            commands::playback::playback_start_with_source,
            commands::playback::playback_pause,
            commands::playback::playback_resume,
            commands::playback::playback_stop,
            commands::playback::playback_status,
            commands::playback::playback_seek,
            commands::playback::playback_cleanup,
            commands::playback::playback_set_volume,
            commands::playback::playback_get_volume,
            commands::playback::playback_set_mute,
            commands::playback::playback_toggle_mute,
            commands::playback::get_download_progress,
            // Downloads control commands
            commands::downloads::downloads_pause,
            commands::downloads::downloads_resume,
            commands::downloads::downloads_remove,
            // Audio settings commands
            commands::playback::get_audio_devices,
            commands::playback::get_audio_settings,
            commands::playback::set_audio_settings,
            commands::playback::reinitialize_audio,
            // Cache commands
            cache::cache_get_file,
            cache::cache_download_and_store,
            cache::cache_download_status,
            cache::cache_get_stats,
            cache::cache_clear,
            cache::cache_list_inflight,
            // External API commands
            external::charts_get_weekly_tops,
            external::genius_search,
            external::musixmatch_fetch_lyrics,
            external::lyrics_cache_get,
            external::lyrics_cache_set,
            external::spotify_search,
        ])
        .on_window_event(|window, event| {
            match event {
                tauri::WindowEvent::Resized(_) => {
                    handle_window_resize(window);
                }
                tauri::WindowEvent::CloseRequested { .. } => {
                    // Only kill server when main window is closing, not splashscreen
                    if window.label() == "main" {
                        let paths = window.app_handle().state::<PathState>();
                        paths.kill_server();

                        // Cleanup BASS resources before closing
                        tauri::async_runtime::spawn(async move {
                            let _ = crate::playback::playback_cleanup_internal().await;
                        });
                    }
                }
                _ => {} // Ignore other events
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

// Show a native save dialog and write the provided contents to the selected path.
// Returns the saved path as a String on success or None if cancelled / failed.
#[tauri::command]
async fn save_file_and_write(
    app: tauri::AppHandle,
    default_file_name: Option<String>,
    contents: String,
) -> Option<String> {
    let (tx, rx) = tokio::sync::oneshot::channel::<Option<tauri_plugin_dialog::FilePath>>();

    // Show save dialog with optional default filename and restrict to JSON files
    let builder = app.dialog().file();
    let builder = if let Some(ref name) = default_file_name {
        // clone the String so we pass an owned value into set_file_name
        builder.set_file_name(name.clone())
    } else {
        builder
    };
    // Add a JSON filter so the dialog suggests/limits to .json
    let mut builder = builder.add_filter("JSON", &["json"]);

    // If possible, set the starting directory to the user's Downloads folder
    if let Ok(download_dir) = app.path().download_dir() {
        // download_dir is a PathBuf; set_directory expects a path
        builder = builder.set_directory(download_dir);
    }
    builder.save_file(move |fp| {
        let _ = tx.send(fp);
    });

    let selected = match rx.await {
        Ok(Some(fp)) => Some(fp),
        _ => None,
    };

    if let Some(fp) = selected {
        // Try to convert to a PathBuf and write contents. Clone first because into_path() consumes fp.
        let fp_clone = fp.clone();
        match fp_clone.into_path() {
            Ok(mut pathbuf) => {
                // Ensure the file has a .json extension; if not, append it.
                if pathbuf.extension().is_none()
                    || pathbuf.extension().and_then(|s| s.to_str()) != Some("json")
                {
                    pathbuf.set_extension("json");
                }

                if let Err(e) = std::fs::write(&pathbuf, contents) {
                    eprintln!("Failed to write file: {}", e);
                    return None;
                }
                return Some(pathbuf.to_string_lossy().to_string());
            }
            Err(_) => {
                // Could not convert to path; return the URL/string form
                return Some(fp.to_string());
            }
        }
    }

    None
}
#[tauri::command]
fn get_executable_dir_path() -> Result<std::path::PathBuf, String> {
    match std::env::current_exe() {
        Ok(path) => {
            if let Some(parent) = path.parent() {
                Ok(parent.to_path_buf())
            } else {
                Err("Could not determine parent directory of executable".to_string())
            }
        },
        Err(error) => Err(format!("Failed to get executable path: {error}")),
    }
}