use std::sync::Mutex;
use tauri::{Emitter, Manager, Window};

/// State to track window maximization
pub struct WindowState {
    pub maximized: Mutex<bool>,
}

impl WindowState {
    pub fn new(initial_maximized: bool) -> Self {
        Self {
            maximized: Mutex::new(initial_maximized),
        }
    }
}

/// Handles window resize events and emits maximize/unmaximize events
pub fn handle_window_resize(window: &Window) {
    let window_state = window.state::<WindowState>();
    let mut maximized = window_state.maximized.lock().unwrap();
    let new_maximized_state = window.is_maximized().unwrap_or(false);

    // Only emit if state actually changed
    if *maximized != new_maximized_state {
        *maximized = new_maximized_state;

        let event_name = if new_maximized_state {
            "window:maximize"
        } else {
            "window:unmaximize"
        };

        let _ = window.emit(event_name, new_maximized_state);
    }
}
