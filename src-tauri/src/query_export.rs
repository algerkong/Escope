//! One explicit full-result scan, isolated from the workbench PIT and cancellation registry.
//! Only counts and file outcomes cross IPC; documents are streamed to a native-selected file.

mod encoding;
mod file;

use crate::connection::ReadOnlyClient;
use crate::connection_auth;
use crate::credentials::{CredentialStore, SystemCredentialStore};
use crate::error::AppError;
use crate::operation::{self, IndexTarget};
use crate::query::{self, QueryExecuteRequest};
use crate::read_only::{validate_uuid, CancelRequest, Cancellation, RequestRegistry};
use crate::saved_queries::{validate_export_name, ExportFormat};
use crate::storage::TransportSnapshot;
use crate::{with_database, NetworkState, StorageState};
use encoding::{prepare_body, Cursor, PreparedBody};
use file::{ExportFile, FileInfo, FileState};
use serde::{Deserialize, Serialize};
use std::future::Future;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};
use tauri::ipc::Channel;
use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;
use tokio::sync::Semaphore;

pub(super) const MAX_ROWS: u64 = 1_000_000;
pub(super) const MAX_BYTES: u64 = 1024 * 1024 * 1024;
pub(super) const MAX_PAGE_SIZE: usize = 1000;
const MAX_DURATION: Duration = Duration::from_secs(30 * 60);
const PROGRESS_INTERVAL: Duration = Duration::from_millis(250);
const CLEANUP_TIMEOUT: Duration = Duration::from_secs(12);

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SnapshotExportRequest {
    request_id: String,
    connection_id: String,
    expected_endpoint: String,
    index: String,
    raw_dsl: String,
    format: ExportFormat,
    file_name: String,
    max_rows: u64,
    max_bytes: u64,
}

impl SnapshotExportRequest {
    fn validate_ids(&self) -> Result<(), AppError> {
        validate_uuid(&self.request_id)?;
        validate_uuid(&self.connection_id)
    }

