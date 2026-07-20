//! Tern desktop shell. Deliberately thin: Tauri wiring and capabilities only —
//! all real logic lives in the `core-*` crates, which never depend on `tauri`.

mod commands;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(commands::AppState::default())
        .invoke_handler(tauri::generate_handler![
            commands::open_session,
            commands::approve_host_key,
            commands::write_session,
            commands::resize_session,
            commands::pause_session,
            commands::resume_session,
            commands::close_session,
            commands::bench_reset,
            commands::bench_stats,
            commands::bench_finish,
            commands::bench_log,
            commands::bench_auto,
            commands::bench_auto_done,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Tern");
}
