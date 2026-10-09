//! `workspace_recovery` IPC: the workspace/tab/history recovery document.
//!
//! One versioned document stored as a single row (`Database::workspace_recovery_row` /
//! `Database::save_workspace_recovery`), mirroring the frontend `workspace-recovery` domain
//! module field for field:
//!
//! * `workspace_recovery_load` reads the stored JSON, validates it strictly (closed objects with
//!   `deny_unknown_fields` at every level, document version, counts, per-field bounds and byte
//!   bounds) and returns `{ revision: 0, document: { version: 1, workspace: null, history: [] } }`
//!   only when nothing was ever saved - a fresh read never inserts. Anything this build cannot
//!   explain fails with `invalidResponse` and the stored bytes are never rewritten.
//! * `workspace_recovery_save` validates the incoming document, validates the currently stored
//!   document (so a corrupt or future row can never be replaced, not even by a matching revision)
//!   and then compare-and-swaps under one SQL transaction: the write is applied only when the
//!   stored revision still equals `expectedRevision` (0 means no row), storing `revision + 1`
//!   atomically. A stale writer gets `workspaceConflict` and the stored bytes stay untouched.
//!
//! The document is local data, not a transport: response bodies, cursors, PIT ids, request
//! headers, credential settings and file paths have no field here, and an object carrying one is
//! refused rather than stripped. DSL text (which may be incomplete or invalid on purpose) and
//! visual-editor drafts are preserved verbatim; only their byte size is bounded. Historical
//! targets may name connections that no longer exist - nothing in this module resolves, rebinds
//! or deletes a stored ID against the connection table, and index identity stays the stable
//! connection ID plus the exact trimmed target.
//!
//! Numeric fields are `u64` counters within the JS-safe range, or the [`JsNumber`] wrapper for
//! grid widths, which serializes integral values exactly like `JSON.stringify` so the byte bounds
//! computed here match the bounds the frontend applied. This is deliberately stricter than the
//! frontend for exotic token spellings (`1.0` or `1e3` for a counter): the frontend never emits
//! them, and refusing them here keeps the stored bytes canonical.

use crate::error::AppError;
use crate::storage::Database;
use crate::{with_database, StorageState};
use serde::de::value::{MapAccessDeserializer, StrDeserializer};
use serde::de::{self, MapAccess, Unexpected, Visitor};
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fmt;
use std::marker::PhantomData;
use tauri::State;

/// Version of the recovery document this build writes and accepts (`WORKSPACE_RECOVERY_VERSION`).
pub const WORKSPACE_RECOVERY_VERSION: u32 = 1;

/// JS-safe upper bound of every revision counter, mirrored by the SQLite check on
/// `workspace_recovery.revision` and by the `expectedRevision` argument.
pub(crate) const MAX_REVISION: u64 = 9_007_199_254_740_991;

/// Hard bound on recovered tabs (`MAX_WORKSPACE_TABS`).
const MAX_WORKSPACE_TABS: usize = 50;
/// Hard bound on recovered execution-history entries (`MAX_EXECUTION_HISTORY`).
const MAX_EXECUTION_HISTORY: usize = 100;
/// Serialized workspace bound (`MAX_WORKSPACE_BYTES`).
const MAX_WORKSPACE_BYTES: usize = 4 * 1024 * 1024;
/// Serialized history bound (`MAX_HISTORY_BYTES`).
const MAX_HISTORY_BYTES: usize = 4 * 1024 * 1024;
/// Total serialized document bound (`MAX_RECOVERY_BYTES`), mirrored by migration 006's UTF-8
/// byte check on `workspace_recovery.json`.
pub(crate) const MAX_RECOVERY_BYTES: usize = MAX_WORKSPACE_BYTES + MAX_HISTORY_BYTES + 1024;
/// Hard bound on one grid map or column order (`MAX_GRID_COLUMNS`).
const MAX_GRID_COLUMNS: usize = 500;
/// Hard bound on stored sort entries.
const MAX_GRID_SORTING: usize = 10;
/// One draft body stays bounded without validating it (`MAX_ENTRY_DSL_BYTES`): an incomplete or
/// invalid query is still a draft.
const MAX_DSL_BYTES: usize = 256 * 1024;
/// Index targets, in tab documents and history snapshots (`MAX_ENTRY_INDEX_BYTES`).
const MAX_INDEX_BYTES: usize = 1024;
/// Field names inside visual forms (the frontend validator's `text(field, 1024)`).
const MAX_FIELD_BYTES: usize = 1024;
/// Display names: code points, not bytes (`name()` in the frontend validator).
const MAX_NAME_CHARS: usize = 120;
/// Stable IDs: `[A-Za-z0-9_-]{1,64}`.
const MAX_ID_BYTES: usize = 64;
/// Conditions inside one visual form.
const MAX_FORM_CONDITIONS: usize = 100;
/// Problems inside one visual draft.
const MAX_FORM_PROBLEMS: usize = 500;
/// Entries in `lastTabByConnection`.
const MAX_LAST_TABS: usize = 1000;
/// Grid column widths (`MIN_COLUMN_WIDTH`, `MAX_COLUMN_WIDTH`, `ROW_COLUMN_WIDTH`).
const MIN_COLUMN_WIDTH: f64 = 64.0;
const MAX_COLUMN_WIDTH: f64 = 480.0;
const ROW_COLUMN_WIDTH: f64 = 52.0;
const ROW_COLUMN_ID: &str = "meta:row";

fn invalid() -> AppError {
    AppError::new("invalidInput")
}

/// JSON value that must be present in its object but may be `null`. A missing key is a
/// deserialization error, exactly like the frontend `shape` helper - which is why this is not
/// `Option<T>` (serde treats an absent `Option` as `None`).
#[derive(Clone, PartialEq)]
pub(crate) struct Nullable<T>(pub(crate) Option<T>);

impl<T: Serialize> Serialize for Nullable<T> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        self.0.serialize(serializer)
    }
}

impl<'de, T: Deserialize<'de>> Deserialize<'de> for Nullable<T> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        deserializer.deserialize_any(NullableVisitor::<T>(PhantomData))
    }
}

struct NullableVisitor<T>(PhantomData<T>);

impl<'de, T: Deserialize<'de>> Visitor<'de> for NullableVisitor<T> {
    type Value = Nullable<T>;

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("a value or null")
    }

    fn visit_unit<E: de::Error>(self) -> Result<Self::Value, E> {
        Ok(Nullable(None))
    }

    fn visit_none<E: de::Error>(self) -> Result<Self::Value, E> {
        Ok(Nullable(None))
    }

    fn visit_some<D: Deserializer<'de>>(self, deserializer: D) -> Result<Self::Value, D::Error> {
        T::deserialize(deserializer).map(|value| Nullable(Some(value)))
    }

    fn visit_map<A: MapAccess<'de>>(self, map: A) -> Result<Self::Value, A::Error> {
        T::deserialize(MapAccessDeserializer::new(map)).map(|value| Nullable(Some(value)))
    }

    fn visit_str<E: de::Error>(self, value: &str) -> Result<Self::Value, E> {
        T::deserialize(StrDeserializer::<E>::new(value)).map(|value| Nullable(Some(value)))
    }
}

impl<T: fmt::Debug> fmt::Debug for Nullable<T> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(formatter)
    }
}

/// `Option<T>` for a key the contract allows to omit but never to set to `null`.
fn reject_null<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    match Option::<T>::deserialize(deserializer)? {
        Some(value) => Ok(Some(value)),
        None => Err(de::Error::invalid_value(Unexpected::Unit, &"a value")),
    }
}

fn unique_map<'de, D, T>(deserializer: D) -> Result<BTreeMap<String, T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    struct UniqueMap<T>(PhantomData<T>);
    impl<'de, T: Deserialize<'de>> Visitor<'de> for UniqueMap<T> {
        type Value = BTreeMap<String, T>;

        fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
            formatter.write_str("a bounded object with unique keys")
        }

        fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
            let mut values = BTreeMap::new();
            while let Some(key) = map.next_key::<String>()? {
                if values.len() >= MAX_LAST_TABS || values.contains_key(&key) {
                    return Err(de::Error::custom("invalid recovery map"));
                }
                values.insert(key, map.next_value()?);
            }
            Ok(values)
        }
    }
    deserializer.deserialize_map(UniqueMap(PhantomData))
}

/// A JSON number in a grid map. Integral values serialize exactly like `JSON.stringify` (`200`,
/// not `200.0`), so the byte bounds computed here match the bounds the frontend applied to the
/// same document. Deserialization keeps serde's normal number handling; the range check lives in
/// [`GridLayout::validate`].
#[derive(Clone, Copy, PartialEq)]
pub(crate) struct JsNumber(pub(crate) f64);

impl Serialize for JsNumber {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        if self.0.fract() == 0.0 && self.0 >= i64::MIN as f64 && self.0 <= i64::MAX as f64 {
            serializer.serialize_i64(self.0 as i64)
        } else {
            serializer.serialize_f64(self.0)
        }
    }
}

impl<'de> Deserialize<'de> for JsNumber {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        f64::deserialize(deserializer).map(JsNumber)
    }
}

