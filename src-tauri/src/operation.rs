use crate::error::AppError;
use crate::storage::ConnectionProfile;
use reqwest::{Client, Method, RequestBuilder};
use url::Url;

pub fn authorize(operation: &str) -> Result<(), AppError> {
    match operation {
        "connection.test" => Ok(()),
        _ => Err(AppError::new("permissionDenied")),
    }
}

pub struct IdentityRequest {
    url: Url,
}

impl IdentityRequest {
    pub fn build(&self, client: &Client) -> RequestBuilder {
        client.request(Method::GET, self.url.clone())
    }
}

pub fn identity_request(profile: &ConnectionProfile) -> Result<IdentityRequest, AppError> {
    authorize("connection.test")?;
    if profile.auth != "none" {
        return Err(AppError::new("unsupported"));
    }
    let mut url = Url::parse(&profile.endpoint).map_err(|_| AppError::new("invalidEndpoint"))?;
    if !["http", "https"].contains(&url.scheme())
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(AppError::new("invalidEndpoint"));
    }
    // Only the configured base path is permitted; callers cannot supply an API path or method.
    let path = format!("{}/", url.path().trim_end_matches('/'));
    url.set_path(&path);
    Ok(IdentityRequest { url })
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
            "query.execute",
            "capability.read",
        ] {
            assert_eq!(authorize(operation).unwrap_err().code, "permissionDenied");
        }
        assert!(authorize("connection.test").is_ok());
    }

    #[test]
    fn identity_plan_preserves_prefix_and_never_accepts_method_path_or_secrets() {
        let mut profile = ConnectionProfile {
            id: uuid::Uuid::new_v4().to_string(),
            display_name: "Fixture".into(),
            endpoint: "https://example.test/proxy/es".into(),
            environment: "development".into(),
            sort_order: 0,
            auth: "none",
        };
        let request = identity_request(&profile)
            .unwrap()
            .build(&Client::new())
            .build()
            .unwrap();
        assert_eq!(request.method(), Method::GET);
        assert_eq!(request.url().as_str(), "https://example.test/proxy/es/");
        assert!(request.body().is_none());
        for endpoint in [
            "file:///tmp/secret",
            "https://user:secret@example.test",
            "https://example.test/?token=secret",
            "https://example.test/#secret",
        ] {
            profile.endpoint = endpoint.into();
            assert!(identity_request(&profile).is_err());
        }
    }
}
