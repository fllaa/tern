//! Tern desktop shell. Deliberately thin: Tauri wiring and capabilities only —
//! all real logic lives in the `core-*` crates, which never depend on `tauri`.

mod auth;
mod commands;
mod session_cfg;
mod store_commands;

use tauri::Manager as _;

/// Where the store and `known_hosts` live, under the OS app-config directory.
///
/// Resolution happens here rather than in `core-store` — that crate takes a
/// path and discovers nothing, which is what keeps it `tauri`-free and makes
/// its in-memory constructor a true equivalent for tests.
fn app_paths(app: &tauri::App) -> Result<(std::path::PathBuf, std::path::PathBuf), String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("could not resolve app config dir: {e}"))?;
    Ok((dir.join("tern.db"), dir.join("known_hosts")))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let (db_path, known_hosts_path) = app_paths(app)?;
            let store = tern_core_store::Store::open(&db_path)
                .map_err(|e| format!("could not open store at {}: {e}", db_path.display()))?;
            app.manage(commands::AppState::new(store, known_hosts_path));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // session lifecycle
            commands::open_session,
            commands::approve_host_key,
            commands::write_session,
            commands::resize_session,
            commands::pause_session,
            commands::resume_session,
            commands::close_session,
            // hosts
            store_commands::list_hosts,
            store_commands::get_host,
            store_commands::create_host,
            store_commands::update_host,
            store_commands::delete_host,
            store_commands::move_host,
            store_commands::set_host_tags,
            // folders
            store_commands::list_folders,
            store_commands::create_folder,
            store_commands::rename_folder,
            store_commands::move_folder,
            store_commands::delete_folder,
            // tags
            store_commands::list_tags,
            store_commands::create_tag,
            store_commands::delete_tag,
            // known hosts
            store_commands::list_known_hosts,
            store_commands::remove_known_host,
            store_commands::import_known_hosts,
            // ssh_config import
            store_commands::scan_ssh_config,
            store_commands::import_ssh_config,
            // benchmark harness (Phase 0; kept runnable so regressions show)
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