impl fmt::Debug for JsNumber {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(formatter)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TabKind {
    Query,
    Index,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EditorMode {
    Dsl,
    Visual,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ResultView {
    Table,
    Json,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum HistoryKind {
    Query,
    Index,
    Continuation,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum HistoryStatus {
    Running,
    Success,
    Partial,
    Failed,
    Cancelled,
    Interrupted,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum VisualMode {
    All,
    Any,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum VisualOperator {
    Eq,
    Neq,
    Match,
    Gt,
    Gte,
    Lt,
    Lte,
    Exists,
    Missing,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum VisualContext {
    Filter,
    Must,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum VisualValueType {
    String,
    Number,
    Boolean,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SortDirection {
    Asc,
    Desc,
}

/// Closed list of the visual builder's problem codes, spelled exactly like the frontend union.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ProblemCode {
    FieldRequired,
    FieldConflict,
    FieldNested,
    FieldNotSearchable,
    OperatorNotAllowed,
    ValueTypeMismatch,
    NegativeInAny,
    ValueRequired,
    ValueInvalidNumber,
    ValueInvalidBoolean,
    SizeInvalid,
    SizeOutOfRange,
    SortDirectionInvalid,
    SortFieldRequired,
    SortFieldInvalid,
    SourceUnsupported,
}

/// One recovered query draft. `dsl` is stored verbatim, invalid or incomplete included.
#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TabDocument {
    pub id: String,
    pub connection_id: Nullable<String>,
    pub name: String,
    pub index: String,
    pub dsl: String,
    pub revision: u64,
    pub result_view: ResultView,
}

/// Debug output must never leak a draft body: the DSL is shown as its byte length only.
impl fmt::Debug for TabDocument {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("TabDocument")
            .field("id", &self.id)
            .field("connection_id", &self.connection_id)
            .field("name", &self.name)
            .field("index", &self.index)
            .field("dsl_bytes", &self.dsl.len())
            .field("revision", &self.revision)
            .field("result_view", &self.result_view)
            .finish()
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GridSort {
    pub id: String,
    pub desc: bool,
}

/// The layout part of a result grid: exactly the four persisted fields.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GridLayout {
    pub column_order: Vec<String>,
    #[serde(deserialize_with = "unique_map")]
    pub column_sizing: BTreeMap<String, JsNumber>,
    #[serde(deserialize_with = "unique_map")]
    pub column_visibility: BTreeMap<String, bool>,
    pub sorting: Vec<GridSort>,
}

#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VisualOriginal {
    pub field: String,
    pub value: String,
    pub value_type: VisualValueType,
    pub raw: String,
}

/// Debug output must never leak a visual value: field names stay, tokens are byte lengths.
impl fmt::Debug for VisualOriginal {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("VisualOriginal")
            .field("field", &self.field)
            .field("value_bytes", &self.value.len())
            .field("value_type", &self.value_type)
            .field("raw_bytes", &self.raw.len())
            .finish()
    }
}

#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VisualCondition {
    pub id: String,
    pub field: String,
    pub operator: VisualOperator,
    pub context: VisualContext,
    pub value_type: VisualValueType,
    pub value: String,
    /// Absent when the row was never touched; the contract allows omission, never `null`.
    #[serde(
        default,
        deserialize_with = "reject_null",
        skip_serializing_if = "Option::is_none"
    )]
    pub original: Option<VisualOriginal>,
}

/// Debug output must never leak a visual value: the draft token is a byte length only.
impl fmt::Debug for VisualCondition {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("VisualCondition")
            .field("id", &self.id)
            .field("field", &self.field)
            .field("operator", &self.operator)
            .field("context", &self.context)
            .field("value_type", &self.value_type)
            .field("value_bytes", &self.value.len())
            .field("original", &self.original)
            .finish()
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VisualSort {
    pub field: String,
    pub direction: SortDirection,
}

#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VisualForm {
    pub mode: VisualMode,
    pub conditions: Vec<VisualCondition>,
    pub size: String,
    pub sort: Nullable<VisualSort>,
}

/// Debug output must never leak a visual value: the size draft is a byte length only.
impl fmt::Debug for VisualForm {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("VisualForm")
            .field("mode", &self.mode)
            .field("conditions", &self.conditions)
            .field("size_bytes", &self.size.len())
            .field("sort", &self.sort)
            .finish()
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VisualBuildProblem {
    pub code: ProblemCode,
    #[serde(
        default,
        deserialize_with = "reject_null",
        skip_serializing_if = "Option::is_none"
    )]
    pub condition_id: Option<String>,
}

#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VisualEditorDraft {
    pub source: String,
    pub form: Nullable<VisualForm>,
    pub problems: Vec<VisualBuildProblem>,
}

/// Debug output must never leak a draft body: the source is shown as its byte length only.
impl fmt::Debug for VisualEditorDraft {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("VisualEditorDraft")
            .field("source_bytes", &self.source.len())
            .field("form", &self.form)
            .field("problems", &self.problems)
            .finish()
    }
}

#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecoveryTab {
    pub kind: TabKind,
    pub document: TabDocument,
    pub grid: GridLayout,
    pub editor_mode: EditorMode,
    pub visual_draft: Nullable<VisualEditorDraft>,
}

impl fmt::Debug for RecoveryTab {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("RecoveryTab")
            .field("kind", &self.kind)
            .field("document", &self.document)
            .field("grid", &self.grid)
            .field("editor_mode", &self.editor_mode)
            .field("visual_draft", &self.visual_draft)
            .finish()
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecoveryWorkspace {
    pub active_connection_id: Nullable<String>,
    pub active_tab_id: Nullable<String>,
    pub tabs: Vec<RecoveryTab>,
    #[serde(deserialize_with = "unique_map")]
    pub last_tab_by_connection: BTreeMap<String, Nullable<String>>,
}

#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExecutionSnapshot {
    pub request_id: String,
    pub query_id: String,
    pub connection_id: String,
    pub index: String,
    pub raw_dsl: String,
    pub revision: u64,
    pub started_at: String,
}

