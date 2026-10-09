//! A01 model configuration IPC: read, create/update, delete, select and cleanup.
//!
//! Profiles are configuration metadata plus a credential *reference*: the frontend submits a
//! display name, a wire protocol, an endpoint, a model id and a separate credential change
//! (keep / clear / replace), and reads back whether a key is configured — never the key and never
//! the reference. Metadata and credential changes commit in one SQLite transaction after the
//! keyring has been prepared and written, so a failure before the commit leaves neither a new
//! profile nor a lost old credential, and a failure after it never turns into a false save error.
//!
//! The commands are registered in `lib.rs`: `mod models;` plus `models_load`, `models_save`,
//! `models_delete`, `models_select` and `models_cleanup`. `StorageState` and `with_database` live
//! in the crate root and are visible to this child module. Production uses the OS credential
//! store; tests drive [`ModelCredentials`] with an injected store.

use crate::credentials::SystemCredentialStore;
use crate::error::AppError;
use crate::model_credentials::{ModelCredentialChange, ModelCredentials};
use crate::storage::{ModelInput, ModelProfile, ModelsState};
use crate::{with_database, StorageState};
use tauri::State;

/// Every stored profile, the resolved default selection and the credential cleanup flag. Reading
/// them in one call means the list, the default and the warning can never come from two different
/// database states.
#[tauri::command]
pub(crate) fn models_load(state: State<'_, StorageState>) -> Result<ModelsState, AppError> {
    with_database(&state, |db| db.models())
}

/// Create a profile (`id` absent) or update one (`id` present, keeping its identity and order),
/// applying the credential change in the same commit. An omitted `credential` means keep. The
/// payload denies unknown fields, so a request carrying a header or a URL is rejected instead of
/// being stored.
#[tauri::command]
pub(crate) fn models_save(
    state: State<'_, StorageState>,
    input: ModelInput,
    id: Option<String>,
    credential: Option<ModelCredentialChange>,
) -> Result<ModelProfile, AppError> {
    let store = SystemCredentialStore::new();
    with_database(&state, |db| {
        ModelCredentials::new(db, &store)
            .save(input, id, credential.unwrap_or_default())
            .map(|write| write.profile)
    })
}

/// Delete one profile; its metadata, the default repair and the queued credential reference
/// commit together.
#[tauri::command]
pub(crate) fn models_delete(state: State<'_, StorageState>, id: String) -> Result<(), AppError> {
    let store = SystemCredentialStore::new();
    with_database(&state, |db| {
        ModelCredentials::new(db, &store).delete(&id).map(|_| ())
    })
}

/// Remember which profile is the default; `null` clears the stored selection.
#[tauri::command]
pub(crate) fn models_select(
    state: State<'_, StorageState>,
    id: Option<String>,
) -> Result<(), AppError> {
    with_database(&state, |db| db.select_model(id))
}

/// Retry the bounded credential cleanup of the shared outbox. `true` means nothing is left
/// queued; `false` keeps the settings warning instead of claiming a clean state.
#[tauri::command]
pub(crate) fn models_cleanup(state: State<'_, StorageState>) -> Result<bool, AppError> {
    let store = SystemCredentialStore::new();
    with_database(&state, |db| ModelCredentials::new(db, &store).cleanup())
}
