//! A01 model configuration IPC: read, create/update, delete and select model profiles.
//!
//! This module is configuration only. It stores a display name, the wire protocol, an endpoint and
//! the model id the user typed. It never resolves a credential, never sends a request and never
//! reports a connection state, so a saved profile must not be presented as a working model.
//!
//! Registration is owned by `lib.rs`: `mod models;` plus the four commands in
//! `generate_handler![..., models::models_load, models::models_save, models::models_delete,
//! models::models_select]`. `StorageState` and `with_database` live in the crate root and are
//! visible to child modules, so no visibility change is needed there.

use crate::error::AppError;
use crate::storage::{ModelInput, ModelProfile, ModelsState};
use crate::{with_database, StorageState};
use tauri::State;

/// Every stored profile plus the resolved default selection. Reading both in one call means the
/// list and the default can never come from two different database states.
#[tauri::command]
pub(crate) fn models_load(state: State<'_, StorageState>) -> Result<ModelsState, AppError> {
    with_database(&state, |db| db.models())
}

/// Create a profile (`id` absent) or update one (`id` present, keeping its identity and order).
/// The payload denies unknown fields, so a request carrying an API key or a header is rejected
/// instead of being stored.
#[tauri::command]
pub(crate) fn models_save(
    state: State<'_, StorageState>,
    input: ModelInput,
    id: Option<String>,
) -> Result<ModelProfile, AppError> {
    with_database(&state, |db| db.save_model(input, id))
}

#[tauri::command]
pub(crate) fn models_delete(state: State<'_, StorageState>, id: String) -> Result<(), AppError> {
    with_database(&state, |db| db.delete_model(&id))
}

/// Remember which profile is the default; `null` clears the stored selection.
#[tauri::command]
pub(crate) fn models_select(
    state: State<'_, StorageState>,
    id: Option<String>,
) -> Result<(), AppError> {
    with_database(&state, |db| db.select_model(id))
}
