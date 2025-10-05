fn main() {
    // We'll load BASS dynamically at runtime, so no static linking needed
    // Just ensure the BASS DLL is copied to the output directory during build
    
    // Get the target OS once and determine the appropriate library file extension
    let target_os = std::env::var("CARGO_CFG_TARGET_OS").unwrap();
    let lib_extension = match target_os.as_str() {
        "windows" => "dll",
        "linux" => "so",
        "macos" => "dylib",
        _ => ""
    };

    if lib_extension.is_empty() {
        // Skip BASS copy for unsupported OS --- IGNORE ---
        eprintln!("cargo:warning=Unsupported OS for BASS library copy {}, skipping.", target_os);
        tauri_build::build();
    }
    
    // Copy BASS library if OUT_DIR is available and source file exists
    if let Ok(out_dir) = std::env::var("OUT_DIR") {
        let bass_src = format!("bin/bass.{}", lib_extension);
        if std::path::Path::new(&bass_src).exists() {
            let target_path = std::path::Path::new(&out_dir)
                .parent()
                .unwrap()
                .parent()
                .unwrap()
                .parent()
                .unwrap()
                .join(format!("bass.{}", lib_extension));
            let _ = std::fs::copy(&bass_src, target_path);
        }
    }

    // tauri-build will generate the needed assets and set OUT_DIR for generate_context!
    tauri_build::build()
}