    fn prepare(&self) -> Result<PreparedBody, AppError> {
        self.validate_ids()?;
        IndexTarget::parse(&self.index)?;
        if !(1..=MAX_ROWS).contains(&self.max_rows) || !(1..=MAX_BYTES).contains(&self.max_bytes) {
            return Err(AppError::new("invalidInput"));
        }
        normalized_endpoint(&self.expected_endpoint)?;
        validate_export_name(&self.file_name, self.format)?;
        prepare_body(&self.raw_dsl)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
enum Phase {
    Choosing,
    Opening,
    Writing,
    Closing,
    Committing,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SnapshotExportProgress {
    request_id: String,
    connection_id: String,
    phase: Phase,
    rows: u64,
    bytes: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
enum ExportStatus {
    Saved,
    Cancelled,
    Limited,
    Partial,
    Failed,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
enum PitCleanup {
    NotOpened,
    Closed,
    Pending,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SnapshotExportOutcome {
    request_id: String,
    connection_id: String,
    status: ExportStatus,
    rows: u64,
    bytes: u64,
    file_state: FileState,
    file_name: Option<String>,
    reason: Option<&'static str>,
    pit_cleanup: PitCleanup,
}

impl SnapshotExportOutcome {
    fn new(
        request: &SnapshotExportRequest,
        file: FileInfo,
        error: Option<AppError>,
        pit_cleanup: PitCleanup,
    ) -> Self {
        let error = if error.is_none() && file.state != FileState::Complete {
            Some(AppError::new("exportFailed"))
        } else {
            error
        };
        let reason = error.map(|error| error.code);
        let status = match reason {
            None => ExportStatus::Saved,
            Some("cancelled") => ExportStatus::Cancelled,
            Some("rowLimit" | "byteLimit" | "deadline") => ExportStatus::Limited,
            Some("partialResponse") => ExportStatus::Partial,
            Some(_) => ExportStatus::Failed,
        };
        Self {
            request_id: request.request_id.clone(),
            connection_id: request.connection_id.clone(),
            status,
            rows: file.rows,
            bytes: file.bytes,
            file_state: file.state,
            file_name: file.name,
            reason,
            pit_cleanup,
        }
    }

    fn without_file(request: &SnapshotExportRequest, code: &'static str) -> Self {
        Self::new(
            request,
            FileInfo::none(),
            Some(AppError::new(code)),
            PitCleanup::NotOpened,
        )
    }
}

pub(crate) struct SnapshotExportState {
    requests: RequestRegistry,
    permit: Semaphore,
}

impl SnapshotExportState {
    pub(crate) fn new() -> Self {
        Self {
            requests: RequestRegistry::default(),
            permit: Semaphore::new(1),
        }
    }
}

fn normalized_endpoint(endpoint: &str) -> Result<String, AppError> {
    if endpoint.is_empty() || endpoint.len() > 2048 {
        return Err(AppError::new("invalidInput"));
    }
    let mut url = url::Url::parse(endpoint).map_err(|_| AppError::new("invalidEndpoint"))?;
    if !matches!(url.scheme(), "https" | "http")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(AppError::new("invalidEndpoint"));
    }
    url.set_path(&format!("{}/", url.path().trim_end_matches('/')));
    Ok(url.to_string())
}

fn same_transport(left: &TransportSnapshot, right: &TransportSnapshot) -> bool {
    left.profile().id == right.profile().id
        && left.profile().endpoint == right.profile().endpoint
        && left.profile().auth_state == right.profile().auth_state
        && left.ca().map(|ca| ca.as_pem()) == right.ca().map(|ca| ca.as_pem())
}

enum Read {
    Open(IndexTarget),
    Page(Vec<u8>),
    Close(String),
}

trait ExportTransport: Sync {
    fn check_target(&self) -> Result<(), AppError>;
    fn send(
        &self,
        read: Read,
        cancel: &mut Cancellation,
    ) -> impl Future<Output = Result<Vec<u8>, AppError>> + Send;
}

struct StoredTransport<'a> {
    storage: &'a StorageState,
    client: ReadOnlyClient,
    snapshot: TransportSnapshot,
    store: &'a dyn CredentialStore,
}

impl ExportTransport for StoredTransport<'_> {
    fn check_target(&self) -> Result<(), AppError> {
        let current = with_database(self.storage, |db| {
            db.transport_snapshot(&self.snapshot.profile().id)
        })?;
        if !same_transport(&self.snapshot, &current) {
            return Err(AppError::new("exportTargetChanged"));
        }
        Ok(())
    }

    async fn send(&self, read: Read, cancel: &mut Cancellation) -> Result<Vec<u8>, AppError> {
        // Cleanup must still target the captured connection, never the row that replaced it.
        if !matches!(&read, Read::Close(_)) {
            self.check_target()?;
        }
        let profile = self.snapshot.profile();
        let plan = match read {
            Read::Open(index) => query::pit_open_plan(profile, &index)?,
            Read::Page(body) => query::paginated_search_plan(profile, body)?,
            Read::Close(id) => query::pit_close_plan(profile, &id)?,
        };
        let auth = connection_auth::resolve(&self.snapshot, self.store)?;
        let client = self.client.for_snapshot(&self.snapshot)?;
        client.execute(plan.authenticate(&auth)?, cancel).await
    }
}

fn check_stop(cancel: &Cancellation, deadline: Instant) -> Result<(), AppError> {
    if cancel.is_cancelled() {
        return Err(AppError::new("cancelled"));
    }
    if Instant::now() >= deadline {
        return Err(AppError::new("deadline"));
    }
    Ok(())
}

struct Progress<'a, S> {
    request: &'a SnapshotExportRequest,
    sink: &'a S,
    last: Option<(Phase, Instant)>,
}

impl<S: Fn(SnapshotExportProgress) -> Result<(), AppError>> Progress<'_, S> {
    fn emit(&mut self, phase: Phase, info: &FileInfo) -> Result<(), AppError> {
        let now = Instant::now();
        if self.last.is_some_and(|(previous, sent)| {
            previous == phase && now.duration_since(sent) < PROGRESS_INTERVAL
        }) {
            return Ok(());
        }
        (self.sink)(SnapshotExportProgress {
            request_id: self.request.request_id.clone(),
            connection_id: self.request.connection_id.clone(),
            phase,
            rows: info.rows,
            bytes: info.bytes,
        })?;
        self.last = Some((phase, now));
        Ok(())
    }
}

async fn timed_read(
    transport: &impl ExportTransport,
    read: Read,
    cancel: &mut Cancellation,
    deadline: Instant,
) -> Result<Vec<u8>, AppError> {
    check_stop(cancel, deadline)?;
    tokio::time::timeout(
        deadline.saturating_duration_since(Instant::now()),
        transport.send(read, cancel),
    )
    .await
    .map_err(|_| AppError::new("deadline"))?
}

async fn run_export(
    request: &SnapshotExportRequest,
    prepared: &PreparedBody,
    target: &Path,
    transport: &impl ExportTransport,
    cancel: &mut Cancellation,
    deadline: Instant,
    sink: &(impl Fn(SnapshotExportProgress) -> Result<(), AppError> + Sync),
) -> SnapshotExportOutcome {
    if let Err(error) = check_stop(cancel, deadline).and_then(|()| transport.check_target()) {
        return SnapshotExportOutcome::without_file(request, error.code);
    }
    let mut file = match ExportFile::create(target).await {
        Ok(file) => file,
        Err(error) => return SnapshotExportOutcome::without_file(request, error.code),
    };
    let mut progress = Progress {
        request,
        sink,
        last: None,
    };
    let mut pit_id = None;
    let mut attempted_pit = false;
    let mut uncertain_pit = false;
    let scan = async {
        if request.format == ExportFormat::Csv {
            file.write(
                vec![encoding::CSV_HEADER.to_vec()],
                false,
                request.max_bytes,
                cancel.clone(),
                deadline,
            )
            .await?;
        }
        progress.emit(Phase::Opening, &file.info())?;
        check_stop(cancel, deadline)?;
        attempted_pit = true;
        uncertain_pit = true;
        let raw = timed_read(
            transport,
            Read::Open(IndexTarget::parse(&request.index)?),
            cancel,
            deadline,
        )
        .await?;
        pit_id = encoding::pit_hint(&raw, true)?;
        uncertain_pit = pit_id.is_none();
        encoding::validate_open(&raw)?;
        if pit_id.is_none() {
            return Err(AppError::new("invalidResponse"));
        }
        let mut cursor: Option<Cursor> = None;
        loop {
            check_stop(cancel, deadline)?;
            transport.check_target()?;
            progress.emit(Phase::Writing, &file.info())?;
            let body = QueryExecuteRequest {
                request_id: request.request_id.clone(),
                connection_id: request.connection_id.clone(),
                index: request.index.clone(),
                raw_dsl: request.raw_dsl.clone(),
                pit_id: pit_id.clone(),
                search_after: cursor.as_ref().map(|cursor| cursor.raw.clone()),
            }
            .prepare()?
            .body;
            uncertain_pit = true;
            let raw = timed_read(transport, Read::Page(body), cancel, deadline).await?;
            if let Some(latest) = encoding::pit_hint(&raw, false)? {
                pit_id = Some(latest);
            }
            uncertain_pit = false;
            let page = encoding::page(&raw, prepared, cursor.as_ref(), request.format)?;
            if page.records.is_empty() {
                break;
            }
            let remaining = request.max_rows - file.info().rows;
            let count = page.records.len() as u64;
            if remaining == 0 {
                return Err(AppError::new("rowLimit"));
            }
            let records = page.records.into_iter().take(remaining as usize).collect();
            file.write(records, true, request.max_bytes, cancel.clone(), deadline)
                .await?;
            progress.emit(Phase::Writing, &file.info())?;
            if count > remaining {
                return Err(AppError::new("rowLimit"));
            }
            cursor = page.cursor;
        }
        Ok(())
    }
    .await;
    let mut error = scan.err();
    let mut cleanup = PitCleanup::NotOpened;
    if attempted_pit {
        if let Err(failure) = progress.emit(Phase::Closing, &file.info()) {
            if error.is_none() {
                error = Some(failure);
            }
        }
        cleanup = PitCleanup::Pending;
        if let Some(id) = pit_id {
            let closed = tokio::time::timeout(
                CLEANUP_TIMEOUT,
                transport.send(Read::Close(id), &mut Cancellation::never()),
            )
            .await;
            if matches!(closed, Ok(Ok(ref raw)) if encoding::closed(raw)) && !uncertain_pit {
                cleanup = PitCleanup::Closed;
            }
        }
    }
    // Never abandon a blocking file operation on cancel/timeout. Await it, then decide whether
    // the fully flushed file may replace the selected target; otherwise retain the partial.
    if let Err(failure) = file.flush().await {
        error = Some(failure);
    }
    if error.is_none() {
        error = check_stop(cancel, deadline)
            .and_then(|()| transport.check_target())
            .err();
    }
    if error.is_none() {
        error = progress.emit(Phase::Committing, &file.info()).err();
    }
    if error.is_none() {
        error = file.commit(cancel.clone(), deadline).await.err();
    }
    SnapshotExportOutcome::new(request, file.info(), error, cleanup)
}

#[tauri::command]
pub(crate) async fn query_export(
    app: AppHandle,
    state: State<'_, StorageState>,
    network: State<'_, NetworkState>,
    exports: State<'_, SnapshotExportState>,
    request: SnapshotExportRequest,
    on_event: Channel<SnapshotExportProgress>,
) -> Result<SnapshotExportOutcome, AppError> {
    request.validate_ids()?;
    let result = async {
        let prepared = request.prepare()?;
        let mut guard = match exports
            .requests
            .register(&request.request_id, &request.connection_id)
        {
            Ok(guard) => guard,
            Err(error) if error.code == "cancelled" => {
                return Ok(SnapshotExportOutcome::without_file(&request, "cancelled"))
            }
            Err(error) => return Err(error),
        };
        let _permit = exports
            .permit
            .try_acquire()
            .map_err(|_| AppError::new("busy"))?;
        let deadline = Instant::now() + MAX_DURATION;
        let snapshot = with_database(&state, |db| db.transport_snapshot(&request.connection_id))?;
        if normalized_endpoint(&request.expected_endpoint)?
            != operation::base_url(snapshot.profile())?.as_str()
        {
            return Err(AppError::new("exportTargetChanged"));
        }
        let store = SystemCredentialStore::new();
        let transport = StoredTransport {
            storage: &state,
            client: network.0.as_ref().map_err(Clone::clone)?.clone(),
            snapshot,
            store: &store,
        };
        let sink = |progress| {
            on_event
                .send(progress)
                .map_err(|_| AppError::new("cancelled"))
        };
        Progress {
            request: &request,
            sink: &sink,
            last: None,
        }
        .emit(Phase::Choosing, &FileInfo::none())?;
        let file_name = request.file_name.trim().to_owned();
        let format = request.format;
        // The chooser cannot be force-closed safely. An early cancel is remembered, and its
        // eventual selection is ignored before any file/PIT is created.
        let selected = tauri::async_runtime::spawn_blocking(move || {
            app.dialog()
                .file()
                .set_file_name(file_name)
                .add_filter(format.label(), &[format.filter_extension()])
                .blocking_save_file()
                .map(|selected| {
                    selected
                        .as_path()
                        .map(Path::to_path_buf)
                        .ok_or_else(|| AppError::new("unsupported"))
                })
                .transpose()
        })
        .await
        .map_err(|_| AppError::new("exportFailed"))??;
        let Some(target): Option<PathBuf> = selected else {
            return Ok(SnapshotExportOutcome::without_file(&request, "cancelled"));
        };
        Ok(run_export(
            &request,
            &prepared,
            &target,
            &transport,
            guard.cancellation(),
            deadline,
            &sink,
        )
        .await)
    }
    .await;
    result.map_err(|mut error: AppError| {
        error.request_id = Some(request.request_id);
        error
    })
}

#[tauri::command]
pub(crate) fn query_export_cancel(
    exports: State<'_, SnapshotExportState>,
    request: CancelRequest,
) -> Result<bool, AppError> {
    request.validate()?;
    Ok(exports
        .requests
        .cancel(&request.request_id, &request.connection_id))
}

#[cfg(test)]
mod tests;