/// Debug output must never leak a frozen request body: the DSL is a byte length only.
impl fmt::Debug for ExecutionSnapshot {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ExecutionSnapshot")
            .field("request_id", &self.request_id)
            .field("query_id", &self.query_id)
            .field("connection_id", &self.connection_id)
            .field("index", &self.index)
            .field("raw_dsl_bytes", &self.raw_dsl.len())
            .field("revision", &self.revision)
            .field("started_at", &self.started_at)
            .finish()
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExecutionHistoryEntry {
    pub snapshot: ExecutionSnapshot,
    pub name: String,
    pub kind: HistoryKind,
    pub status: HistoryStatus,
    /// Unknown after a crash: `null` for `running` and `interrupted`, never synthesized.
    pub finished_at: Nullable<String>,
    pub error_code: Nullable<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceRecoveryDocument {
    pub version: u32,
    pub workspace: Nullable<RecoveryWorkspace>,
    /// Newest execution first. No result body, cursor, PIT or transport settings.
    pub history: Vec<ExecutionHistoryEntry>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceRecoveryRecord {
    pub revision: u64,
    pub document: WorkspaceRecoveryDocument,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceRecoverySaveOutcome {
    pub revision: u64,
}

impl WorkspaceRecoveryDocument {
    fn empty() -> Self {
        Self {
            version: WORKSPACE_RECOVERY_VERSION,
            workspace: Nullable(None),
            history: Vec::new(),
        }
    }

    /// The full contract check, mirroring `parseRecoveryDocument` in the frontend domain module.
    /// Serialization of a validated document cannot fail (plain data, no maps with non-string
    /// keys), so a failure here is always the caller's payload.
    fn validate(&self) -> Result<(), AppError> {
        if self.version != WORKSPACE_RECOVERY_VERSION {
            return Err(invalid());
        }
        if let Nullable(Some(workspace)) = &self.workspace {
            workspace.validate()?;
        }
        if self.history.len() > MAX_EXECUTION_HISTORY {
            return Err(invalid());
        }
        let mut request_ids = HashSet::with_capacity(self.history.len());
        for entry in &self.history {
            entry.validate()?;
            if !request_ids.insert(entry.snapshot.request_id.as_str()) {
                return Err(invalid());
            }
        }
        if serialized_bytes(&self.history)? > MAX_HISTORY_BYTES {
            return Err(invalid());
        }
        // The total bound (8 MiB + 1 KiB) is the same one migration 006 puts on the row. With both
        // parts already bounded it only covers the document wrapper here, but it is the bound the
        // frontend applies, so it is enforced identically.
        if serialized_bytes(self)? > MAX_RECOVERY_BYTES {
            return Err(invalid());
        }
        Ok(())
    }
}

impl RecoveryWorkspace {
    fn validate(&self) -> Result<(), AppError> {
        if let Nullable(Some(id)) = &self.active_connection_id {
            validate_id(id)?;
        }
        if let Nullable(Some(id)) = &self.active_tab_id {
            validate_id(id)?;
        }
        if self.tabs.len() > MAX_WORKSPACE_TABS {
            return Err(invalid());
        }
        let mut connections: HashMap<&str, &Nullable<String>> =
            HashMap::with_capacity(self.tabs.len());
        let mut targets: HashSet<(&str, &str)> = HashSet::new();
        for tab in &self.tabs {
            tab.validate()?;
            if connections
                .insert(tab.document.id.as_str(), &tab.document.connection_id)
                .is_some()
            {
                return Err(invalid());
            }
            if tab.kind == TabKind::Index {
                let Nullable(Some(connection)) = &tab.document.connection_id else {
                    return Err(invalid());
                };
                let target = tab.document.index.as_str();
                if target.trim().is_empty()
                    || target != target.trim()
                    || tab.editor_mode != EditorMode::Dsl
                    || tab.visual_draft.0.is_some()
                {
                    return Err(invalid());
                }
                if !targets.insert((connection.as_str(), target)) {
                    return Err(invalid());
                }
            }
        }
        if let Nullable(Some(active)) = &self.active_tab_id {
            if !connections.contains_key(active.as_str()) {
                return Err(invalid());
            }
        }
        if self.last_tab_by_connection.len() > MAX_LAST_TABS {
            return Err(invalid());
        }
        for (connection, tab_id) in &self.last_tab_by_connection {
            if !(connection.is_empty() || valid_id(connection)) {
                return Err(invalid());
            }
            if let Nullable(Some(tab_id)) = tab_id {
                validate_id(tab_id)?;
                match connections.get(tab_id.as_str()) {
                    Some(stored) if stored.0.as_deref().unwrap_or("") == connection.as_str() => {}
                    _ => return Err(invalid()),
                }
            }
        }
        if serialized_bytes(self)? > MAX_WORKSPACE_BYTES {
            return Err(invalid());
        }
        Ok(())
    }
}

impl RecoveryTab {
    fn validate(&self) -> Result<(), AppError> {
        self.document.validate()?;
        self.grid.validate()?;
        if let Nullable(Some(draft)) = &self.visual_draft {
            draft.validate(&self.document.dsl)?;
        }
        Ok(())
    }
}

impl TabDocument {
    fn validate(&self) -> Result<(), AppError> {
        validate_id(&self.id)?;
        if let Nullable(Some(connection_id)) = &self.connection_id {
            validate_id(connection_id)?;
        }
        validate_name(&self.name)?;
        if self.index.len() > MAX_INDEX_BYTES || self.dsl.len() > MAX_DSL_BYTES {
            return Err(invalid());
        }
        if self.revision > MAX_REVISION {
            return Err(invalid());
        }
        Ok(())
    }
}

impl GridLayout {
    fn validate(&self) -> Result<(), AppError> {
        if self.column_order.len() > MAX_GRID_COLUMNS {
            return Err(invalid());
        }
        let mut order = HashSet::with_capacity(self.column_order.len());
        for column in &self.column_order {
            validate_column_id(column)?;
            if !order.insert(column.as_str()) {
                return Err(invalid());
            }
        }
        if self.column_sizing.len() > MAX_GRID_COLUMNS
            || self.column_visibility.len() > MAX_GRID_COLUMNS
        {
            return Err(invalid());
        }
        for (column, width) in &self.column_sizing {
            validate_column_id(column)?;
            let minimum = if column == ROW_COLUMN_ID {
                ROW_COLUMN_WIDTH
            } else {
                MIN_COLUMN_WIDTH
            };
            if !width.0.is_finite() || width.0 < minimum || width.0 > MAX_COLUMN_WIDTH {
                return Err(invalid());
            }
        }
        for (column, visible) in &self.column_visibility {
            validate_column_id(column)?;
            if column == ROW_COLUMN_ID && !visible {
                return Err(invalid());
            }
        }
        if self.sorting.len() > MAX_GRID_SORTING {
            return Err(invalid());
        }
        let mut sorted = HashSet::with_capacity(self.sorting.len());
        for sort in &self.sorting {
            validate_column_id(&sort.id)?;
            if !sorted.insert(sort.id.as_str()) {
                return Err(invalid());
            }
        }
        Ok(())
    }
}

impl VisualEditorDraft {
    fn validate(&self, dsl: &str) -> Result<(), AppError> {
        if self.source != dsl {
            return Err(invalid());
        }
        if let Nullable(Some(form)) = &self.form {
            form.validate()?;
        }
        if self.problems.len() > MAX_FORM_PROBLEMS {
            return Err(invalid());
        }
        for problem in &self.problems {
            if let Some(condition_id) = &problem.condition_id {
                validate_id(condition_id)?;
            }
        }
        Ok(())
    }
}

impl VisualForm {
    fn validate(&self) -> Result<(), AppError> {
        if self.size.len() > MAX_FIELD_BYTES {
            return Err(invalid());
        }
        if let Nullable(Some(sort)) = &self.sort {
            sort.validate()?;
        }
        if self.conditions.len() > MAX_FORM_CONDITIONS {
            return Err(invalid());
        }
        let mut ids = HashSet::with_capacity(self.conditions.len());
        for condition in &self.conditions {
            condition.validate()?;
            if !ids.insert(condition.id.as_str()) {
                return Err(invalid());
            }
        }
        Ok(())
    }
}

impl VisualSort {
    fn validate(&self) -> Result<(), AppError> {
        if self.field.len() > MAX_FIELD_BYTES {
            return Err(invalid());
        }
        Ok(())
    }
}

impl VisualCondition {
    fn validate(&self) -> Result<(), AppError> {
        validate_id(&self.id)?;
        if self.field.len() > MAX_FIELD_BYTES || self.value.len() > MAX_DSL_BYTES {
            return Err(invalid());
        }
        if let Some(original) = &self.original {
            original.validate()?;
        }
        Ok(())
    }
}

impl VisualOriginal {
    fn validate(&self) -> Result<(), AppError> {
        if self.field.len() > MAX_FIELD_BYTES
            || self.value.len() > MAX_DSL_BYTES
            || self.raw.len() > MAX_DSL_BYTES
        {
            return Err(invalid());
        }
        Ok(())
    }
}

impl ExecutionHistoryEntry {
    fn validate(&self) -> Result<(), AppError> {
        self.snapshot.validate()?;
        validate_name(&self.name)?;
        let pending = matches!(
            self.status,
            HistoryStatus::Running | HistoryStatus::Interrupted
        );
        match &self.finished_at {
            Nullable(None) => {
                if !pending {
                    return Err(invalid());
                }
            }
            Nullable(Some(finished)) => {
                if pending || !valid_timestamp(finished) {
                    return Err(invalid());
                }
            }
        }
        if let Nullable(Some(code)) = &self.error_code {
            if !valid_error_code(code) {
                return Err(invalid());
            }
        }
        match self.status {
            // A failed execution must say why; `cancelled` may carry a code; everything else
            // (`running`, `success`, `partial`, `interrupted`) must not.
            HistoryStatus::Failed => {
                if self.error_code.0.is_none() {
                    return Err(invalid());
                }
            }
            HistoryStatus::Cancelled => {}
            _ => {
                if self.error_code.0.is_some() {
                    return Err(invalid());
                }
            }
        }
        if let Nullable(Some(finished)) = &self.finished_at {
            if finished < &self.snapshot.started_at {
                return Err(invalid());
            }
        }
        Ok(())
    }
}

impl ExecutionSnapshot {
    fn validate(&self) -> Result<(), AppError> {
        validate_id(&self.request_id)?;
        validate_id(&self.query_id)?;
        validate_id(&self.connection_id)?;
        if self.index.len() > MAX_INDEX_BYTES || self.index.trim().is_empty() {
            return Err(invalid());
        }
        if self.raw_dsl.len() > MAX_DSL_BYTES {
            return Err(invalid());
        }
        if self.revision > MAX_REVISION {
            return Err(invalid());
        }
        if !valid_timestamp(&self.started_at) {
            return Err(invalid());
        }
        Ok(())
    }
}

/// Bounded serialization for the byte checks. The result is the compact JSON the frontend's
/// `JSON.stringify` would produce for the same value.
fn serialized_bytes<T: Serialize>(value: &T) -> Result<usize, AppError> {
    serde_json::to_vec(value)
        .map(|bytes| bytes.len())
        .map_err(|_| invalid())
}

/// `[A-Za-z0-9_-]{1,64}`: stable connection, tab, request and condition identities.
fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_ID_BYTES
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

fn validate_id(value: &str) -> Result<(), AppError> {
    if valid_id(value) {
        Ok(())
    } else {
        Err(invalid())
    }
}

/// Display names: at most 120 code points and no C0/C1 control characters.
fn validate_name(value: &str) -> Result<(), AppError> {
    if value.chars().count() > MAX_NAME_CHARS || value.chars().any(is_forbidden_control) {
        return Err(invalid());
    }
    Ok(())
}

fn is_forbidden_control(character: char) -> bool {
    matches!(character, '\u{0}'..='\u{1f}' | '\u{7f}'..='\u{9f}')
}

/// Grid column identity: the three metadata columns or a `field:` name, bounded to the same 1024
/// bytes as a field name and free of control characters.
fn validate_column_id(value: &str) -> Result<(), AppError> {
    if value.len() > MAX_FIELD_BYTES
        || value.chars().any(is_forbidden_control)
        || !(matches!(value, "meta:row" | "meta:index" | "meta:id")
            || (value.starts_with("field:") && value.len() > "field:".len()))
    {
        return Err(invalid());
    }
    Ok(())
}

/// `^[A-Za-z][A-Za-z0-9]{0,63}$`: the shape of an execution error code.
fn valid_error_code(value: &str) -> bool {
    let bytes = value.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 64
        && bytes[0].is_ascii_alphabetic()
        && bytes[1..].iter().all(u8::is_ascii_alphanumeric)
}

/// Canonical UTC `YYYY-MM-DDTHH:mm:ss.SSSZ` with true calendar values. The frontend also requires
/// `Date.toISOString()` to equal the input; for this exact grammar that is equivalent to the
/// calendar check below (an out-of-range component either fails to parse or round-trips to a
/// different stamp), and no dependency is needed for it.
fn valid_timestamp(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() != 24
        || bytes[4] != b'-'
        || bytes[7] != b'-'
        || bytes[10] != b'T'
        || bytes[13] != b':'
        || bytes[16] != b':'
        || bytes[19] != b'.'
        || bytes[23] != b'Z'
    {
        return false;
    }
    for (index, byte) in bytes.iter().enumerate() {
        if matches!(index, 4 | 7 | 10 | 13 | 16 | 19 | 23) {
            continue;
        }
        if !byte.is_ascii_digit() {
            return false;
        }
    }
    let number = |start: usize, length: usize| {
        bytes[start..start + length]
            .iter()
            .fold(0u32, |acc, byte| acc * 10 + u32::from(byte - b'0'))
    };
    let year = number(0, 4);
    let month = number(5, 2);
    let day = number(8, 2);
    let hour = number(11, 2);
    let minute = number(14, 2);
    let second = number(17, 2);
    let millis = number(20, 3);
    if !(1..=12).contains(&month)
        || !(1..=31).contains(&day)
        || day > days_in_month(year, month)
        || hour > 23
        || minute > 59
        || second > 59
        || millis > 999
    {
        return false;
    }
    true
}

fn days_in_month(year: u32, month: u32) -> u32 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        _ => {
            if year % 4 == 0 && (year % 100 != 0 || year % 400 == 0) {
                29
            } else {
                28
            }
        }
    }
}

/// Parse and fully validate a stored document. Every failure is `invalidResponse`: the bytes are
/// foreign, damaged or written by a newer build, and neither a read nor a later save may repair
/// or replace them.
pub(crate) fn decode_stored(json: &str) -> Result<WorkspaceRecoveryDocument, AppError> {
    decode(json).map_err(|_| AppError::new("invalidResponse"))
}

/// Parse and validate one document; failures are `invalidInput` (an incoming payload).
fn decode(json: &str) -> Result<WorkspaceRecoveryDocument, AppError> {
    let document: WorkspaceRecoveryDocument = serde_json::from_str(json).map_err(|_| invalid())?;
    document.validate()?;
    Ok(document)
}

fn load(database: &Database) -> Result<WorkspaceRecoveryRecord, AppError> {
    let Some(row) = database.workspace_recovery_row()? else {
        return Ok(WorkspaceRecoveryRecord {
            revision: 0,
            document: WorkspaceRecoveryDocument::empty(),
        });
    };
    let revision = u64::try_from(row.revision).map_err(|_| AppError::new("invalidResponse"))?;
    let document = decode_stored(&row.json)?;
    Ok(WorkspaceRecoveryRecord { revision, document })
}

fn save(
    database: &mut Database,
    expected_revision: u64,
    document: WorkspaceRecoveryDocument,
) -> Result<WorkspaceRecoverySaveOutcome, AppError> {
    if expected_revision >= MAX_REVISION {
        return Err(invalid());
    }
    document.validate()?;
    let json = serde_json::to_string(&document).map_err(|_| invalid())?;
    let revision = database.save_workspace_recovery(expected_revision, &json)?;
    Ok(WorkspaceRecoverySaveOutcome { revision })
}

/// Read the whole recovery document. A fresh database reads as revision 0 with the empty
/// document and no row is inserted; a document this build cannot explain is `invalidResponse`.
#[tauri::command]
pub(crate) fn workspace_recovery_load(
    state: State<'_, StorageState>,
) -> Result<WorkspaceRecoveryRecord, AppError> {
    with_database(&state, |database| load(database))
}

/// Replace the whole recovery document after validating it, and only when the caller's
/// `expectedRevision` still matches the stored one under the compare-and-swap transaction.
#[tauri::command]
pub(crate) fn workspace_recovery_save(
    state: State<'_, StorageState>,
    expected_revision: u64,
    document: WorkspaceRecoveryDocument,
) -> Result<WorkspaceRecoverySaveOutcome, AppError> {
    with_database(&state, |database| {
        save(database, expected_revision, document)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::ConnectionInput;
    use rusqlite::Connection;
    use tempfile::tempdir;

    const CONNECTION: &str = "3f2f2c9a-5b1e-4c6d-9a70-1b2c3d4e5f60";
    const OTHER_CONNECTION: &str = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";
    const START: &str = "2026-10-09T10:00:00.000Z";
    const LATER: &str = "2026-10-09T10:00:05.000Z";
    /// Valid JSON with a number token no float could carry through a round trip.
    const LARGE_DSL: &str = r#"{"query":{"range":{"total":{"gte":9007199254740993}}},"size":25}"#;

    fn empty_grid() -> GridLayout {
        GridLayout {
            column_order: Vec::new(),
            column_sizing: BTreeMap::new(),
            column_visibility: BTreeMap::new(),
            sorting: Vec::new(),
        }
    }

    fn grid() -> GridLayout {
        GridLayout {
            column_order: vec!["meta:row".to_owned(), "field:total".to_owned()],
            column_sizing: BTreeMap::from([
                ("meta:row".to_owned(), JsNumber(ROW_COLUMN_WIDTH)),
                ("field:total".to_owned(), JsNumber(200.0)),
            ]),
            column_visibility: BTreeMap::from([("meta:row".to_owned(), true)]),
            sorting: vec![GridSort {
                id: "field:total".to_owned(),
                desc: true,
            }],
        }
    }

    fn document(id: &str, connection_id: Nullable<String>, dsl: &str) -> TabDocument {
        TabDocument {
            id: id.to_owned(),
            connection_id,
            name: format!("Draft {id}"),
            index: "orders-*".to_owned(),
            dsl: dsl.to_owned(),
            revision: 3,
            result_view: ResultView::Table,
        }
    }

    fn query_tab(id: &str, dsl: &str) -> RecoveryTab {
        RecoveryTab {
            kind: TabKind::Query,
            document: document(id, Nullable(Some(CONNECTION.to_owned())), dsl),
            grid: grid(),
            editor_mode: EditorMode::Dsl,
            visual_draft: Nullable(None),
        }
    }

    fn index_tab(id: &str, connection: &str, target: &str) -> RecoveryTab {
        RecoveryTab {
            kind: TabKind::Index,
            document: document(id, Nullable(Some(connection.to_owned())), ""),
            grid: empty_grid(),
            editor_mode: EditorMode::Dsl,
            visual_draft: Nullable(None),
        }
        .with_index(target)
    }

    impl RecoveryTab {
        fn with_index(mut self, target: &str) -> Self {
            self.document.index = target.to_owned();
            self
        }
    }

    fn snapshot(request_id: &str, dsl: &str) -> ExecutionSnapshot {
        ExecutionSnapshot {
            request_id: request_id.to_owned(),
            query_id: format!("{request_id}q"),
            connection_id: CONNECTION.to_owned(),
            index: "orders".to_owned(),
            raw_dsl: dsl.to_owned(),
            revision: 2,
            started_at: START.to_owned(),
        }
    }

    fn entry(request_id: &str, dsl: &str) -> ExecutionHistoryEntry {
        ExecutionHistoryEntry {
            snapshot: snapshot(request_id, dsl),
            name: format!("Run {request_id}"),
            kind: HistoryKind::Query,
            status: HistoryStatus::Running,
            finished_at: Nullable(None),
            error_code: Nullable(None),
        }
    }

    fn base_document(
        tabs: Vec<RecoveryTab>,
        history: Vec<ExecutionHistoryEntry>,
    ) -> WorkspaceRecoveryDocument {
        let active_tab_id = tabs.first().map(|tab| tab.document.id.clone());
        WorkspaceRecoveryDocument {
            version: WORKSPACE_RECOVERY_VERSION,
            workspace: Nullable(Some(RecoveryWorkspace {
                active_connection_id: Nullable(Some(CONNECTION.to_owned())),
                active_tab_id: Nullable(active_tab_id),
                tabs,
                last_tab_by_connection: BTreeMap::new(),
            })),
            history,
        }
    }

    fn visual_form() -> VisualForm {
        VisualForm {
            mode: VisualMode::All,
            conditions: vec![VisualCondition {
                id: "cond1".to_owned(),
                field: "total".to_owned(),
                operator: VisualOperator::Gte,
                context: VisualContext::Filter,
                value_type: VisualValueType::Number,
                value: "9007199254740991".to_owned(),
                original: Some(VisualOriginal {
                    field: "total".to_owned(),
                    value: "9007199254740991".to_owned(),
                    value_type: VisualValueType::Number,
                    raw: "9007199254740991".to_owned(),
                }),
            }],
            size: "25".to_owned(),
            sort: Nullable(Some(VisualSort {
                field: "total".to_owned(),
                direction: SortDirection::Desc,
            })),
        }
    }

    /// Every field of the contract populated: an editor draft pinned to its DSL, both tab kinds,
    /// a bounded grid layout and history entries in running/success/failed states.
    fn full_document() -> WorkspaceRecoveryDocument {
        let mut success = entry("req2", "{\"size\":10}");
        success.status = HistoryStatus::Success;
        success.finished_at = Nullable(Some("2026-10-09T10:00:02.000Z".to_owned()));
        let mut failed = entry("req3", "{}");
        failed.status = HistoryStatus::Failed;
        failed.finished_at = Nullable(Some("2026-10-09T10:00:03.000Z".to_owned()));
        failed.error_code = Nullable(Some("timeout".to_owned()));
        let draft = VisualEditorDraft {
            source: LARGE_DSL.to_owned(),
            form: Nullable(Some(visual_form())),
            problems: vec![VisualBuildProblem {
                code: ProblemCode::FieldRequired,
                condition_id: None,
            }],
        };
        let mut document = base_document(
            vec![
                query_tab("tab1", LARGE_DSL).with_draft(draft),
                index_tab("tab2", OTHER_CONNECTION, "logs-2026.10.09"),
            ],
            vec![entry("req1", "{\"size\":0}"), success, failed],
        );
        // A revision at the top of the JS-safe range: it must survive as an exact number token.
        document.workspace.0.as_mut().unwrap().tabs[0]
            .document
            .revision = MAX_REVISION;
        document
            .workspace
            .0
            .as_mut()
            .unwrap()
            .last_tab_by_connection = BTreeMap::from([
            (CONNECTION.to_owned(), Nullable(Some("tab1".to_owned()))),
            (
                OTHER_CONNECTION.to_owned(),
                Nullable(Some("tab2".to_owned())),
            ),
        ]);
        document
    }

    impl RecoveryTab {
        fn with_draft(mut self, draft: VisualEditorDraft) -> Self {
            self.visual_draft = Nullable(Some(draft));
            self
        }
    }

    fn database() -> (tempfile::TempDir, Database) {
        let directory = tempdir().unwrap();
        let database = Database::open(&directory.path().join("recovery.sqlite")).unwrap();
        (directory, database)
    }

    fn encoded(document: &WorkspaceRecoveryDocument) -> serde_json::Value {
        serde_json::to_value(document).unwrap()
    }

    fn decode_value(value: &serde_json::Value) -> Result<WorkspaceRecoveryDocument, AppError> {
        decode(&serde_json::to_string(value).unwrap())
    }

    fn refused(value: &serde_json::Value, context: &str) {
        let error = decode_value(value).unwrap_err();
        assert_eq!(error.code, "invalidInput", "{context}");
    }

    fn accepted(value: &serde_json::Value, context: &str) {
        decode_value(value).unwrap_or_else(|error| panic!("{context}: {}", error.code));
    }

    fn stored_row(path: &std::path::Path) -> (i64, String) {
        let raw = Connection::open(path).unwrap();
        raw.query_row(
            "SELECT revision, json FROM workspace_recovery WHERE singleton=1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap()
    }

    #[test]
    fn empty_database_reads_the_empty_document_and_never_inserts() {
        let (_directory, database) = database();
        let record = load(&database).unwrap();
        assert_eq!(record.revision, 0);
        assert_eq!(record.document, WorkspaceRecoveryDocument::empty());
        assert_eq!(record.document.workspace, Nullable(None));
        assert!(record.document.history.is_empty());
        // A fresh read is not a write: no row was created.
        assert!(database.workspace_recovery_row().unwrap().is_none());
    }

    #[test]
    fn shared_frontend_fixture_round_trips_the_same_typed_contract() {
        let source = include_str!("../../tests/fixtures/workspace-recovery-v1.json");
        let document = decode(source).unwrap();
        let (_directory, mut database) = database();
        save(&mut database, 0, document).unwrap();
        let loaded = load(&database).unwrap();
        let expected: serde_json::Value = serde_json::from_str(source).unwrap();
        assert_eq!(serde_json::to_value(&loaded.document).unwrap(), expected);
        let encoded = serde_json::to_string(&loaded.document).unwrap();
        assert!(encoded.contains("9007199254740993"));
        assert!(!format!("{:?}", loaded.document).contains("9007199254740993"));
        assert!(!format!("{:?}", loaded.document).contains("unfinished-"));
    }

    #[test]
    fn duplicate_map_keys_fail_closed_without_rewriting_the_stored_bytes() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("duplicate-maps.sqlite");
        let mut database = Database::open(&path).unwrap();
        let good = base_document(vec![query_tab("tab1", "{}")], Vec::new());
        save(&mut database, 0, good.clone()).unwrap();
        let json = serde_json::to_string(&good).unwrap();
        for corrupted in [
            json.replace(
                r#""columnSizing":{"#,
                r#""columnSizing":{"field:duplicate":100,"field:duplicate":120,"#,
            ),
            json.replace(
                r#""columnVisibility":{"#,
                r#""columnVisibility":{"field:duplicate":true,"field:duplicate":false,"#,
            ),
            json.replace(
                r#""lastTabByConnection":{}"#,
                r#""lastTabByConnection":{"a":null,"a":null}"#,
            ),
        ] {
            Connection::open(&path)
                .unwrap()
                .execute(
                    "UPDATE workspace_recovery SET json=?1 WHERE singleton=1",
                    [&corrupted],
                )
                .unwrap();
            assert_eq!(load(&database).unwrap_err().code, "invalidResponse");
            assert_eq!(
                save(&mut database, 1, good.clone()).unwrap_err().code,
                "invalidResponse"
            );
            assert_eq!(stored_row(&path).1, corrupted);
        }
    }
    #[test]
    fn save_round_trips_every_field_with_exact_tokens_and_bumps_the_revision() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("recovery.sqlite");
        let mut database = Database::open(&path).unwrap();
        let document = full_document();
        document.validate().unwrap();

        let outcome = save(&mut database, 0, document.clone()).unwrap();
        assert_eq!(outcome.revision, 1);
        let record = load(&database).unwrap();
        assert_eq!(record.revision, 1);
        assert_eq!(record.document, document);

        // The stored bytes carry the DSL verbatim and keep the numeric tokens exact; integral
        // widths serialize like JSON.stringify instead of `200.0`.
        let stored = stored_row(&path).1;
        let stored_json: serde_json::Value = serde_json::from_str(&stored).unwrap();
        assert_eq!(
            stored_json["workspace"]["tabs"][0]["document"]["dsl"],
            serde_json::Value::String(LARGE_DSL.to_owned())
        );
        assert!(stored.contains("\"revision\":9007199254740991"));
        assert!(stored.contains("\"field:total\":200"));

        // A save at the current revision advances it; the document is replaced, not appended.
        let mut next = document.clone();
        next.history[0].name = "Renamed".to_owned();
        assert_eq!(save(&mut database, 1, next.clone()).unwrap().revision, 2);
        let record = load(&database).unwrap();
        assert_eq!(record.revision, 2);
        assert_eq!(record.document, next);
        assert_eq!(stored_row(&path).0, 2);
    }

    #[test]
    fn stale_or_unsafe_revisions_are_refused_without_touching_the_stored_document() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("recovery.sqlite");
        let mut database = Database::open(&path).unwrap();
        let document = base_document(vec![query_tab("tab1", "{}")], vec![entry("req1", "{}")]);
        assert_eq!(
            save(&mut database, 0, document.clone()).unwrap().revision,
            1
        );
        let stored = stored_row(&path);

        // A stale writer (or one that assumes an absent row) is refused as a conflict.
        for expected in [0, 2, 7] {
            assert_eq!(
                save(&mut database, expected, document.clone())
                    .unwrap_err()
                    .code,
                "workspaceConflict"
            );
        }
        assert_eq!(stored_row(&path), stored);
        // A revision outside the JS-safe range is invalid input, not a conflict.
        assert_eq!(
            save(&mut database, MAX_REVISION + 1, document.clone())
                .unwrap_err()
                .code,
            "invalidInput"
        );
        assert_eq!(stored_row(&path), stored);
        // The matching revision still applies.
        assert_eq!(save(&mut database, 1, document).unwrap().revision, 2);
    }

    #[test]
    fn corrupt_future_or_oversize_stored_rows_fail_closed_and_cannot_be_replaced() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("recovery.sqlite");
        let mut database = Database::open(&path).unwrap();
        let valid = base_document(Vec::new(), Vec::new());
        valid.validate().unwrap();

        for stored in [
            // A document written by a newer build.
            r#"{"version":2,"workspace":null,"history":[]}"#,
            // Unknown keys are never repaired away.
            r#"{"version":1,"workspace":null,"history":[],"extra":true}"#,
            r#"{"version":1,"workspace":{"cursor":"abc"},"history":[]}"#,
            r#"not json"#,
        ] {
            database
                .run_sql_for_test("DELETE FROM workspace_recovery")
                .unwrap();
            database
                .run_sql_for_test(&format!(
                    "INSERT INTO workspace_recovery(singleton,revision,json) VALUES (1,3,'{stored}')"
                ))
                .unwrap();
            assert_eq!(load(&database).unwrap_err().code, "invalidResponse");
            // Even a writer whose expected revision matches cannot replace the row.
            assert_eq!(
                save(&mut database, 3, valid.clone()).unwrap_err().code,
                "invalidResponse"
            );
            // And a conflicting writer still learns nothing about the stored bytes.
            assert_eq!(
                save(&mut database, 2, valid.clone()).unwrap_err().code,
                "invalidResponse"
            );
            let (revision, json) = stored_row(&path);
            assert_eq!(revision, 3);
            assert_eq!(json, stored);
        }

        // An oversize row fails at the schema-level read and is equally untouchable.
        database
            .run_sql_for_test("DELETE FROM workspace_recovery")
            .unwrap();
        database
            .run_sql_for_test(
                "PRAGMA ignore_check_constraints=ON;
                 INSERT INTO workspace_recovery(singleton,revision,json) VALUES (1,3,hex(zeroblob(4194817)));",
            )
            .unwrap();
        assert_eq!(load(&database).unwrap_err().code, "invalidResponse");
        assert_eq!(
            save(&mut database, 3, valid).unwrap_err().code,
            "invalidResponse"
        );
        let (revision, json) = stored_row(&path);
        assert_eq!(revision, 3);
        assert_eq!(json.len(), 8_389_634);
    }

    #[test]
    fn read_only_storage_reports_unavailable_and_keeps_the_document() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("recovery.sqlite");
        let mut database = Database::open(&path).unwrap();
        let document = base_document(Vec::new(), Vec::new());
        assert_eq!(
            save(&mut database, 0, document.clone()).unwrap().revision,
            1
        );
        database.run_sql_for_test("PRAGMA query_only=ON;").unwrap();

        assert_eq!(load(&database).unwrap().revision, 1);
        assert_eq!(
            save(&mut database, 1, document).unwrap_err().code,
            "storageUnavailable"
        );
        assert_eq!(stored_row(&path).0, 1);
    }

