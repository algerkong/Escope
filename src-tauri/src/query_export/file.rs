use super::{check_stop, AppError, Cancellation};
use serde::Serialize;
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Instant;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) enum FileState {
    None,
    Partial,
    Complete,
    Unknown,
}

#[derive(Clone, Debug)]
pub(super) struct FileInfo {
    pub name: Option<String>,
    pub rows: u64,
    pub bytes: u64,
    pub state: FileState,
}

impl FileInfo {
    pub fn none() -> Self {
        Self {
            name: None,
            rows: 0,
            bytes: 0,
            state: FileState::None,
        }
    }
}

struct PartialFile {
    file: Option<File>,
    target: PathBuf,
    partial: PathBuf,
    info: FileInfo,
}

/// Only this owned, create-new partial is ever written. No cleanup removes an unrelated path;
/// incomplete files intentionally remain discoverable after cancellation or process exit.
pub(super) struct ExportFile {
    inner: Arc<Mutex<PartialFile>>,
    fallback: FileInfo,
}

impl ExportFile {
    pub async fn create(target: &Path) -> Result<Self, AppError> {
        let target = target.to_path_buf();
        let partial = tauri::async_runtime::spawn_blocking(move || {
            let parent = target
                .parent()
                .ok_or_else(|| AppError::new("exportFailed"))?;
            let name = target
                .file_name()
                .and_then(|name| name.to_str())
                .ok_or_else(|| AppError::new("unsupported"))?;
            let name = format!("{name}.partial-{}", uuid::Uuid::new_v4());
            let path = parent.join(&name);
            let file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&path)
                .map_err(|_| AppError::new("exportFailed"))?;
            Ok::<_, AppError>(PartialFile {
                file: Some(file),
                target,
                partial: path,
                info: FileInfo {
                    name: Some(name),
                    rows: 0,
                    bytes: 0,
                    state: FileState::Partial,
                },
            })
        })
        .await
        .map_err(|_| AppError::new("exportFailed"))??;
        Ok(Self {
            fallback: partial.info.clone(),
            inner: Arc::new(Mutex::new(partial)),
        })
    }

    pub fn info(&self) -> FileInfo {
        self.inner
            .lock()
            .map(|file| file.info.clone())
            .unwrap_or_else(|_| {
                let mut info = self.fallback.clone();
                info.state = FileState::Unknown;
                info
            })
    }

    pub async fn write(
        &mut self,
        records: Vec<Vec<u8>>,
        count_rows: bool,
        max_bytes: u64,
        cancel: Cancellation,
        deadline: Instant,
    ) -> Result<(), AppError> {
        let inner = Arc::clone(&self.inner);
        let result = tauri::async_runtime::spawn_blocking(move || {
            let mut file = inner.lock().map_err(|_| AppError::new("exportFailed"))?;
            for record in records {
                check_stop(&cancel, deadline)?;
                if record.len() as u64 > max_bytes - file.info.bytes {
                    return Err(AppError::new("byteLimit"));
                }
                let mut written = 0;
                while written < record.len() {
                    let output = file
                        .file
                        .as_mut()
                        .ok_or_else(|| AppError::new("exportFailed"))?;
                    match output.write(&record[written..]) {
                        Ok(count) if count > 0 => {
                            written += count;
                            file.info.bytes += count as u64;
                        }
                        _ => {
                            file.info.state = FileState::Unknown;
                            return Err(AppError::new("exportFailed"));
                        }
                    }
                    if written < record.len() {
                        check_stop(&cancel, deadline)?;
                    }
                }
                if count_rows {
                    file.info.rows += 1;
                }
            }
            Ok(())
        })
        .await
        .map_err(|_| AppError::new("exportFailed"))?;
        self.fallback = self.info();
        result
    }

    pub async fn flush(&mut self) -> Result<(), AppError> {
        let inner = Arc::clone(&self.inner);
        let result = tauri::async_runtime::spawn_blocking(move || {
            let mut file = inner.lock().map_err(|_| AppError::new("exportFailed"))?;
            let output = file
                .file
                .as_mut()
                .ok_or_else(|| AppError::new("exportFailed"))?;
            let result = output.flush().and_then(|()| output.sync_all());
            if result.is_err() {
                file.info.state = FileState::Unknown;
                return Err(AppError::new("exportFailed"));
            }
            Ok(())
        })
        .await
        .map_err(|_| AppError::new("exportFailed"))?;
        self.fallback = self.info();
        result
    }

    pub async fn commit(
        &mut self,
        cancel: Cancellation,
        deadline: Instant,
    ) -> Result<(), AppError> {
        let inner = Arc::clone(&self.inner);
        let result = tauri::async_runtime::spawn_blocking(move || {
            let mut file = inner.lock().map_err(|_| AppError::new("exportFailed"))?;
            check_stop(&cancel, deadline)?;
            file.file.take();
            if fs::rename(&file.partial, &file.target).is_err() {
                file.info.state = FileState::Unknown;
                return Err(AppError::new("exportFailed"));
            }
            file.info.state = FileState::Complete;
            file.info.name = file
                .target
                .file_name()
                .and_then(|name| name.to_str())
                .map(str::to_owned);
            Ok(())
        })
        .await
        .map_err(|_| AppError::new("exportFailed"))?;
        self.fallback = self.info();
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::read_only::RequestRegistry;

    #[tokio::test]
    async fn write_failure_keeps_only_its_owned_partial_and_never_claims_saved() {
        let directory = tempfile::tempdir().unwrap();
        let target = directory.path().join("data.jsonl");
        fs::write(&target, b"original").unwrap();
        let mut file = ExportFile::create(&target).await.unwrap();
        {
            let mut owned = file.inner.lock().unwrap();
            owned.file = Some(File::open(&owned.partial).unwrap());
        }
        let error = file
            .write(
                vec![b"row\n".to_vec()],
                true,
                1024,
                Cancellation::never(),
                Instant::now() + Duration::from_secs(10),
            )
            .await
            .unwrap_err();
        assert_eq!(error.code, "exportFailed");
        assert_eq!(file.info().state, FileState::Unknown);
        assert_eq!(file.info().bytes, 0);
        assert_eq!(fs::read(&target).unwrap(), b"original");
        assert!(directory.path().join(file.info().name.unwrap()).exists());
    }

    #[tokio::test]
    async fn cancellation_after_flush_prevents_rename_and_retains_complete_partial_rows() {
        let directory = tempfile::tempdir().unwrap();
        let target = directory.path().join("data.jsonl");
        fs::write(&target, b"original").unwrap();
        let mut file = ExportFile::create(&target).await.unwrap();
        let deadline = Instant::now() + Duration::from_secs(10);
        file.write(
            vec![b"row\n".to_vec()],
            true,
            4,
            Cancellation::never(),
            deadline,
        )
        .await
        .unwrap();
        file.flush().await.unwrap();
        let registry = RequestRegistry::default();
        let mut guard = registry.register("job", "connection").unwrap();
        registry.cancel("job", "connection");
        assert_eq!(
            file.commit(guard.cancellation().clone(), deadline)
                .await
                .unwrap_err()
                .code,
            "cancelled"
        );
        let info = file.info();
        assert_eq!(info.state, FileState::Partial);
        assert_eq!((info.rows, info.bytes), (1, 4));
        assert_eq!(fs::read(&target).unwrap(), b"original");
        assert_eq!(
            fs::read(directory.path().join(info.name.unwrap())).unwrap(),
            b"row\n"
        );
    }

    use std::time::Duration;
}
