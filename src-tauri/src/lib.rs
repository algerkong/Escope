mod connection;
mod error;
mod operation;
mod storage;

use connection::{ConnectionIdentity, ConnectionProbe, ReadOnlyClient};
use error::AppError;
use std::sync::Mutex;
use storage::{ConnectionInput, ConnectionProfile, Database, Preferences, StoredState};
use tauri::{Manager, State};

struct StorageState(Mutex<Result<Database, AppError>>);
struct NetworkState(Result<ReadOnlyClient, AppError>);

fn with_database<T>(
    state: &StorageState,
    action: impl FnOnce(&mut Database) -> Result<T, AppError>,
) -> Result<T, AppError> {
    let mut guard = state
        .0
        .lock()
        .map_err(|_| AppError::new("storageUnavailable"))?;
    match guard.as_mut() {
        Ok(database) => action(database),
        Err(error) => Err(error.clone()),
    }
}

#[tauri::command]
fn load_state(state: State<'_, StorageState>) -> Result<StoredState, AppError> {
    with_database(&state, |db| db.load())
}

#[tauri::command]
fn save_preferences(
    state: State<'_, StorageState>,
    preferences: Preferences,
) -> Result<(), AppError> {
    with_database(&state, |db| db.save_preferences(preferences))
}

#[tauri::command]
fn save_connection(
    state: State<'_, StorageState>,
    input: ConnectionInput,
    id: Option<String>,
) -> Result<ConnectionProfile, AppError> {
    with_database(&state, |db| db.save_connection(input, id))
}

#[tauri::command]
fn select_connection(state: State<'_, StorageState>, id: Option<String>) -> Result<(), AppError> {
    with_database(&state, |db| db.select_connection(id))
}

#[tauri::command]
fn delete_connection(state: State<'_, StorageState>, id: String) -> Result<(), AppError> {
    with_database(&state, |db| db.delete_connection(&id))
}

#[tauri::command]
fn query_execute() -> Result<(), AppError> {
    Err(AppError::new("unsupported"))
}

#[tauri::command]
async fn connection_test(
    state: State<'_, StorageState>,
    network: State<'_, NetworkState>,
    probe: ConnectionProbe,
) -> Result<ConnectionIdentity, AppError> {
    probe.validate()?;
    let result = async {
        let profile = with_database(&state, |db| db.connection(&probe.connection_id))?;
        let client = network.0.as_ref().map_err(Clone::clone)?;
        client
            .test(
                &profile,
                ConnectionProbe {
                    request_id: probe.request_id.clone(),
                    connection_id: probe.connection_id.clone(),
                },
            )
            .await
    }
    .await;
    result.map_err(|mut error: AppError| {
        error.request_id = Some(probe.request_id);
        error
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let database = (|| {
                let directory = app
                    .path()
                    .app_data_dir()
                    .map_err(|_| AppError::new("storageUnavailable"))?;
                std::fs::create_dir_all(&directory)
                    .map_err(|_| AppError::new("storageUnavailable"))?;
                Database::open(&directory.join("escope.sqlite"))
            })();
            app.manage(StorageState(Mutex::new(database)));
            app.manage(NetworkState(ReadOnlyClient::new()));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            load_state,
            save_preferences,
            save_connection,
            select_connection,
            delete_connection,
            query_execute,
            connection_test,
        ])
        .run(tauri::generate_context!())
        .expect("EScope desktop runtime failed");
}