    #[test]
    fn unknown_result_or_transport_keys_are_refused_at_every_level() {
        let document = full_document();
        accepted(&encoded(&document), "the full document");

        let mut value = encoded(&document);
        value["cursor"] = serde_json::json!("abc");
        refused(&value, "root cursor");

        let mut value = encoded(&document);
        value["workspace"]["response"] = serde_json::json!("{}");
        refused(&value, "workspace response");

        let mut value = encoded(&document);
        value["workspace"]["tabs"][0]["pit"] = serde_json::json!("abc");
        refused(&value, "tab pit");

        let mut value = encoded(&document);
        value["workspace"]["tabs"][0]["document"]["response"] = serde_json::json!("{}");
        refused(&value, "document response");

        let mut value = encoded(&document);
        value["workspace"]["tabs"][0]["grid"]["pageIndex"] = serde_json::json!(0);
        refused(&value, "grid page index");

        let mut value = encoded(&document);
        value["workspace"]["tabs"][0]["grid"]["sorting"][0]["extra"] = serde_json::json!(1);
        refused(&value, "sorting extra");

        let mut value = encoded(&document);
        value["workspace"]["tabs"][0]["visualDraft"]["headers"] = serde_json::json!({});
        refused(&value, "draft headers");

        let mut value = encoded(&document);
        value["workspace"]["tabs"][0]["visualDraft"]["form"]["conditions"][0]["credentialRef"] =
            serde_json::json!("secret");
        refused(&value, "condition credential reference");

        let mut value = encoded(&document);
        value["workspace"]["tabs"][0]["visualDraft"]["form"]["conditions"][0]["original"]
            ["apiKey"] = serde_json::json!("secret");
        refused(&value, "original api key");

        let mut value = encoded(&document);
        value["workspace"]["tabs"][0]["visualDraft"]["problems"][0]["token"] = serde_json::json!(1);
        refused(&value, "problem extra");

        let mut value = encoded(&document);
        value["history"][0]["snapshot"]["headers"] = serde_json::json!({});
        refused(&value, "snapshot headers");

        let mut value = encoded(&document);
        value["history"][0]["cursor"] = serde_json::json!("abc");
        refused(&value, "history cursor");
    }

