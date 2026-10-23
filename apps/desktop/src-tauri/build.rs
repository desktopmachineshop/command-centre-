fn main() {
    // Declaring the app's commands generates `allow-*` permissions, so only the
    // capabilities that list them (the bundled settings page) can call them.
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(&["get_settings", "save_settings"])),
    )
    .expect("failed to run tauri-build");
}
