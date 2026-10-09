//! Internal Elasticsearch authentication transport (C01.3).
//!
//! One connection's authentication is a single `Authorization` header derived from a bounded,
//! versioned payload stored in the OS credential store. This module defines that payload, the
//! exact wire encoding of the three supported schemes, and the trusted resolution from a
//! validated connection row to the header a request may carry.
//!
//! Contracts:
//! - The vault payload is `ESC` magic, format version, kind tag and length-prefixed UTF-8
//!   fields, in that order. A payload is only ever produced here and is re-validated field by
//!   field when it is read back, so corrupt bytes, a foreign payload, a wrong version or a kind
//!   that does not match the connection's recorded kind fail with a sanitized error.
//! - Basic stores the UTF-8 user id and password and sends `Basic base64(user:password)`; the
//!   user id must not contain `:`, so the pair is never ambiguous. API Key stores the
//!   *components* (`id` and secret), never a pre-encoded value, and sends `ApiKey
//!   base64(id:secret)` through the same maintained base64 implementation, so there is exactly
//!   one encoding step. Bearer stores the token itself.
//! - The reference is read only from the connection's own validated row, reached through the
//!   sealed [`TransportSnapshot`] that only the database can construct; no caller supplies a
//!   reference, a secret, a profile, an URL, a method or a header. A missing, unavailable or
//!   corrupt vault entry fails the request; it never degrades into an unauthenticated send.
//!
//! Out of scope: any credential-editing IPC, secret retrieval by the frontend, CA/proxy/mTLS
//! configuration and automatic retries.
//!
//! The transport keeps whatever scheme the validated endpoint uses, exactly like the
//! unauthenticated path. The unencrypted-HTTP warning is owned by the future credential UI task,
//! and no IPC command can bind a credential yet, so this module adds no public plaintext-auth
//! flow.

use crate::credentials::{CredentialError, CredentialRef, CredentialStore, Secret};
use crate::error::AppError;
use crate::operation;
use crate::storage::{AuthKind, TransportSnapshot};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use reqwest::header::HeaderValue;
use std::fmt;
use zeroize::Zeroizing;

/// Fixed prefix of every stored payload, so foreign or truncated vault bytes are rejected before
/// any field is interpreted.
const PAYLOAD_MAGIC: &[u8; 3] = b"ESC";
/// Payload format version. A payload written by a future build fails closed here.
const PAYLOAD_VERSION: u8 = 1;
/// Kind tags inside the payload. Each tag maps to exactly one [`AuthKind`].
const TAG_BASIC: u8 = 1;
const TAG_API_KEY: u8 = 2;
const TAG_BEARER: u8 = 3;

/// Upper bounds per field. The assembled payload is additionally bounded by
/// [`crate::credentials::MAX_SECRET_BYTES`], the OS store's own limit.
const MAX_USER_ID_BYTES: usize = 256;
const MAX_API_KEY_ID_BYTES: usize = 256;
const MAX_SECRET_MATERIAL_BYTES: usize = 1536;

/// Largest payload any kind can produce (the Basic/ApiKey field set). `encode` sizes its buffer
/// once to this bound, so the buffer never reallocates — and never copies without wiping — after
/// a secret field has been written into it.
const MAX_PAYLOAD_BYTES: usize =
    PAYLOAD_MAGIC.len() + 2 + 2 + MAX_USER_ID_BYTES + 2 + MAX_SECRET_MATERIAL_BYTES;

/// Validated authentication material for one connection.
///
/// The constructors are the only way to build a value: they enforce the closed character set and
/// the bounds of every field. The inner representation is private, so no caller can assemble
/// material this module would refuse to encode or send. Every owned field — including the user
/// ID and the API Key ID, which are part of the stored secret payload — zeroizes on drop, and
/// the type is deliberately not `Clone` or `Serialize`.
pub struct EsAuthMaterial(EsAuthMaterialInner);

enum EsAuthMaterialInner {
    Basic {
        user_id: Zeroizing<String>,
        password: Zeroizing<Vec<u8>>,
    },
    ApiKey {
        id: Zeroizing<String>,
        key: Zeroizing<Vec<u8>>,
    },
    Bearer {
        token: Zeroizing<Vec<u8>>,
    },
}

impl EsAuthMaterial {
    /// Basic credentials: UTF-8 user id and password. The user id must not contain `:` (RFC
    /// 7617) and neither field may contain ASCII control bytes, so a malformed value is refused
    /// instead of being carried into a request.
    pub fn basic(user_id: &str, password: &str) -> Result<Self, AppError> {
        validate_control_free(user_id, MAX_USER_ID_BYTES)?;
        if user_id.contains(':') {
            return Err(AppError::new("invalidInput"));
        }
        validate_control_free(password, MAX_SECRET_MATERIAL_BYTES)?;
        Ok(Self(EsAuthMaterialInner::Basic {
            user_id: Zeroizing::new(user_id.to_owned()),
            password: Zeroizing::new(password.as_bytes().to_vec()),
        }))
    }

    /// API Key components. The value stored and sent is `id:key`, encoded once by
    /// [`EsAuthMaterial::authorization_header`]; an already encoded blob is not accepted as a
    /// substitute for the two components.
    pub fn api_key(id: &str, key: &str) -> Result<Self, AppError> {
        validate_header_material(id, MAX_API_KEY_ID_BYTES)?;
        validate_header_material(key, MAX_SECRET_MATERIAL_BYTES)?;
        if id.contains(':') || key.contains(':') {
            return Err(AppError::new("invalidInput"));
        }
        Ok(Self(EsAuthMaterialInner::ApiKey {
            id: Zeroizing::new(id.to_owned()),
            key: Zeroizing::new(key.as_bytes().to_vec()),
        }))
    }

