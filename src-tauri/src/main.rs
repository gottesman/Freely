#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod playback;
mod server;
mod utils;
mod window;

use commands::{db, external, search, torrent, youtube};
use server::{server_start, server_status, PathState};
use window::{handle_window_resize, WindowState};

use tauri::Manager;

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            // Initialize application directories
            let resource_dir = app.path().resource_dir()
                .expect("Failed to find resource directory");
            let app_log_dir = app.path().app_log_dir()
                .expect("Failed to find app log directory");
            let app_config_dir = app.path().app_config_dir()
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

            // Initialize audio cache
            playback::init_cache(&app_config_dir)
                .map_err(|e| format!("Failed to initialize audio cache: {}", e))?;

            // Initialize window state
            let window = app.handle().get_webview_window("main").unwrap();
            let initial_maximized = window.is_maximized().unwrap_or(false);
            app.manage(WindowState::new(initial_maximized));

            // Start server in background
            let app_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let paths_state = app_handle.state::<PathState>();
                match server_start(paths_state).await {
                    Ok(status) => {
                        println!("Server started on localhost:{}", status.port.unwrap_or(0));
                    }
                    Err(e) => {
                        eprintln!("Failed to start server: {}", e);
                    }
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
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
            // Playback commands
            playback::playback_start,
            playback::playback_start_with_cache,
            playback::playback_start_with_source,
            playback::playback_pause,
            playback::playback_resume,
            playback::playback_stop,
            playback::playback_status,
            playback::playback_seek,
            playback::playback_cleanup,
            playback::playback_set_volume,
            playback::playback_get_volume,
            playback::playback_set_mute,
            playback::playback_toggle_mute,
            // Audio settings commands
            playback::get_audio_devices,
            playback::get_audio_settings,
            playback::set_audio_settings,
            playback::reinitialize_audio,
            // Cache commands (now integrated into playback)
            playback::cache_get_file,
            playback::cache_download_and_store,
            playback::cache_get_stats,
            playback::cache_clear,
            // External API commands
            external::charts_get_weekly_tops,
            external::genius_search,
            external::spotify_search,
        ])
        .on_window_event(|window, event| {
            match event {
                tauri::WindowEvent::Resized(_) => {
                    handle_window_resize(window);
                }
                tauri::WindowEvent::CloseRequested { .. } => {
                    let paths = window.app_handle().state::<PathState>();
                    paths.kill_server();
                    
                    // Cleanup BASS resources before closing
                    tauri::async_runtime::spawn(async move {
                        let _ = crate::playback::playback_cleanup().await;
                    });
                }
                _ => {} // Ignore other events
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}