    #[test]
    fn missing_and_null_keys_follow_the_contract() {
        let document = full_document();

        // Required-but-nullable keys: an explicit null is fine, a missing key is not.
        let mut value = encoded(&document);
        value["workspace"]["activeTabId"] = serde_json::Value::Null;
        accepted(&value, "null active tab");
        for key in ["workspace", "version", "history"] {
            let mut value = encoded(&document);
            value.as_object_mut().unwrap().remove(key);
            refused(&value, key);
        }
        let mut value = encoded(&document);
        value.as_object_mut().unwrap().remove("workspace");
        value["workspace"] = serde_json::Value::Null;
        accepted(&value, "null workspace");

        let mut value = encoded(&document);
        value["history"][0]["finishedAt"] = serde_json::Value::Null;
        accepted(&value, "null finishedAt for a running entry");
        let mut value = encoded(&document);
        value["history"][0]
            .as_object_mut()
            .unwrap()
            .remove("errorCode");
        refused(&value, "missing errorCode");
        let mut value = encoded(&document);
        value["workspace"]["tabs"][0]
            .as_object_mut()
            .unwrap()
            .remove("visualDraft");
        refused(&value, "missing visualDraft");
        let mut value = encoded(&document);
        value["workspace"]["tabs"][0]["visualDraft"]["form"]
            .as_object_mut()
            .unwrap()
            .remove("sort");
        refused(&value, "missing form sort");

        // Optional keys may be omitted, never null.
        let mut value = encoded(&document);
        value["workspace"]["tabs"][0]["visualDraft"]["form"]["conditions"][0]
            .as_object_mut()
            .unwrap()
            .remove("original");
        accepted(&value, "omitted original");
        let mut value = encoded(&document);
        value["workspace"]["tabs"][0]["visualDraft"]["form"]["conditions"][0]["original"] =
            serde_json::Value::Null;
        refused(&value, "null original");

        let mut value = encoded(&document);
        value["workspace"]["tabs"][0]["visualDraft"]["problems"][0]
            .as_object_mut()
            .unwrap()
            .remove("conditionId");
        accepted(&value, "omitted condition id");
        let mut value = encoded(&document);
        value["workspace"]["tabs"][0]["visualDraft"]["problems"][0]["conditionId"] =
            serde_json::Value::Null;
        refused(&value, "null condition id");

        // The empty connection key of `lastTabByConnection` and a null value are both allowed.
        let mut value = encoded(&document);
        value["workspace"]["lastTabByConnection"] = serde_json::json!({ "": null });
        accepted(&value, "empty connection key");
        let mut value = encoded(&document);
        value["workspace"]["lastTabByConnection"] = serde_json::json!({ "tab1": "tab1" });
        refused(&value, "key without a matching tab");
    }