    /// A bearer token. The token is sent verbatim after `Bearer `, so it is restricted to
    /// printable ASCII: anything else could not be carried by a header field faithfully.
    pub fn bearer(token: &str) -> Result<Self, AppError> {
        validate_header_material(token, MAX_SECRET_MATERIAL_BYTES)?;
        Ok(Self(EsAuthMaterialInner::Bearer {
            token: Zeroizing::new(token.as_bytes().to_vec()),
        }))
    }

    pub const fn kind(&self) -> AuthKind {
        match self.0 {
            EsAuthMaterialInner::Basic { .. } => AuthKind::Basic,
            EsAuthMaterialInner::ApiKey { .. } => AuthKind::ApiKey,
            EsAuthMaterialInner::Bearer { .. } => AuthKind::Bearer,
        }
    }

    /// Encode this material into the versioned vault payload. The OS store holds only this
    /// encoding; [`EsAuthMaterial::decode`] re-checks every field when it is read back.
    pub fn encode(&self) -> Result<Secret, AppError> {
        // Sized to the maximum payload up front: the buffer never grows after a secret field has
        // been written, so no intermediate allocation can be freed without being wiped.
        let mut payload = Zeroizing::new(Vec::with_capacity(MAX_PAYLOAD_BYTES));
        payload.extend_from_slice(PAYLOAD_MAGIC);
        payload.push(PAYLOAD_VERSION);
        match &self.0 {
            EsAuthMaterialInner::Basic { user_id, password } => {
                payload.push(TAG_BASIC);
                push_field(&mut payload, user_id.as_bytes(), MAX_USER_ID_BYTES)?;
                push_field(&mut payload, password, MAX_SECRET_MATERIAL_BYTES)?;
            }
            EsAuthMaterialInner::ApiKey { id, key } => {
                payload.push(TAG_API_KEY);
                push_field(&mut payload, id.as_bytes(), MAX_API_KEY_ID_BYTES)?;
                push_field(&mut payload, key, MAX_SECRET_MATERIAL_BYTES)?;
            }
            EsAuthMaterialInner::Bearer { token } => {
                payload.push(TAG_BEARER);
                push_field(&mut payload, token, MAX_SECRET_MATERIAL_BYTES)?;
            }
        }
        // The copy is owned by `Secret` and zeroized with it; the scratch buffer above is
        // zeroized when it drops. An oversized payload is rejected, never truncated.
        Secret::new(payload.to_vec()).map_err(|_| AppError::new("invalidInput"))
    }

    /// The single sensitive `Authorization` header this material authenticates with.
    ///
    /// Basic and API Key encode exactly once through the maintained base64 implementation:
    /// `Basic base64(user:password)` and `ApiKey base64(id:secret)`. Every buffer is sized before
    /// a sensitive byte is written and never grows afterwards, and the composed input and its
    /// encoding zeroize; the resulting header value is marked sensitive so no `Debug` output of a
    /// header map can print it.
    pub fn authorization_header(&self) -> Result<HeaderValue, AppError> {
        match &self.0 {
            EsAuthMaterialInner::Basic { user_id, password } => {
                let mut raw =
                    Zeroizing::new(Vec::with_capacity(user_id.len() + 1 + password.len()));
                raw.extend_from_slice(user_id.as_bytes());
                raw.push(b':');
                raw.extend_from_slice(password);
                let encoded = Zeroizing::new(BASE64.encode(raw.as_slice()));
                finish_header(b"Basic ", encoded.as_bytes())
            }
            EsAuthMaterialInner::ApiKey { id, key } => {
                let mut raw = Zeroizing::new(Vec::with_capacity(id.len() + 1 + key.len()));
                raw.extend_from_slice(id.as_bytes());
                raw.push(b':');
                raw.extend_from_slice(key);
                let encoded = Zeroizing::new(BASE64.encode(raw.as_slice()));
                finish_header(b"ApiKey ", encoded.as_bytes())
            }
            EsAuthMaterialInner::Bearer { token } => finish_header(b"Bearer ", token),
        }
    }

    /// Decode a payload read back from the vault and require its kind to match the kind recorded
    /// for the connection. Anything malformed — wrong magic or version, unknown kind tag, a field
    /// that does not fit, leftover bytes, invalid UTF-8, or a value the constructors would refuse
    /// — fails with a sanitized `credentialFailure` and no byte of the payload is echoed.
    fn decode(secret: &Secret, expected: AuthKind) -> Result<Self, AppError> {
        let expected_tag = match expected {
            AuthKind::Basic => TAG_BASIC,
            AuthKind::ApiKey => TAG_API_KEY,
            AuthKind::Bearer => TAG_BEARER,
            // A connection with no kind must never carry a payload.
            AuthKind::None => return Err(corrupt()),
        };
        let mut cursor = PayloadCursor::new(secret.expose_secret());
        if cursor.take(PAYLOAD_MAGIC.len())? != PAYLOAD_MAGIC || cursor.byte()? != PAYLOAD_VERSION {
            return Err(corrupt());
        }
        if cursor.byte()? != expected_tag {
            return Err(corrupt());
        }
        let material = match expected_tag {
            TAG_BASIC => {
                let user_id = utf8(cursor.field()?)?;
                let password = utf8(cursor.field()?)?;
                Self::basic(user_id, password).map_err(|_| corrupt())?
            }
            TAG_API_KEY => {
                let id = utf8(cursor.field()?)?;
                let key = utf8(cursor.field()?)?;
                Self::api_key(id, key).map_err(|_| corrupt())?
            }
            TAG_BEARER => Self::bearer(utf8(cursor.field()?)?).map_err(|_| corrupt())?,
            _ => return Err(corrupt()),
        };
        if cursor.remaining() != 0 {
            return Err(corrupt());
        }
        Ok(material)
    }
}

