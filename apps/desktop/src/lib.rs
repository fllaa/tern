//! Tern desktop shell. Deliberately thin: Tauri wiring and capabilities only —
//! all real logic lives in the `core-*` crates, which never depend on `tauri`.

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![])
        .run(tauri::generate_context!())
        .expect("error while running Tern");
}
