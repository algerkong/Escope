//! Explicit single-use model credentials. This is not a persistence or keyring fallback.

use crate::credentials::Secret;
use crate::error::AppError;
use reqwest::header::HeaderValue;
use serde::{Deserialize, Deserializer};
use zeroize::Zeroizing;

/// Reject bytes that cannot be carried by an HTTP header field or that would smuggle a second
/// header line. Shared by the single-use override and by secrets read back from the OS store.
pub(crate) fn validate_secret(secret: &Secret) -> Result<(), AppError> {
    if secret
        .expose_secret()
        .iter()
        .all(|byte| (0x21..=0x7e).contains(byte))
    {
        Ok(())
    } else {
        Err(AppError::new("invalidInput"))
    }
}

/// Build the one sensitive `Authorization` header value for a validated secret. The owned buffer
/// is zeroized after the header is built; the value is marked sensitive so no `Debug` output of a
/// header map can print it.
pub(crate) fn bearer_header(secret: &Secret) -> Result<HeaderValue, AppError> {
    let mut bytes = Zeroizing::new(Vec::with_capacity(7 + secret.len()));
    bytes.extend_from_slice(b"Bearer ");
    bytes.extend_from_slice(secret.expose_secret());
    let mut header = HeaderValue::from_bytes(&bytes).map_err(|_| AppError::new("invalidInput"))?;
    header.set_sensitive(true);
    Ok(header)
}

#[derive(Debug)]
pub(crate) struct OneShotApiKey(Secret);

impl OneShotApiKey {
    pub(crate) fn new(bytes: Vec<u8>) -> Result<Self, AppError> {
        let secret = Secret::new(bytes).map_err(AppError::from)?;
        validate_secret(&secret)?;
        Ok(Self(secret))
    }

    /// The wrapped secret, for the one call that writes it to the OS store. The value stays owned
    /// by this key and is never serialized.
    pub(crate) fn secret(&self) -> &Secret {
        &self.0
    }

    pub(crate) fn bearer_header(&self) -> Result<HeaderValue, AppError> {
        bearer_header(&self.0)
    }
}

impl<'de> Deserialize<'de> for OneShotApiKey {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = String::deserialize(deserializer)?;
        Self::new(value.into_bytes())
            .map_err(|_| serde::de::Error::custom("invalid single-use credential"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn one_shot_key_is_redacted_and_header_is_sensitive() {
        let key = OneShotApiKey::new(b"fixture-only-key".to_vec()).unwrap();
        assert!(!format!("{key:?}").contains("fixture-only-key"));
        let header = key.bearer_header().unwrap();
        assert!(header.is_sensitive());
        assert!(!format!("{header:?}").contains("fixture-only-key"));
    }

    #[test]
    fn single_use_credentials_reject_empty_oversized_and_header_injection() {
        for value in [
            vec![],
            vec![b'a'; 2049],
            b"has space".to_vec(),
            b"line\r\ninjection".to_vec(),
            vec![0xff],
        ] {
            assert!(OneShotApiKey::new(value).is_err());
        }
        assert!(OneShotApiKey::new(vec![b'a'; 2048]).is_ok());
        let result = serde_json::from_str::<OneShotApiKey>(r#""invalid key""#);
        let error = result.unwrap_err().to_string();
        assert!(!error.contains("invalid key"));
    }
}