impl fmt::Debug for EsAuthMaterial {
    /// The kind is safe to print; every field is part of the stored secret material and is not.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "EsAuthMaterial({:?}, [REDACTED])", self.kind())
    }
}

/// Authentication resolved for one validated connection snapshot: the connection identity, the
/// normalized endpoint the credential was captured for, and the single header a plan for that
/// connection may carry. An unauthenticated row resolves to no header at all, without touching
/// the credential store.
///
/// Fields are private to this module and there is no production constructor: the only way to
/// obtain one is [`resolve`] over a [`TransportSnapshot`]. Callers get narrow read operations
/// for [`crate::operation::RequestPlan::authenticate`], so neither the header nor its binding
/// can be replaced independently or minted from raw parts.
pub struct ResolvedAuth {
    connection_id: String,
    /// Normalized endpoint (scheme, host, port and base path, with a trailing slash). A plan for
    /// a different endpoint refuses this resolution, so a changed endpoint cannot reuse the old
    /// secret.
    endpoint: String,
    kind: AuthKind,
    /// The reference the header was read through, for the plan's kind/reference binding check.
    reference: Option<CredentialRef>,
    header: Option<HeaderValue>,
}

impl ResolvedAuth {
    pub(crate) fn connection_id(&self) -> &str {
        &self.connection_id
    }

    pub(crate) fn endpoint(&self) -> &str {
        &self.endpoint
    }

    pub(crate) fn kind(&self) -> AuthKind {
        self.kind
    }

    pub(crate) fn reference(&self) -> Option<&CredentialRef> {
        self.reference.as_ref()
    }

    pub(crate) fn header(&self) -> Option<&HeaderValue> {
        self.header.as_ref()
    }
}

impl fmt::Debug for ResolvedAuth {
    /// Never prints the header or the credential reference.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ResolvedAuth")
            .field("connection_id", &self.connection_id)
            .field("endpoint", &self.endpoint)
            .field("kind", &self.kind)
            .field(
                "header",
                &self.header.as_ref().map(|_| "[REDACTED]").unwrap_or("none"),
            )
            .finish_non_exhaustive()
    }
}

/// Resolve the stored credential for one validated transport snapshot.
///
/// The reference is read only from the snapshot's own row; no caller supplies a reference, a
/// secret or a profile. An unauthenticated row resolves without touching the store. Every other
/// row must yield a payload whose kind matches the recorded kind, otherwise the request is
/// refused: a missing, unavailable or corrupt entry never degrades into an unauthenticated send.
pub fn resolve(
    snapshot: &TransportSnapshot,
    store: &dyn CredentialStore,
) -> Result<ResolvedAuth, AppError> {
    let profile = snapshot.profile();
    let endpoint = operation::base_url(profile)?.as_str().to_owned();
    match (profile.auth_state.kind, &profile.auth_state.credential_ref) {
        (AuthKind::None, None) => Ok(ResolvedAuth {
            connection_id: profile.id.clone(),
            endpoint,
            kind: AuthKind::None,
            reference: None,
            header: None,
        }),
        (kind, Some(reference)) if kind != AuthKind::None => {
            let secret = store.get(reference).map_err(stored_secret_error)?;
            let material = EsAuthMaterial::decode(&secret, kind)?;
            let header = material
                .authorization_header()
                .map_err(|_| AppError::new("credentialFailure"))?;
            Ok(ResolvedAuth {
                connection_id: profile.id.clone(),
                endpoint,
                kind,
                reference: Some(reference.clone()),
                header: Some(header),
            })
        }
        // A half-populated state cannot be produced by the database, and a hand-built one must
        // never be sent: neither "no secret" nor "secret without a kind" is authenticated.
        _ => Err(AppError::new("unsupported")),
    }
}

/// Map a vault read failure to the shared sanitized credential codes (the frontend catalog's
/// `credentialNotFound`/`credentialUnavailable`/`credentialFailure`). A missing or unavailable
/// entry is never turned into an unauthenticated request, and the OS/keyring detail is dropped.
fn stored_secret_error(error: CredentialError) -> AppError {
    AppError::new(match error {
        CredentialError::NotFound => "credentialNotFound",
        CredentialError::Unavailable => "credentialUnavailable",
        CredentialError::StorageFailure => "credentialFailure",
        CredentialError::InvalidSecret | CredentialError::InvalidReference => "credentialFailure",
    })
}

/// Sanitized failure for a payload that cannot be trusted. The payload bytes are never echoed.
fn corrupt() -> AppError {
    AppError::new("credentialFailure")
}

/// Assemble the sensitive header value from one exactly sized buffer: the prefix and the encoded
/// (or verbatim) credential are written once, so this buffer never reallocates after it holds
/// credential bytes.
fn finish_header(prefix: &[u8], body: &[u8]) -> Result<HeaderValue, AppError> {
    let mut wire = Zeroizing::new(Vec::with_capacity(prefix.len() + body.len()));
    wire.extend_from_slice(prefix);
    wire.extend_from_slice(body);
    let mut header =
        HeaderValue::from_bytes(wire.as_slice()).map_err(|_| AppError::new("invalidInput"))?;
    header.set_sensitive(true);
    Ok(header)
}

/// Every field must be present, non-empty and inside its bound.
fn push_field(payload: &mut Vec<u8>, value: &[u8], max: usize) -> Result<(), AppError> {
    if value.is_empty() || value.len() > max {
        return Err(AppError::new("invalidInput"));
    }
    payload.extend_from_slice(&(value.len() as u16).to_be_bytes());
    payload.extend_from_slice(value);
    Ok(())
}

