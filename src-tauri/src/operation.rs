use crate::error::AppError;

pub fn authorize(operation: &str) -> Result<(), AppError> {
    match operation {
        "connection.test" | "capability.read" | "query.execute" => Ok(()),
        _ => Err(AppError::new("permissionDenied")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unknown_and_write_operations_are_denied() {
        for operation in [
            "",
            "GET",
            "index.delete",
            "document.update",
            "query.execute/../delete",
        ] {
            assert_eq!(authorize(operation).unwrap_err().code, "permissionDenied");
        }
        assert!(authorize("query.execute").is_ok());
    }
}