    #[test]
    fn index_tabs_require_a_bound_trimmed_unique_target() {
        let mut document = base_document(
            vec![index_tab("tab1", CONNECTION, "logs-2026.10.09")],
            Vec::new(),
        );
        document.validate().unwrap();

        document.workspace.0.as_mut().unwrap().tabs[0]
            .document
            .connection_id = Nullable(None);
        assert_eq!(document.validate().unwrap_err().code, "invalidInput");

        let mut document = base_document(
            vec![index_tab("tab1", CONNECTION, "logs-2026.10.09")],
            Vec::new(),
        );
        document.workspace.0.as_mut().unwrap().tabs[0]
            .document
            .index = "  ".to_owned();
        assert!(document.validate().is_err());

        let mut document = base_document(
            vec![index_tab("tab1", CONNECTION, "logs-2026.10.09")],
            Vec::new(),
        );
        document.workspace.0.as_mut().unwrap().tabs[0]
            .document
            .index = " logs ".to_owned();
        assert!(document.validate().is_err());

        let mut document = base_document(
            vec![index_tab("tab1", CONNECTION, "logs-2026.10.09")],
            Vec::new(),
        );
        document.workspace.0.as_mut().unwrap().tabs[0].editor_mode = EditorMode::Visual;
        assert!(document.validate().is_err());

        let mut document = base_document(
            vec![index_tab("tab1", CONNECTION, "logs-2026.10.09")],
            Vec::new(),
        );
        document.workspace.0.as_mut().unwrap().tabs[0].visual_draft =
            Nullable(Some(VisualEditorDraft {
                source: String::new(),
                form: Nullable(None),
                problems: Vec::new(),
            }));
        assert!(document.validate().is_err());

        // The same target on two index tabs is refused; a different connection or the same
        // target on a query tab is fine.
        let duplicate = base_document(
            vec![
                index_tab("tab1", CONNECTION, "logs-2026.10.09"),
                index_tab("tab2", CONNECTION, "logs-2026.10.09"),
            ],
            Vec::new(),
        );
        assert!(duplicate.validate().is_err());
        let distinct_connections = base_document(
            vec![
                index_tab("tab1", CONNECTION, "logs-2026.10.09"),
                index_tab("tab2", OTHER_CONNECTION, "logs-2026.10.09"),
            ],
            Vec::new(),
        );
        distinct_connections.validate().unwrap();

        // A query tab may keep a null connection and an empty index.
        let query = base_document(vec![query_tab("tab1", "")], Vec::new());
        query.validate().unwrap();
    }