/// A UTF-8 field: no control byte, a bounded size and at least one character.
fn validate_control_free(value: &str, max: usize) -> Result<(), AppError> {
    if value.is_empty()
        || value.len() > max
        || value.bytes().any(|byte| byte < 0x20 || byte == 0x7f)
    {
        return Err(AppError::new("invalidInput"));
    }
    Ok(())
}

/// A field sent verbatim inside the header (API Key components, bearer token): printable ASCII
/// only, so it cannot smuggle a second header line or anything the field cannot carry.
fn validate_header_material(value: &str, max: usize) -> Result<(), AppError> {
    if value.is_empty()
        || value.len() > max
        || !value.bytes().all(|byte| (0x21..=0x7e).contains(&byte))
    {
        return Err(AppError::new("invalidInput"));
    }
    Ok(())
}

fn utf8(bytes: &[u8]) -> Result<&str, AppError> {
    std::str::from_utf8(bytes).map_err(|_| corrupt())
}

/// Bounded reader over one payload. Every accessor fails closed: a field that would run past the
/// end of the payload is `credentialFailure`, never a truncated value.
struct PayloadCursor<'a> {
    bytes: &'a [u8],
    at: usize,
}

impl<'a> PayloadCursor<'a> {
    fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, at: 0 }
    }

    fn take(&mut self, length: usize) -> Result<&'a [u8], AppError> {
        let end = self.at.checked_add(length).ok_or_else(corrupt)?;
        let slice = self.bytes.get(self.at..end).ok_or_else(corrupt)?;
        self.at = end;
        Ok(slice)
    }

    fn byte(&mut self) -> Result<u8, AppError> {
        Ok(self.take(1)?[0])
    }

    fn field(&mut self) -> Result<&'a [u8], AppError> {
        let length = u16::from_be_bytes([self.byte()?, self.byte()?]) as usize;
        if length == 0 {
            return Err(corrupt());
        }
        self.take(length)
    }

    fn remaining(&self) -> usize {
        self.bytes.len() - self.at
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::connection_credentials::ConnectionCredentials;
    use crate::credentials::CredentialError;
    use crate::operation::{search_request, IndexTarget};
    use crate::storage::{ConnectionAuth, ConnectionInput, ConnectionProfile, Database};
    use std::collections::HashMap;
    use std::sync::Mutex;

    /// Resolve through the sealed snapshot path. Tests may use the crate-visible test snapshot
    /// constructor; production code can only obtain a snapshot from `Database::transport_snapshot`.
    fn resolve_for_test(
        profile: &ConnectionProfile,
        store: &FakeStore,
    ) -> Result<ResolvedAuth, AppError> {
        resolve(&TransportSnapshot::for_test(profile.clone()), store)
    }

    const BASIC_ENCODED: &str = "YWxhZGRpbjpvcGVuc2VzYW1l";
    const API_KEY_ID: &str = "VuaCfGcBCdbkQm-e5aOx";
    const API_KEY_SECRET: &str = "ui2lp2axTNmsyakw9tvNnw";
    /// `base64("<id>:<secret>")` as the Elasticsearch API documents the encoded API key. This is
    /// the exact value one encoding step must produce.
    const API_KEY_ENCODED: &str = "VnVhQ2ZHY0JDZGJrUW0tZTVhT3g6dWkybHAyYXhUTm1zeWFrdzl0dk5udw==";

    /// Test-only store: in-memory entries and an event log, never a real keyring and never a
    /// production fallback.
    #[derive(Default)]
    struct FakeStore {
        entries: Mutex<HashMap<String, Vec<u8>>>,
        events: Mutex<Vec<String>>,
        fail_get: Mutex<Option<CredentialError>>,
    }

    impl FakeStore {
        fn put(&self, reference: &CredentialRef, secret: &Secret) {
            self.entries.lock().unwrap().insert(
                reference.as_str().to_owned(),
                secret.expose_secret().to_vec(),
            );
        }

        fn fail_get(&self, fault: Option<CredentialError>) {
            *self.fail_get.lock().unwrap() = fault;
        }

        fn get_events(&self) -> Vec<String> {
            self.events
                .lock()
                .unwrap()
                .iter()
                .filter(|event| event.starts_with("get:"))
                .cloned()
                .collect()
        }
    }

    impl CredentialStore for FakeStore {
        fn set(&self, reference: &CredentialRef, secret: &Secret) -> Result<(), CredentialError> {
            self.events
                .lock()
                .unwrap()
                .push(format!("set:{}", reference.as_str()));
            self.put(reference, secret);
            Ok(())
        }

        fn get(&self, reference: &CredentialRef) -> Result<Secret, CredentialError> {
            self.events
                .lock()
                .unwrap()
                .push(format!("get:{}", reference.as_str()));
            if let Some(fault) = *self.fail_get.lock().unwrap() {
                return Err(fault);
            }
            let entries = self.entries.lock().unwrap();
            Secret::new(
                entries
                    .get(reference.as_str())
                    .ok_or(CredentialError::NotFound)?
                    .clone(),
            )
        }

        fn delete(&self, _reference: &CredentialRef) -> Result<(), CredentialError> {
            Ok(())
        }
    }

    fn bound(material: &EsAuthMaterial) -> (ConnectionProfile, FakeStore, CredentialRef) {
        let reference = CredentialRef::generate();
        let store = FakeStore::default();
        store.put(&reference, &material.encode().unwrap());
        let profile = ConnectionProfile {
            id: uuid::Uuid::new_v4().to_string(),
            display_name: "Fixture".into(),
            endpoint: "https://example.test/proxy/es".into(),
            environment: "development".into(),
            sort_order: 0,
            auth: "none",
            auth_state: crate::storage::ConnectionAuth {
                kind: material.kind(),
                credential_ref: Some(reference.clone()),
            },
        };
        (profile, store, reference)
    }

    fn payload(bytes: Vec<u8>) -> Secret {
        Secret::new(bytes).unwrap()
    }

    #[test]
    fn payload_round_trips_every_kind_with_the_exact_bytes() {
        let basic = EsAuthMaterial::basic("aladdin", "opensesame").unwrap();
        let encoded = basic.encode().unwrap();
        // `ESC`, version 1, basic tag, `u16` lengths and the UTF-8 fields, exactly.
        let mut expected = Vec::new();
        expected.extend_from_slice(b"ESC");
        expected.extend_from_slice(&[1, TAG_BASIC]);
        expected.extend_from_slice(&7u16.to_be_bytes());
        expected.extend_from_slice(b"aladdin");
        expected.extend_from_slice(&10u16.to_be_bytes());
        expected.extend_from_slice(b"opensesame");
        assert_eq!(encoded.expose_secret(), expected.as_slice());

        for material in [
            basic,
            EsAuthMaterial::api_key(API_KEY_ID, API_KEY_SECRET).unwrap(),
            EsAuthMaterial::bearer("fixture-bearer-token").unwrap(),
        ] {
            let decoded =
                EsAuthMaterial::decode(&material.encode().unwrap(), material.kind()).unwrap();
            assert_eq!(decoded.kind(), material.kind());
            assert_eq!(
                decoded.authorization_header().unwrap(),
                material.authorization_header().unwrap(),
                "{:?}",
                material.kind()
            );
        }
    }

    #[test]
    fn basic_header_is_utf8_base64_and_the_user_id_cannot_contain_a_colon() {
        let header = EsAuthMaterial::basic("aladdin", "opensesame")
            .unwrap()
            .authorization_header()
            .unwrap();
        assert_eq!(header.to_str().unwrap(), format!("Basic {BASIC_ENCODED}"));
        assert!(header.is_sensitive());
        // UTF-8 round trip: base64 over the UTF-8 bytes of both fields.
        assert_eq!(
            EsAuthMaterial::basic("user", "中文")
                .unwrap()
                .authorization_header()
                .unwrap()
                .to_str()
                .unwrap(),
            "Basic dXNlcjrkuK3mloc="
        );
        for (user_id, password) in [
            ("us:er", "password"),
            ("user", ""),
            ("", "password"),
            ("user\r\nname", "password"),
            ("user", "pass\r\nword"),
            ("user", "pass\0word"),
        ] {
            assert_eq!(
                EsAuthMaterial::basic(user_id, password).err().unwrap().code,
                "invalidInput",
                "{user_id:?}/{password:?}"
            );
        }
        assert!(EsAuthMaterial::basic(&"u".repeat(MAX_USER_ID_BYTES), "p").is_ok());
        assert!(EsAuthMaterial::basic(&"u".repeat(MAX_USER_ID_BYTES + 1), "p").is_err());
    }

    #[test]
    fn api_key_stores_components_and_encodes_exactly_once() {
        let header = EsAuthMaterial::api_key(API_KEY_ID, API_KEY_SECRET)
            .unwrap()
            .authorization_header()
            .unwrap();
        assert_eq!(
            header.to_str().unwrap(),
            format!("ApiKey {API_KEY_ENCODED}")
        );
        assert!(header.is_sensitive());
        // Explicitly not a second encoding of the already-encoded value: the stored payload holds
        // components, so `encode` is the only base64 step.
        let double = BASE64.encode(BASE64.encode(format!("{API_KEY_ID}:{API_KEY_SECRET}")));
        assert_ne!(header.to_str().unwrap(), format!("ApiKey {double}"));
        for (id, key) in [
            ("id:extra", "key"),
            ("id", "key:extra"),
            ("id", ""),
            ("", "key"),
            ("id", "key with space"),
            ("id", "key\ninjection"),
        ] {
            assert_eq!(
                EsAuthMaterial::api_key(id, key).err().unwrap().code,
                "invalidInput",
                "{id:?}/{key:?}"
            );
        }
    }

    #[test]
    fn bearer_sends_the_token_verbatim_and_header_material_rejects_injection() {
        let header = EsAuthMaterial::bearer("fixture-token")
            .unwrap()
            .authorization_header()
            .unwrap();
        assert_eq!(header.to_str().unwrap(), "Bearer fixture-token");
        assert!(header.is_sensitive());
        for token in [
            "",
            "token with space",
            "token\r\nX-Injected: 1",
            "token\u{7f}",
            "tökén",
            &"t".repeat(MAX_SECRET_MATERIAL_BYTES + 1),
        ] {
            assert_eq!(
                EsAuthMaterial::bearer(token).err().unwrap().code,
                "invalidInput",
                "{token:?}"
            );
        }
    }

    #[test]
    fn decode_refuses_wrong_version_kind_and_every_corrupt_shape() {
        let basic = EsAuthMaterial::basic("aladdin", "opensesame")
            .unwrap()
            .encode()
            .unwrap();
        assert_eq!(
            EsAuthMaterial::decode(&basic, AuthKind::ApiKey)
                .err()
                .unwrap()
                .code,
            "credentialFailure"
        );
        assert_eq!(
            EsAuthMaterial::decode(&basic, AuthKind::None)
                .err()
                .unwrap()
                .code,
            "credentialFailure"
        );

        let mut wrong_version = b"ESC".to_vec();
        wrong_version.extend_from_slice(&[PAYLOAD_VERSION + 1, TAG_BASIC]);
        let mut unknown_tag = b"ESC".to_vec();
        unknown_tag.extend_from_slice(&[PAYLOAD_VERSION, 9]);
        let mut empty_field = b"ESC".to_vec();
        empty_field.extend_from_slice(&[PAYLOAD_VERSION, TAG_BEARER, 0, 0]);
        let mut truncated = b"ESC".to_vec();
        truncated.extend_from_slice(&[PAYLOAD_VERSION, TAG_BEARER, 0, 8, b'a']);
        let mut trailing = b"ESC".to_vec();
        trailing.extend_from_slice(&[PAYLOAD_VERSION, TAG_BEARER, 0, 1, b'x', b'!']);
        let mut invalid_utf8 = b"ESC".to_vec();
        invalid_utf8.extend_from_slice(&[PAYLOAD_VERSION, TAG_BEARER, 0, 2, 0xff, 0xfe]);
        // Structurally valid but a value the constructor would refuse.
        let mut invalid_value = b"ESC".to_vec();
        invalid_value.extend_from_slice(&[PAYLOAD_VERSION, TAG_BEARER, 0, 2]);
        invalid_value.extend_from_slice(b"a b");
        for corrupt_payload in [
            payload(vec![0]),
            payload(b"ES".to_vec()),
            payload(b"XXX\x01\x01".to_vec()),
            payload(wrong_version),
            payload(unknown_tag),
            payload(empty_field),
            payload(truncated),
            payload(trailing),
            payload(invalid_utf8),
            payload(invalid_value),
        ] {
            let error = EsAuthMaterial::decode(&corrupt_payload, AuthKind::Bearer)
                .err()
                .unwrap();
            assert_eq!(error.code, "credentialFailure");
            assert!(!format!("{error:?}").contains("ESC"));
        }
    }

    #[test]
    fn resolve_reads_only_the_trusted_reference_and_never_touches_the_store_for_none() {
        let store = FakeStore::default();
        let profile = ConnectionProfile {
            id: uuid::Uuid::new_v4().to_string(),
            display_name: "Fixture".into(),
            endpoint: "https://example.test/proxy/es".into(),
            environment: "development".into(),
            sort_order: 0,
            auth: "none",
            auth_state: crate::storage::ConnectionAuth::none(),
        };
        let auth = resolve_for_test(&profile, &store).unwrap();
        assert!(auth.header.is_none());
        assert_eq!(auth.kind, AuthKind::None);
        assert_eq!(auth.endpoint, "https://example.test/proxy/es/");
        assert!(store.get_events().is_empty());

        // States the database cannot produce still fail closed instead of planning a request.
        for state in [
            crate::storage::ConnectionAuth {
                kind: AuthKind::None,
                credential_ref: Some(CredentialRef::generate()),
            },
            crate::storage::ConnectionAuth {
                kind: AuthKind::Basic,
                credential_ref: None,
            },
        ] {
            let hand_built = ConnectionProfile {
                auth_state: state,
                ..profile.clone()
            };
            assert_eq!(
                resolve_for_test(&hand_built, &store).err().unwrap().code,
                "unsupported"
            );
        }
    }

    #[test]
    fn resolve_maps_missing_unavailable_and_corrupt_entries_without_echo() {
        let material = EsAuthMaterial::basic("aladdin", "opensesame").unwrap();
        let (profile, store, reference) = bound(&material);
        let auth = resolve_for_test(&profile, &store).unwrap();
        assert_eq!(auth.kind, AuthKind::Basic);
        assert_eq!(auth.reference.as_ref(), Some(&reference));
        assert_eq!(
            auth.header.as_ref().unwrap().to_str().unwrap(),
            format!("Basic {BASIC_ENCODED}")
        );

        for (fault, code) in [
            (CredentialError::NotFound, "credentialNotFound"),
            (CredentialError::Unavailable, "credentialUnavailable"),
            (CredentialError::StorageFailure, "credentialFailure"),
        ] {
            store.fail_get(Some(fault));
            let error = resolve_for_test(&profile, &store).err().unwrap();
            assert_eq!(error.code, code);
            assert!(!format!("{error:?}").contains("aladdin"));
            assert!(!format!("{error:?}").contains(BASIC_ENCODED));
        }
        store.fail_get(None);

        // A stored secret that is not this kind's payload fails as a credential failure, even
        // though the vault entry exists.
        let (profile, store, _) = bound(&EsAuthMaterial::bearer("fixture-token").unwrap());
        let mut row_state = profile.auth_state.clone();
        row_state.kind = AuthKind::Basic;
        let mismatched = ConnectionProfile {
            auth_state: row_state,
            ..profile.clone()
        };
        assert_eq!(
            resolve_for_test(&mismatched, &store).err().unwrap().code,
            "credentialFailure"
        );

        // Raw garbage in the vault fails the same way.
        let reference = CredentialRef::generate();
        let store = FakeStore::default();
        store.put(&reference, &payload(b"not a payload".to_vec()));
        let profile = ConnectionProfile {
            auth_state: crate::storage::ConnectionAuth {
                kind: AuthKind::ApiKey,
                credential_ref: Some(reference),
            },
            ..profile
        };
        assert_eq!(
            resolve_for_test(&profile, &store).err().unwrap().code,
            "credentialFailure"
        );
    }

    #[test]
    fn debug_serialization_and_errors_never_carry_the_secret() {
        let material = EsAuthMaterial::basic("aladdin", "opensesame").unwrap();
        let (profile, store, reference) = bound(&material);
        let auth = resolve_for_test(&profile, &store).unwrap();
        for rendered in [
            format!("{material:?}"),
            format!("{auth:?}"),
            format!("{:?}", reference),
            serde_json::to_string(&profile).unwrap(),
            serde_json::to_string(&AppError::new("credentialFailure")).unwrap(),
        ] {
            for secret in ["aladdin", "opensesame", BASIC_ENCODED, "Authorization"] {
                assert!(!rendered.contains(secret), "{rendered}");
            }
        }
        // The resolved header itself is the only place the encoding lives in memory, and even its
        // own `Debug` output is redacted by the sensitive flag.
        let header = auth.header.as_ref().unwrap();
        assert!(!format!("{header:?}").contains(BASIC_ENCODED));
    }

    #[test]
    fn transport_snapshot_rejects_invalid_and_missing_ids_before_the_store_is_touched() {
        let temp = tempfile::tempdir().unwrap();
        let mut database = Database::open(&temp.path().join("escope.sqlite")).unwrap();
        let store = FakeStore::default();

        // Neither an invalid identifier nor a missing connection can produce a snapshot, so the
        // resolver is never reached and the vault is not consulted at all.
        assert_eq!(
            database.transport_snapshot("not-a-uuid").unwrap_err().code,
            "invalidInput"
        );
        assert_eq!(
            database
                .transport_snapshot(&uuid::Uuid::new_v4().to_string())
                .unwrap_err()
                .code,
            "notFound"
        );
        assert!(store.get_events().is_empty());

        // A valid stored row is the only path to a resolution, and it reads exactly its own
        // reference.
        let id = connect(
            &mut database,
            &store,
            "Fixture",
            "https://example.test/es",
            EsAuthMaterial::basic("u", "p").unwrap(),
        );
        let snapshot = database.transport_snapshot(&id).unwrap();
        let auth = resolve(&snapshot, &store).unwrap();
        assert_eq!(
            auth.header.as_ref().unwrap().to_str().unwrap(),
            "Basic dTpw"
        );
        assert_eq!(store.get_events().len(), 1);
    }

    #[test]
    fn a_snapshot_cannot_select_another_connections_or_a_models_credential() {
        let temp = tempfile::tempdir().unwrap();
        let mut database = Database::open(&temp.path().join("escope.sqlite")).unwrap();
        let store = FakeStore::default();
        let connection_a = connect(
            &mut database,
            &store,
            "A",
            "https://a.test/es",
            EsAuthMaterial::basic("aladdin", "opensesame").unwrap(),
        );
        let connection_b = connect(
            &mut database,
            &store,
            "B",
            "https://b.test/es",
            EsAuthMaterial::bearer("b-token").unwrap(),
        );
        // A stored reference that belongs to no connection row, as a model key would.
        let foreign = CredentialRef::generate();
        store.put(
            &foreign,
            &EsAuthMaterial::api_key("foreign", "foreign")
                .unwrap()
                .encode()
                .unwrap(),
        );

        let snapshot_a = database.transport_snapshot(&connection_a).unwrap();
        let auth_a = resolve(&snapshot_a, &store).unwrap();
        let reference_a = snapshot_a
            .profile()
            .auth_state
            .credential_ref
            .clone()
            .unwrap();
        assert_eq!(auth_a.reference.as_ref(), Some(&reference_a));
        assert_eq!(
            auth_a.header.as_ref().unwrap().to_str().unwrap(),
            format!("Basic {BASIC_ENCODED}")
        );
        // Only connection A's own reference was read; the foreign entry was never consulted.
        assert_eq!(
            store.get_events(),
            vec![format!("get:{}", reference_a.as_str())]
        );

        let snapshot_b = database.transport_snapshot(&connection_b).unwrap();
        let auth_b = resolve(&snapshot_b, &store).unwrap();
        let reference_b = snapshot_b
            .profile()
            .auth_state
            .credential_ref
            .clone()
            .unwrap();
        assert_eq!(auth_b.reference.as_ref(), Some(&reference_b));
        assert_eq!(
            auth_b.header.as_ref().unwrap().to_str().unwrap(),
            "Bearer b-token"
        );
        assert!(!store
            .get_events()
            .iter()
            .any(|event| event.contains(foreign.as_str())));

        // A resolution for one connection never authenticates the other's plan.
        let target = IndexTarget::parse("logs-*").unwrap();
        let plan_b = search_request(snapshot_b.profile(), &target, b"{}".to_vec()).unwrap();
        assert_eq!(
            plan_b.authenticate(&auth_a).err().unwrap().code,
            "unsupported"
        );
        let plan_a = search_request(snapshot_a.profile(), &target, b"{}".to_vec()).unwrap();
        assert_eq!(
            plan_a.authenticate(&auth_b).err().unwrap().code,
            "unsupported"
        );
        let plan_a = search_request(snapshot_a.profile(), &target, b"{}".to_vec()).unwrap();
        assert!(plan_a.authenticate(&auth_a).is_ok());
    }

    #[test]
    fn a_resolved_header_only_authenticates_its_own_frozen_target() {
        let temp = tempfile::tempdir().unwrap();
        let mut database = Database::open(&temp.path().join("escope.sqlite")).unwrap();
        let store = FakeStore::default();
        let id = connect(
            &mut database,
            &store,
            "Fixture",
            "https://example.test/proxy/es",
            EsAuthMaterial::basic("aladdin", "opensesame").unwrap(),
        );
        let snapshot = database.transport_snapshot(&id).unwrap();
        let auth = resolve(&snapshot, &store).unwrap();
        let profile = snapshot.profile();
        let target = IndexTarget::parse("logs-*").unwrap();

        // The real resolution authenticates exactly its own frozen target, through one sensitive
        // header; the plan's `Debug` never prints it.
        let request = search_request(profile, &target, b"{}".to_vec())
            .unwrap()
            .authenticate(&auth)
            .unwrap()
            .build(&reqwest::Client::new())
            .unwrap()
            .build()
            .unwrap();
        let header = request
            .headers()
            .get(reqwest::header::AUTHORIZATION)
            .unwrap();
        assert_eq!(header.to_str().unwrap(), format!("Basic {BASIC_ENCODED}"));
        assert!(header.is_sensitive());
        let rendered = format!(
            "{:?}",
            search_request(profile, &target, b"{}".to_vec()).unwrap()
        );
        assert!(!rendered.contains(BASIC_ENCODED));
        assert!(!rendered.contains("Basic "));
        assert!(rendered.contains("CredentialRef([REDACTED])"));

        // A copy a caller mutates cannot change what the snapshot already fixed: every changed
        // target is refused with the same resolution.
        let refused = |changed: &ConnectionProfile| {
            search_request(changed, &target, b"{}".to_vec())
                .unwrap()
                .authenticate(&auth)
                .err()
                .map(|error| error.code)
        };
        let mut other_id = profile.clone();
        other_id.id = uuid::Uuid::new_v4().to_string();
        assert_eq!(refused(&other_id), Some("unsupported"));
        let mut other_endpoint = profile.clone();
        other_endpoint.endpoint = "https://other.test/es".into();
        assert_eq!(refused(&other_endpoint), Some("unsupported"));
        let mut other_kind = profile.clone();
        other_kind.auth_state.kind = AuthKind::Bearer;
        assert_eq!(refused(&other_kind), Some("unsupported"));
        let mut other_reference = profile.clone();
        other_reference.auth_state.credential_ref = Some(CredentialRef::generate());
        assert_eq!(refused(&other_reference), Some("unsupported"));
        // An unauthenticated plan can never acquire the header either.
        let plain = ConnectionProfile {
            auth_state: ConnectionAuth::none(),
            ..profile.clone()
        };
        assert_eq!(refused(&plain), Some("unsupported"));
    }

    /// Store one connection in the database and bind `material` to it through the production
    /// credential orchestration, returning the stable connection ID.
    fn connect(
        database: &mut Database,
        store: &FakeStore,
        name: &str,
        endpoint: &str,
        material: EsAuthMaterial,
    ) -> String {
        let id = ConnectionCredentials::new(database, store)
            .save(
                ConnectionInput {
                    display_name: name.into(),
                    endpoint: endpoint.into(),
                    environment: "development".into(),
                },
                None,
            )
            .unwrap()
            .profile
            .id;
        ConnectionCredentials::new(database, store)
            .bind_auth(&id, material)
            .unwrap();
        id
    }

    #[test]
    fn bind_auth_stores_the_encoded_payload_and_rename_or_endpoint_change_keep_the_binding() {
        let temp = tempfile::tempdir().unwrap();
        let mut database = Database::open(&temp.path().join("escope.sqlite")).unwrap();
        let store = FakeStore::default();
        let id = ConnectionCredentials::new(&mut database, &store)
            .save(
                ConnectionInput {
                    display_name: "Fixture".into(),
                    endpoint: "https://example.test/proxy/es".into(),
                    environment: "development".into(),
                },
                None,
            )
            .unwrap()
            .profile
            .id;

        let material = EsAuthMaterial::api_key(API_KEY_ID, API_KEY_SECRET).unwrap();
        let write = ConnectionCredentials::new(&mut database, &store)
            .bind_auth(&id, material)
            .unwrap();
        assert!(write.detached.is_none());
        let reference = write
            .profile
            .auth_state
            .credential_ref
            .clone()
            .expect("bind must record a reference");

        // The transport resolves the payload through the row's own reference, via the trusted
        // snapshot; a caller cannot substitute a profile here.
        let snapshot = database.transport_snapshot(&id).unwrap();
        let auth = resolve(&snapshot, &store).unwrap();
        assert_eq!(auth.reference.as_ref(), Some(&reference));
        assert_eq!(
            auth.header.as_ref().unwrap().to_str().unwrap(),
            format!("ApiKey {API_KEY_ENCODED}")
        );

        // A rename keeps the id, the reference and therefore the resolved header.
        let renamed = ConnectionCredentials::new(&mut database, &store)
            .save(
                ConnectionInput {
                    display_name: "Renamed".into(),
                    endpoint: "https://example.test/proxy/es".into(),
                    environment: "development".into(),
                },
                Some(id.clone()),
            )
            .unwrap();
        assert_eq!(renamed.profile.id, id);
        assert!(renamed.detached.is_none());
        let snapshot = database.transport_snapshot(&id).unwrap();
        let auth = resolve(&snapshot, &store).unwrap();
        assert_eq!(
            auth.header.as_ref().unwrap().to_str().unwrap(),
            format!("ApiKey {API_KEY_ENCODED}")
        );

        // An endpoint change detaches the credential, and the old secret is never read again for
        // the new target even though the vault entry still exists.
        ConnectionCredentials::new(&mut database, &store)
            .save(
                ConnectionInput {
                    display_name: "Renamed".into(),
                    endpoint: "https://other.test/es".into(),
                    environment: "development".into(),
                },
                Some(id.clone()),
            )
            .unwrap();
        let snapshot = database.transport_snapshot(&id).unwrap();
        assert!(snapshot.profile().auth_state.unauthenticated());
        let reads_before = store.get_events().len();
        let auth = resolve(&snapshot, &store).unwrap();
        assert!(auth.header.is_none());
        assert_eq!(auth.endpoint, "https://other.test/es/");
        assert_eq!(store.get_events().len(), reads_before);

        // Deleting the connection removes the trusted read entirely.
        ConnectionCredentials::new(&mut database, &store)
            .delete(&id)
            .unwrap();
        assert_eq!(
            database.transport_snapshot(&id).err().unwrap().code,
            "notFound"
        );
    }
}
