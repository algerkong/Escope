mod ai;
mod connection;
pub mod connection_credentials;
pub mod credentials;
mod error;
mod model_api_key;
pub mod model_credentials;
mod model_discovery;
mod models;
mod operation;
mod query;
mod read_only;
mod resources;
mod storage;

use connection::{ConnectionIdentity, ConnectionProbe, ReadOnlyClient};
use error::AppError;
use query::{QueryExecuteRequest, QueryExecuteResponse};
use read_only::{CancelRequest, RequestRegistry};
use resources::{ResourceReadRequest, ResourceReadResponse};
use std::sync::Mutex;
use storage::{ConnectionInput, ConnectionProfile, Database, Preferences, StoredState};
use tauri::{Manager, State};

struct StorageState(Mutex<Result<Database, AppError>>);
struct NetworkState(Result<ReadOnlyClient, AppError>);
/// In-flight requests that can be cancelled through IPC. Cancellation is bound to the exact
/// request and connection pair the execution registered with.
struct RequestState(RequestRegistry);

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
    // Legacy metadata path. Credential handling lives in `connection_credentials` and is not
    // reachable from IPC yet: a command that cannot report a partial cleanup must not act on a
    // connection that has a bound credential, so this refuses those rows with `unsupported`.
    with_database(&state, |db| db.save_connection_metadata_only(input, id))
}

#[tauri::command]
fn select_connection(state: State<'_, StorageState>, id: Option<String>) -> Result<(), AppError> {
    with_database(&state, |db| db.select_connection(id))
}

#[tauri::command]
fn delete_connection(state: State<'_, StorageState>, id: String) -> Result<(), AppError> {
    // Legacy metadata path; refuses a connection that has a bound credential for the same reason.
    with_database(&state, |db| db.delete_connection_metadata_only(&id))
}

/// Read one read-only resource: index discovery, mappings or field capabilities.
///
/// The target is validated before the plan is built, the connection is looked up by saved ID, and
/// the response is returned as the cluster's own bytes. Index discovery does not need a
/// monitoring endpoint, and a single unauthorized resource fails on its own instead of blocking
/// the others. The read is registered like a query, so cancelling it (a refresh, a page change or
/// an unmount) releases it instead of leaving it running.
#[tauri::command]
async fn resource_read(
    state: State<'_, StorageState>,
    network: State<'_, NetworkState>,
    requests: State<'_, RequestState>,
    request: ResourceReadRequest,
) -> Result<ResourceReadResponse, AppError> {
    // Validate the identifiers before the error mapper exists: an invalid ID must never be
    // reflected back through IPC.
    request.validate_ids()?;
    let request_id = request.request_id.clone();
    let result = async {
        let target = request.target()?;
        // Registered before any I/O, so a cancel that arrives while the connection is resolved or
        // the request is in flight releases it.
        let mut guard = requests
            .0
            .register(&request.request_id, &request.connection_id)?;
        let profile = with_database(&state, |db| db.connection(&request.connection_id))?;
        let client = network.0.as_ref().map_err(Clone::clone)?;
        let plan = resources::resource_plan(&profile, request.resource, target.as_ref())?;
        let raw = client.execute(plan, guard.cancellation()).await?;
        ResourceReadResponse::new(&request, &profile, raw)
    }
    .await;
    result.map_err(|mut error: AppError| {
        error.request_id = Some(request_id);
        error
    })
}

/// Execute one strictly validated `_search` request.
///
/// The request registers before any I/O, so a cancel that arrives while the connection is being
/// resolved or the query is in flight reaches the running future.
#[tauri::command]
async fn query_execute(
    state: State<'_, StorageState>,
    network: State<'_, NetworkState>,
    requests: State<'_, RequestState>,
    request: QueryExecuteRequest,
) -> Result<QueryExecuteResponse, AppError> {
    // Validate the identifiers before the error mapper exists: an invalid ID must never be
    // reflected back through IPC.
    request.validate_ids()?;
    let request_id = request.request_id.clone();
    let result = async {
        let prepared = request.prepare()?;
        let mut guard = requests
            .0
            .register(&request.request_id, &request.connection_id)?;
        let profile = with_database(&state, |db| db.connection(&request.connection_id))?;
        let client = network.0.as_ref().map_err(Clone::clone)?;
        let plan = query::search_plan(&profile, &prepared.index, prepared.body)?;
        let raw = client.execute(plan, guard.cancellation()).await?;
        QueryExecuteResponse::new(&request, &profile, raw)
    }
    .await;
    result.map_err(|mut error: AppError| {
        error.request_id = Some(request_id);
        error
    })
}

/// Cancel the request identified by this exact `(requestId, connectionId)` pair.
///
/// Returns `true` when the cancellation took effect: an in-flight request is signalled, or a
/// request for this pair that has not registered yet is marked so it can never be sent. Returns
/// `false` when the request had already finished.
///
/// Cancelling drops the local HTTP future and releases the request's concurrency permit and
/// registration. It never claims that a search already accepted by the cluster was terminated
/// there, and it never affects another request ID or another connection.
#[tauri::command]
fn request_cancel(
    requests: State<'_, RequestState>,
    request: CancelRequest,
) -> Result<bool, AppError> {
    request.validate()?;
    Ok(requests
        .0
        .cancel(&request.request_id, &request.connection_id))
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
            app.manage(RequestState(RequestRegistry::default()));
            // AI chat keeps its own client and its own cancellation registry, so an AI cancel can
            // never reach an Elasticsearch request and vice versa.
            app.manage(ai::AiState::new());
            // Model discovery has its own client and registry, separate from chat and search.
            app.manage(model_discovery::DiscoveryState::new());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            load_state,
            save_preferences,
            save_connection,
            select_connection,
            delete_connection,
            resource_read,
            query_execute,
            request_cancel,
            connection_test,
            ai::ai_chat,
            ai::ai_chat_cancel,
            models::models_load,
            models::models_save,
            models::models_delete,
            models::models_select,
            models::models_cleanup,
            model_discovery::models_discover,
            model_discovery::models_discover_cancel,
        ])
        .run(tauri::generate_context!())
        .expect("EScope desktop runtime failed");
}
