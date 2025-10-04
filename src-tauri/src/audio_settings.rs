use crate::bass::{
    bass_set_config, bass_set_config_ptr, BASS_CONFIG_BUFFER, BASS_CONFIG_NET_BUFFER,
    BASS_CONFIG_NET_TIMEOUT, BASS_CONFIG_NET_AGENT, BASS_DEVICE_DEFAULT,
};
use libloading::Library;
use once_cell::sync::Lazy;
use std::path::PathBuf;
use std::sync::Mutex;

// Unified audio settings with persistence support
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct AudioSettings {
    // Device and sample rate settings
    pub device_id: i32,
    pub sample_rate: u32,
    pub has_user_override: bool,
    
    // Audio quality settings
    pub bit_depth: u32,
    pub exclusive_mode: bool,
    pub output_channels: u32,
    
    // Volume settings
    pub volume: f32,
    pub muted: bool,
    pub volume_before_mute: f32,
    
    // BASS buffer and network configuration
    pub buffer_size_ms: u32,
    pub net_timeout_ms: u32,
    pub net_buffer_ms: u32,
    pub additional_buffer_wait_ms: u64,
}

impl Default for AudioSettings {
    fn default() -> Self {
        Self {
            device_id: BASS_DEVICE_DEFAULT,
            sample_rate: 44100,
            has_user_override: false,
            bit_depth: 16,
            exclusive_mode: false,
            output_channels: 2,
            volume: 0.5,
            muted: false,
            volume_before_mute: 0.5,
            buffer_size_ms: 1024,
            net_timeout_ms: 15000,
            net_buffer_ms: 15000,
            additional_buffer_wait_ms: 200,
        }
    }
}

impl AudioSettings {
    /// Load audio settings from disk, using defaults if file doesn't exist
    pub fn load() -> Self {
        match Self::get_settings_path() {
            Ok(path) => {
                if path.exists() {
                    match std::fs::read_to_string(&path) {
                        Ok(content) => {
                            match serde_json::from_str::<AudioSettings>(&content) {
                                Ok(settings) => {
                                    println!("[audio] Loaded audio settings from: {}", path.display());
                                    return settings;
                                }
                                Err(e) => {
                                    println!("[audio] Failed to parse settings file: {}, using defaults", e);
                                }
                            }
                        }
                        Err(e) => {
                            println!("[audio] Failed to read settings file: {}, using defaults", e);
                        }
                    }
                }
                println!("[audio] Settings file not found, using defaults");
            }
            Err(e) => {
                println!("[audio] Failed to get settings path: {}, using defaults", e);
            }
        }
        Self::default()
    }

    /// Save audio settings to disk
    pub fn save(&self) -> Result<(), String> {
        let path = Self::get_settings_path()
            .map_err(|e| format!("Failed to get settings path: {}", e))?;
        
        // Ensure the parent directory exists
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create settings directory: {}", e))?;
        }

        let content = serde_json::to_string_pretty(self)
            .map_err(|e| format!("Failed to serialize settings: {}", e))?;
        
        std::fs::write(&path, content)
            .map_err(|e| format!("Failed to write settings file: {}", e))?;
        
        println!("[audio] Saved audio settings to: {}", path.display());
        Ok(())
    }

    /// Get the path where audio settings should be stored
    fn get_settings_path() -> Result<PathBuf, String> {
        // Use the system's data directory to avoid Tauri dev server file watching issues
        let data_dir = dirs::data_dir()
            .ok_or("Failed to get system data directory")?;
        
        let mut path = data_dir;
        path.push("com.freely.player");
        path.push("audio_settings.json");
        Ok(path)
    }

    /// Validate and clamp settings to reasonable ranges
    pub fn validate(&mut self) {
        // Clamp sample rate to reasonable range
        self.sample_rate = self.sample_rate.max(8000).min(384000);
        
        // Clamp bit depth to supported values (16, 24, 32)
        self.bit_depth = match self.bit_depth {
            16 | 24 | 32 => self.bit_depth,
            _ if self.bit_depth < 20 => 16,
            _ if self.bit_depth < 28 => 24,
            _ => 32,
        };
        
        // Clamp output channels to reasonable range (1-8)
        self.output_channels = self.output_channels.max(1).min(8);
        
        // Clamp volume to 0.0-1.0
        self.volume = self.volume.max(0.0).min(1.0);
        self.volume_before_mute = self.volume_before_mute.max(0.0).min(1.0);
        
        // Clamp buffer sizes to reasonable ranges
        self.buffer_size_ms = self.buffer_size_ms.max(10).min(10000);
        self.net_timeout_ms = self.net_timeout_ms.max(1000).min(120000);
        self.net_buffer_ms = self.net_buffer_ms.max(1000).min(120000);
        self.additional_buffer_wait_ms = self.additional_buffer_wait_ms.max(0).min(5000);
    }

    /// Apply these settings to BASS configuration
    pub fn apply_to_bass(&self, lib: &Library) {
        bass_set_config(lib, BASS_CONFIG_BUFFER, self.buffer_size_ms);
        bass_set_config(lib, BASS_CONFIG_NET_TIMEOUT, self.net_timeout_ms);
        bass_set_config(lib, BASS_CONFIG_NET_BUFFER, self.net_buffer_ms);
        
        // Set HTTP User-Agent for YouTube compatibility
        let user_agent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36\0";
        bass_set_config_ptr(lib, BASS_CONFIG_NET_AGENT, user_agent.as_ptr());
    }
}

// Global audio settings instance
static AUDIO_SETTINGS: Lazy<Mutex<AudioSettings>> = Lazy::new(|| {
    Mutex::new(AudioSettings::load())
});

/// Get a snapshot of current audio settings
pub fn get_audio_settings() -> AudioSettings {
    AUDIO_SETTINGS.lock().unwrap().clone()
}

/// Update audio settings and save to disk
pub fn update_audio_settings<F>(updater: F) -> Result<AudioSettings, String> 
where
    F: FnOnce(&mut AudioSettings),
{
    let mut settings = AUDIO_SETTINGS.lock().unwrap();
    updater(&mut settings);
    settings.validate();
    settings.save()?;
    Ok(settings.clone())
}