    #[test]
    fn history_statuses_bound_timestamps_and_error_codes() {
        fn check(entry: ExecutionHistoryEntry) -> Result<(), AppError> {
            base_document(Vec::new(), vec![entry]).validate()
        }

        let running = entry("req1", "{}");
        check(running.clone()).unwrap();

        let mut wrong = running.clone();
        wrong.finished_at = Nullable(Some(LATER.to_owned()));
        assert!(check(wrong).is_err(), "running with finishedAt");

        let mut interrupted = running.clone();
        interrupted.status = HistoryStatus::Interrupted;
        check(interrupted.clone()).unwrap();
        let mut wrong = interrupted.clone();
        wrong.finished_at = Nullable(Some(LATER.to_owned()));
        assert!(check(wrong).is_err(), "interrupted with finishedAt");

        let mut success = running.clone();
        success.status = HistoryStatus::Success;
        success.finished_at = Nullable(Some(LATER.to_owned()));
        check(success.clone()).unwrap();
        let mut wrong = success.clone();
        wrong.error_code = Nullable(Some("timeout".to_owned()));
        assert!(check(wrong).is_err(), "success with an error code");

        let mut partial = success.clone();
        partial.status = HistoryStatus::Partial;
        check(partial.clone()).unwrap();
        partial.error_code = Nullable(Some("timeout".to_owned()));
        assert!(check(partial).is_err(), "partial with an error code");

        let mut failed = success.clone();
        failed.status = HistoryStatus::Failed;
        assert!(check(failed.clone()).is_err(), "failed without a code");
        failed.error_code = Nullable(Some("timeout".to_owned()));
        check(failed.clone()).unwrap();

        let mut cancelled = success.clone();
        cancelled.status = HistoryStatus::Cancelled;
        check(cancelled.clone()).unwrap();
        cancelled.error_code = Nullable(Some("shutdown".to_owned()));
        check(cancelled).unwrap();

        // A completion time can never precede the start, and weird codes are refused.
        let mut backwards = success.clone();
        backwards.finished_at = Nullable(Some("2026-10-09T09:59:59.000Z".to_owned()));
        assert!(check(backwards).is_err());
        let mut bad_code = failed.clone();
        bad_code.error_code = Nullable(Some("_notAValidCode".to_owned()));
        assert!(check(bad_code).is_err());
        let mut bad_code = failed;
        bad_code.error_code = Nullable(Some("bad code".to_owned()));
        assert!(check(bad_code).is_err());

        // Duplicate request IDs are refused across the history.
        let mut first = success.clone();
        first.snapshot.request_id = "same".to_owned();
        let mut second = success;
        second.snapshot.request_id = "same".to_owned();
        assert!(base_document(Vec::new(), vec![first, second])
            .validate()
            .is_err());
    }

    #[test]
    fn timestamps_are_canonical_utc_with_real_calendar_values() {
        for good in [
            "0000-01-01T00:00:00.000Z",
            "2000-02-29T23:59:59.999Z",
            "2024-02-29T00:00:00.000Z",
            "9999-12-31T23:59:59.999Z",
        ] {
            assert!(valid_timestamp(good), "{good}");
        }
        for bad in [
            "1900-02-29T00:00:00.000Z", // 1900 is not a leap year
            "2023-02-29T00:00:00.000Z",
            "2026-04-31T00:00:00.000Z",
            "2026-13-01T00:00:00.000Z",
            "2026-00-10T00:00:00.000Z",
            "2026-10-00T00:00:00.000Z",
            "2026-10-09T24:00:00.000Z",
            "2026-10-09T25:00:00.000Z",
            "2026-10-09T10:60:00.000Z",
            "2026-10-09T10:00:60.000Z",
            "2026-10-09T10:00:00.00Z",
            "2026-10-09T10:00:00.000+01:00",
            "2026-10-09 10:00:00.000Z",
            "2026-10-09T10:00:00.000z",
            "2026-10-09T10:00:00.000",
            "not a timestamp",
            "",
        ] {
            assert!(!valid_timestamp(bad), "{bad}");
        }
    }

    #[test]
    fn grid_columns_widths_and_sorting_are_bounded() {
        let with_grid = |grid: GridLayout| {
            base_document(
                vec![RecoveryTab {
                    grid,
                    ..query_tab("tab1", "")
                }],
                Vec::new(),
            )
            .validate()
        };

        with_grid(grid()).unwrap();

        let mut squeezed = grid();
        squeezed
            .column_sizing
            .insert("field:total".to_owned(), JsNumber(MIN_COLUMN_WIDTH - 0.5));
        assert!(with_grid(squeezed).is_err());

        let mut wide = grid();
        wide.column_sizing
            .insert("field:total".to_owned(), JsNumber(MAX_COLUMN_WIDTH + 0.5));
        assert!(with_grid(wide).is_err());

        let mut row = grid();
        row.column_sizing
            .insert("meta:row".to_owned(), JsNumber(ROW_COLUMN_WIDTH - 1.0));
        assert!(with_grid(row).is_err());

        let mut hidden = grid();
        hidden
            .column_visibility
            .insert("meta:row".to_owned(), false);
        assert!(with_grid(hidden).is_err());

        let mut unknown = grid();
        unknown.column_order.push("other:thing".to_owned());
        assert!(with_grid(unknown).is_err());

        let mut narrow_field = grid();
        narrow_field.column_order.push("field:".to_owned());
        assert!(with_grid(narrow_field).is_err());

        let mut controlled = grid();
        controlled.column_order.push("field:bad\u{7f}".to_owned());
        assert!(with_grid(controlled).is_err());

        let mut duplicated = grid();
        duplicated.column_order.push("field:total".to_owned());
        assert!(with_grid(duplicated).is_err());

        let mut oversized = grid();
        oversized.column_order = (0..=MAX_GRID_COLUMNS)
            .map(|index| format!("field:f{index}"))
            .collect();
        assert!(with_grid(oversized).is_err());

        let mut sorted = grid();
        sorted.sorting = (0..=MAX_GRID_SORTING)
            .map(|index| GridSort {
                id: format!("field:f{index}"),
                desc: false,
            })
            .collect();
        assert!(with_grid(sorted).is_err());

        let mut twice = grid();
        twice.sorting.push(GridSort {
            id: "field:total".to_owned(),
            desc: false,
        });
        assert!(with_grid(twice).is_err());
    }

