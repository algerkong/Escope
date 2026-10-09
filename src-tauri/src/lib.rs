mod ai;
mod connection;
mod connection_access;
mod connection_auth;
pub mod connection_credentials;
mod connection_settings;
mod connection_tls;
pub mod credentials;
mod error;
mod model_api_key;
pub mod model_credentials;
mod model_discovery;
mod models;
mod operation;
mod query;
mod query_exchange;
mod query_export;
mod query_parameters;
mod read_only;
mod resources;
mod saved_queries;
mod storage;
mod workspace_recovery;

use connection::{ConnectionIdentity, ConnectionProbe, ReadOnlyClient};
use connection_auth::ResolvedAuth;
use credentials::SystemCredentialStore;
use error::AppError;
use query::{
    PitCloseRequest, PitCloseResponse, PitOpenRequest, PitOpenResponse, QueryExecuteRequest,
    QueryExecuteResponse,
};
use read_only::{CancelRequest, Cancellation, RequestRegistry};
use resources::{ResourceReadRequest, ResourceReadResponse};
use std::sync::Mutex;
use storage::{
    ConnectionInput, ConnectionProfile, Database, Preferences, StoredState, TransportSnapshot,
};
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

/// Read one connection for a network request and resolve its stored authentication.
///
/// The snapshot comes only from the validated row the database read for this stable connection
/// ID; no network command accepts a reference or a secret, and a missing, unavailable or corrupt vault
/// entry fails here — before a plan is built — instead of degrading into an unauthenticated
/// send. The database lock is released before any network await, the store is resolved per
/// request without a cache, and the same immutable snapshot plans the request and the response.
fn connection_for_request(
    state: &StorageState,
    connection_id: &str,
) -> Result<(TransportSnapshot, ResolvedAuth), AppError> {
    let snapshot = with_database(state, |db| db.transport_snapshot(connection_id))?;
    let auth = connection_auth::resolve(&snapshot, &SystemCredentialStore::new())?;
    Ok((snapshot, auth))
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
        let (snapshot, auth) = connection_for_request(&state, &request.connection_id)?;
        let profile = snapshot.profile();
        let client = network
            .0
            .as_ref()
            .map_err(Clone::clone)?
            .for_snapshot(&snapshot)?;
        let plan = resources::resource_plan(profile, request.resource, target.as_ref())?
            .authenticate(&auth)?;
        let raw = client.execute(plan, guard.cancellation()).await?;
        ResourceReadResponse::new(&request, profile, raw)
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
        let (snapshot, auth) = connection_for_request(&state, &request.connection_id)?;
        let profile = snapshot.profile();
        let client = network
            .0
            .as_ref()
            .map_err(Clone::clone)?
            .for_snapshot(&snapshot)?;
        // A continuation searches inside the snapshot with the composed body; a first page
        // targets the index the draft names.
        let plan = if prepared.continuation {
            query::paginated_search_plan(profile, prepared.body)?
        } else {
            query::search_plan(profile, &prepared.index, prepared.body)?
        };
        let plan = plan.authenticate(&auth)?;
        let raw = client.execute(plan, guard.cancellation()).await?;
        QueryExecuteResponse::new(&request, profile, raw, request.pit_id.as_deref())
    }
    .await;
    result.map_err(|mut error: AppError| {
        error.request_id = Some(request_id);
        error
    })
}

/// Open one search snapshot for a query's paginated continuation.
///
/// The target is validated before the plan is built and the connection is looked up by saved ID,
/// exactly like `query_execute`. The returned snapshot id is the cluster's own token; the
/// response never carries a document.
#[tauri::command]
async fn pit_open(
    state: State<'_, StorageState>,
    network: State<'_, NetworkState>,
    requests: State<'_, RequestState>,
    request: PitOpenRequest,
) -> Result<PitOpenResponse, AppError> {
    request.validate_ids()?;
    let request_id = request.request_id.clone();
    let result = async {
        let target = request.target()?;
        let mut guard = requests
            .0
            .register(&request.request_id, &request.connection_id)?;
        let (snapshot, auth) = connection_for_request(&state, &request.connection_id)?;
        let profile = snapshot.profile();
        let client = network
            .0
            .as_ref()
            .map_err(Clone::clone)?
            .for_snapshot(&snapshot)?;
        let plan = query::pit_open_plan(profile, &target)?.authenticate(&auth)?;
        let raw = client.execute(plan, guard.cancellation()).await?;
        PitOpenResponse::new(&request, profile, raw)
    }
    .await;
    result.map_err(|mut error: AppError| {
        error.request_id = Some(request_id);
        error
    })
}

/// Close one snapshot. This is best-effort cleanup of a resource the server expires on its own;
/// it is deliberately not cancellable, and a failure never invalidates a result the user has.
#[tauri::command]
async fn pit_close(
    state: State<'_, StorageState>,
    network: State<'_, NetworkState>,
    request: PitCloseRequest,
) -> Result<PitCloseResponse, AppError> {
    request.validate()?;
    let request_id = request.request_id.clone();
    let result: Result<PitCloseResponse, AppError> = async {
        let (snapshot, auth) = connection_for_request(&state, &request.connection_id)?;
        let profile = snapshot.profile();
        let client = network
            .0
            .as_ref()
            .map_err(Clone::clone)?
            .for_snapshot(&snapshot)?;
        let plan = query::pit_close_plan(profile, &request.pit_id)?.authenticate(&auth)?;
        client.execute(plan, &mut Cancellation::never()).await?;
        Ok(PitCloseResponse::new(&request))
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
    requests: State<'_, RequestState>,
    probe: ConnectionProbe,
) -> Result<ConnectionIdentity, AppError> {
    probe.validate()?;
    let result = async {
        let mut guard = requests
            .0
            .register(&probe.request_id, &probe.connection_id)?;
        let (snapshot, auth) = connection_for_request(&state, &probe.connection_id)?;
        let client = network
            .0
            .as_ref()
            .map_err(Clone::clone)?
            .for_snapshot(&snapshot)?;
        let read = client.test(
            snapshot.profile(),
            ConnectionProbe {
                request_id: probe.request_id.clone(),
                connection_id: probe.connection_id.clone(),
            },
            &auth,
        );
        tokio::select! {
            biased;
            () = guard.cancellation().cancelled() => Err(AppError::new("cancelled")),
            result = read => result,
        }
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
        .plugin(tauri_plugin_dialog::init())
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
            app.manage(connection_access::AccessCache::default());
            app.manage(query_export::SnapshotExportState::new());
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
            pit_open,
            pit_close,
            request_cancel,
            connection_test,
            connection_access::connection_access,
            connection_settings::connections_load,
            connection_settings::connections_save,
            connection_settings::connections_delete,
            connection_settings::connections_cleanup,
            saved_queries::saved_queries_load,
            saved_queries::saved_queries_save,
            saved_queries::saved_queries_export,
            query_exchange::query_exchange_read,
            query_exchange::query_exchange_save,
            query_exchange::query_exchange_import,
            query_export::query_export,
            query_export::query_export_cancel,
            workspace_recovery::workspace_recovery_load,
            workspace_recovery::workspace_recovery_save,
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
