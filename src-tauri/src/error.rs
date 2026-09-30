use serde::Serialize;

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AppError {
    pub code: &'static str,
    pub request_id: Option<String>,
    pub retryable: bool,
}

impl AppError {
    pub fn new(code: &'static str) -> Self {
        Self {
            code,
            request_id: None,
            retryable: false,
        }
    }
}

impl From<rusqlite::Error> for AppError {
    fn from(_: rusqlite::Error) -> Self {
        Self::new("storageUnavailable")
    }
}