    #[test]
    fn visual_forms_are_cross_checked_against_their_dsl() {
        let draft = |source: &str, form: Option<VisualForm>, problems: Vec<VisualBuildProblem>| {
            RecoveryTab {
                visual_draft: Nullable(Some(VisualEditorDraft {
                    source: source.to_owned(),
                    form: Nullable(form),
                    problems,
                })),
                ..query_tab("tab1", LARGE_DSL)
            }
        };
        base_document(
            vec![draft(
                LARGE_DSL,
                Some(visual_form()),
                vec![VisualBuildProblem {
                    code: ProblemCode::SizeOutOfRange,
                    condition_id: Some("cond1".to_owned()),
                }],
            )],
            Vec::new(),
        )
        .validate()
        .unwrap();

        // The draft must be the editor state of exactly this DSL.
        assert!(base_document(
            vec![draft("{}", Some(visual_form()), Vec::new())],
            Vec::new()
        )
        .validate()
        .is_err());

        // A form is optional, its own bounds still apply.
        base_document(vec![draft(LARGE_DSL, None, Vec::new())], Vec::new())
            .validate()
            .unwrap();

        let mut duplicate = visual_form();
        duplicate.conditions.push(duplicate.conditions[0].clone());
        assert!(base_document(
            vec![draft(LARGE_DSL, Some(duplicate), Vec::new())],
            Vec::new()
        )
        .validate()
        .is_err());

        let mut oversized = visual_form();
        oversized.conditions[0].value = "v".repeat(MAX_DSL_BYTES + 1);
        assert!(base_document(
            vec![draft(LARGE_DSL, Some(oversized), Vec::new())],
            Vec::new()
        )
        .validate()
        .is_err());

        let mut long_original = visual_form();
        long_original.conditions[0].original.as_mut().unwrap().raw = "r".repeat(MAX_DSL_BYTES + 1);
        assert!(base_document(
            vec![draft(LARGE_DSL, Some(long_original), Vec::new())],
            Vec::new()
        )
        .validate()
        .is_err());

        let mut long_size = visual_form();
        long_size.size = "s".repeat(MAX_FIELD_BYTES + 1);
        assert!(base_document(
            vec![draft(LARGE_DSL, Some(long_size), Vec::new())],
            Vec::new()
        )
        .validate()
        .is_err());

        let mut long_sort = visual_form();
        long_sort.sort.0 = Some(VisualSort {
            field: "f".repeat(MAX_FIELD_BYTES + 1),
            direction: SortDirection::Asc,
        });
        assert!(base_document(
            vec![draft(LARGE_DSL, Some(long_sort), Vec::new())],
            Vec::new()
        )
        .validate()
        .is_err());

        let mut many = visual_form();
        let template = many.conditions[0].clone();
        many.conditions = (0..=MAX_FORM_CONDITIONS)
            .map(|index| VisualCondition {
                id: format!("cond{index}"),
                ..template.clone()
            })
            .collect();
        assert!(
            base_document(vec![draft(LARGE_DSL, Some(many), Vec::new())], Vec::new())
                .validate()
                .is_err()
        );

        let many_problems = (0..=MAX_FORM_PROBLEMS)
            .map(|_| VisualBuildProblem {
                code: ProblemCode::FieldRequired,
                condition_id: None,
            })
            .collect();
        assert!(
            base_document(vec![draft(LARGE_DSL, None, many_problems)], Vec::new())
                .validate()
                .is_err()
        );

        let bad_row = vec![VisualBuildProblem {
            code: ProblemCode::FieldRequired,
            condition_id: Some("bad id!".to_owned()),
        }];
        assert!(
            base_document(vec![draft(LARGE_DSL, None, bad_row)], Vec::new())
                .validate()
                .is_err()
        );

        // A closed enum: an unknown operator or problem code never decodes.
        let mut value = encoded(&full_document());
        value["workspace"]["tabs"][0]["visualDraft"]["form"]["conditions"][0]["operator"] =
            serde_json::json!("contains");
        refused(&value, "unknown operator");
        let mut value = encoded(&full_document());
        value["workspace"]["tabs"][0]["visualDraft"]["problems"][0]["code"] =
            serde_json::json!("somethingElse");
        refused(&value, "unknown problem code");
        let mut value = encoded(&full_document());
        value["workspace"]["tabs"][0]["visualDraft"]["form"]["conditions"][0]["context"] =
            serde_json::json!("should");
        refused(&value, "unknown context");
    }

    #[test]
    fn counts_and_byte_bounds_are_enforced() {
        // 50 tabs pass; 51 are refused.
        let tab = |index: usize| query_tab(&format!("tab{index}"), "");
        assert!(
            base_document((0..MAX_WORKSPACE_TABS).map(tab).collect(), Vec::new())
                .validate()
                .is_ok()
        );
        assert!(
            base_document((0..=MAX_WORKSPACE_TABS).map(tab).collect(), Vec::new())
                .validate()
                .is_err()
        );

        // 100 history entries pass; 101 are refused.
        let history = |index: usize| entry(&format!("req{index}"), "{}");
        assert!(base_document(
            Vec::new(),
            (0..MAX_EXECUTION_HISTORY).map(history).collect()
        )
        .validate()
        .is_ok());
        assert!(base_document(
            Vec::new(),
            (0..=MAX_EXECUTION_HISTORY).map(history).collect()
        )
        .validate()
        .is_err());

        // One DSL body is bounded to 256 KiB; incomplete DSL is preserved, only its size matters.
        let maximum = "x".repeat(MAX_DSL_BYTES);
        base_document(vec![query_tab("tab1", &maximum)], Vec::new())
            .validate()
            .unwrap();
        assert!(
            base_document(vec![query_tab("tab1", &format!("{maximum}x"))], Vec::new())
                .validate()
                .is_err()
        );

        // Sixteen drafts at the per-DSL bound overflow the 4 MiB workspace bound.
        let tabs: Vec<_> = (0..16)
            .map(|index| query_tab(&format!("tab{index}"), &maximum))
            .collect();
        assert_eq!(
            base_document(tabs, Vec::new()).validate().unwrap_err().code,
            "invalidInput"
        );

        // One hundred history entries at 42 KiB each overflow the 4 MiB history bound.
        let dsl = "y".repeat(42 * 1024);
        let history: Vec<_> = (0..100)
            .map(|index| entry(&format!("req{index}"), &dsl))
            .collect();
        assert_eq!(
            base_document(Vec::new(), history)
                .validate()
                .unwrap_err()
                .code,
            "invalidInput"
        );

        // Index targets and names carry their own bounds.
        let mut long_index = query_tab("tab1", "");
        long_index.document.index = "i".repeat(MAX_INDEX_BYTES + 1);
        assert!(base_document(vec![long_index], Vec::new())
            .validate()
            .is_err());
        let mut long_name = query_tab("tab1", "");
        long_name.document.name = "n".repeat(MAX_NAME_CHARS + 1);
        assert!(base_document(vec![long_name], Vec::new())
            .validate()
            .is_err());
        let mut control_name = query_tab("tab1", "");
        control_name.document.name = "bad\u{9f}name".to_owned();
        assert!(base_document(vec![control_name], Vec::new())
            .validate()
            .is_err());

        // Revision counters stay within the JS-safe range.
        let mut revision = query_tab("tab1", "");
        revision.document.revision = MAX_REVISION;
        base_document(vec![revision.clone()], Vec::new())
            .validate()
            .unwrap();
        revision.document.revision = MAX_REVISION + 1;
        assert!(base_document(vec![revision], Vec::new())
            .validate()
            .is_err());

        // `lastTabByConnection` is bounded too, and its keys/values are checked.
        let mut workspace_document = base_document(Vec::new(), Vec::new());
        {
            let workspace = workspace_document.workspace.0.as_mut().unwrap();
            workspace.last_tab_by_connection = (0..MAX_LAST_TABS)
                .map(|index| (format!("c{index}"), Nullable(None)))
                .collect();
        }
        workspace_document.validate().unwrap();
        workspace_document
            .workspace
            .0
            .as_mut()
            .unwrap()
            .last_tab_by_connection
            .insert("extra".to_owned(), Nullable(None));
        assert!(workspace_document.validate().is_err());
        let mut bad_key = base_document(Vec::new(), Vec::new());
        bad_key
            .workspace
            .0
            .as_mut()
            .unwrap()
            .last_tab_by_connection
            .insert("not an id".to_owned(), Nullable(None));
        assert!(bad_key.validate().is_err());

        // A revision outside the JS-safe range never even decodes from JSON.
        let mut value = encoded(&full_document());
        value["history"][0]["snapshot"]["revision"] = serde_json::json!(9007199254740992u64);
        refused(&value, "unsafe snapshot revision");
        let mut value = encoded(&full_document());
        value["history"][0]["snapshot"]["revision"] = serde_json::json!(1.5);
        refused(&value, "fractional revision");
    }

    #[test]
    fn deleted_connection_targets_are_preserved_and_never_rebound() {
        let directory = tempdir().unwrap();
        let mut database = Database::open(&directory.path().join("recovery.sqlite")).unwrap();
        let connection = database
            .save_connection(
                ConnectionInput {
                    display_name: "Deleted".to_owned(),
                    endpoint: "https://legacy.test/es".to_owned(),
                    environment: "staging".to_owned(),
                },
                None,
            )
            .unwrap()
            .profile;

        let mut document = base_document(
            vec![query_tab("tab1", "{\"size\":0}")],
            vec![entry("req1", "{}")],
        );
        document.workspace.0.as_mut().unwrap().tabs[0]
            .document
            .connection_id = Nullable(Some(connection.id.clone()));
        document.history[0].snapshot.connection_id = connection.id.clone();
        save(&mut database, 0, document.clone()).unwrap();

        database
            .run_sql_for_test("DELETE FROM connections")
            .unwrap();

        // The stored document is untouched: no ID is resolved, rewritten or dropped because the
        // connection disappeared.
        let record = load(&database).unwrap();
        assert_eq!(record.document, document);
        assert!(database.connection_summaries().unwrap().is_empty());
        // And a later save still accepts the same stale target.
        assert_eq!(save(&mut database, 1, document).unwrap().revision, 2);
    }

    #[test]
    fn invalid_documents_never_replace_a_stored_one() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("recovery.sqlite");
        let mut database = Database::open(&path).unwrap();
        let good = base_document(vec![query_tab("tab1", "{}")], Vec::new());
        save(&mut database, 0, good.clone()).unwrap();
        let stored = stored_row(&path);

        let mut future = good.clone();
        future.version = WORKSPACE_RECOVERY_VERSION + 1;
        let mut duplicate = good.clone();
        duplicate
            .workspace
            .0
            .as_mut()
            .unwrap()
            .tabs
            .push(query_tab("tab1", "{}"));
        for document in [future, duplicate] {
            assert_eq!(
                save(&mut database, 1, document).unwrap_err().code,
                "invalidInput"
            );
        }
        assert_eq!(save(&mut database, 1, good).unwrap().revision, 2);
        assert_eq!(stored_row(&path).0, 2);
        assert_ne!(stored, stored_row(&path));
    }
}
