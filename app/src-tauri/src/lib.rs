//! Tauri shell.
//!
//! Deliberately thin. Every bit of domain logic — regeneration, unfolding,
//! validation, DXF — lives in the TypeScript core and runs in the webview, so
//! the same code is exercised by `npm test` in Node and by the desktop app.
//! Rust's job here is the window, the menus and the file dialogs.

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .run(tauri::generate_context!())
        .expect("error while running Metal Mate");
}
