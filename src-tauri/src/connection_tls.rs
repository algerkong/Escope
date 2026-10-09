//! Custom CA support for the read-only transport (C04.1).
//!
//! One connection may trust one bounded chain of additional **public** CA certificates, stored as
//! PEM in the trusted database row (`connections.ca_pem`). Everything about the default TLS
//! behavior stays in force: certificate verification always runs, the built-in webpki roots stay
//! trusted, and redirects, environment proxies and insecure-certificate toggles do not exist in
//! this module or in the transport it builds.
//!
//! Validation is layered and each layer has its own structured code:
//! - [`CaCertificate::parse`] checks the text: at most 64 KiB, 1..=16 PEM blocks, every block
//!   labelled `CERTIFICATE` (a private key, a request or any other label is refused), nothing
//!   outside the blocks, and a strict base64 body for every block — `invalidCertificate`.
//! - [`CaCertificate::verify_usable`] hands the chain to the maintained rustls parsing inside
//!   reqwest and requires it to install into a fresh root store — `tlsError`. It runs before a
//!   chain can be stored, so a certificate rustls cannot use never reaches SQLite.
//!
//! A `CaCertificate` is never serialized, and its `Debug` output carries only the byte length, so
//! no certificate body can leak through a log line. Transport code receives the bytes only to add
//! them to a client that is built for one connection snapshot; no client, root store or secret is
//! cached across targets.

use crate::error::AppError;
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use reqwest::{redirect::Policy, Client};
use std::fmt;
use std::time::Duration;

/// Hard upper bound for one stored PEM chain, matching the SQLite check on `connections.ca_pem`.
pub const MAX_CA_PEM_BYTES: usize = 64 * 1024;

/// Upper bound for one chain. A hand-installed CA chain is a handful of certificates; more than
/// this is treated as a mistaken paste instead of being silently truncated.
pub const MAX_CA_CERTIFICATES: usize = 16;

/// Connect timeout shared with the existing read-only client.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(3);

/// Timeout used only by the throwaway client that verifies a candidate chain at save time.
const VERIFY_TIMEOUT: Duration = Duration::from_secs(10);

const USER_AGENT: &str = "EScope/0.1.0";

/// One validated chain of public CA certificates in PEM form.
pub struct CaCertificate {
    pem: String,
}

impl CaCertificate {
    /// Validate the text of a submitted or stored chain. Structural problems are
    /// `invalidCertificate`; the caller must still run [`CaCertificate::verify_usable`] before
    /// persisting a newly submitted chain.
    pub fn parse(pem: &str) -> Result<Self, AppError> {
        validate_structure(pem)?;
        Ok(Self {
            pem: pem.to_owned(),
        })
    }

    /// Require the maintained rustls path to accept the whole chain. The certificate text is
    /// re-checked here by rustls itself when the client is built, so a chain that only *looks*
    /// like PEM is refused before it can be stored.
    pub fn verify_usable(&self) -> Result<(), AppError> {
        build_client(VERIFY_TIMEOUT, Some(self)).map(|_| ())
    }

    /// The exact PEM text to persist. Public certificate material, never a secret.
    pub(crate) fn as_pem(&self) -> &str {
        &self.pem
    }
}

impl fmt::Debug for CaCertificate {
    /// The chain itself is public data, but it is never printed: the byte length is enough to see
    /// which chain was used, and a log line stays free of certificate bodies.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("CaCertificate")
            .field("pem_bytes", &self.pem.len())
            .finish_non_exhaustive()
    }
}

/// Build one read-only HTTP client with the shared transport invariants: no redirects, no proxy
/// (environment or system), finite connect and overall timeouts, product user agent. When a chain
/// is supplied it is *added to* the default trust roots — never a replacement and never a
/// verification opt-out, so an unrelated cluster still has to present a valid public chain.
///
/// The client is built per call: a client that carries one connection's extra roots is never
/// reused for another connection, and nothing is cached.
pub(crate) fn build_client(
    timeout: Duration,
    ca: Option<&CaCertificate>,
) -> Result<Client, AppError> {
    let mut builder = Client::builder()
        .redirect(Policy::none())
        .referer(false)
        .no_proxy()
        .connect_timeout(CONNECT_TIMEOUT)
        .timeout(timeout)
        .user_agent(USER_AGENT);
    if let Some(ca) = ca {
        let certificate = reqwest::Certificate::from_pem(ca.pem.as_bytes())
            .map_err(|_| AppError::new("invalidCertificate"))?;
        builder = builder.add_root_certificate(certificate);
    }
    builder.build().map_err(|_| {
        // Without a custom chain the base client failed to build, which is the pre-existing
        // transport failure. With one, rustls refused the chain it was given.
        AppError::new(if ca.is_some() {
            "tlsError"
        } else {
            "networkError"
        })
    })
}

/// Check the PEM *text* of one chain and nothing else: bounds, block labels, block count and a
/// strict base64 body per block. Every accessor fails closed; nothing is echoed back.
fn validate_structure(pem: &str) -> Result<(), AppError> {
    let invalid = || AppError::new("invalidCertificate");
    if pem.is_empty() || pem.len() > MAX_CA_PEM_BYTES {
        return Err(invalid());
    }
    let mut certificates = 0usize;
    let mut open = false;
    let mut body = String::new();
    for raw in pem.lines() {
        let line = raw.trim();
        if line.is_empty() {
            continue;
        }
        if let Some(label) = line
            .strip_prefix("-----BEGIN ")
            .and_then(|rest| rest.strip_suffix("-----"))
        {
            if open || label != "CERTIFICATE" {
                return Err(invalid());
            }
            certificates += 1;
            if certificates > MAX_CA_CERTIFICATES {
                return Err(invalid());
            }
            open = true;
            body.clear();
            continue;
        }
        if let Some(label) = line
            .strip_prefix("-----END ")
            .and_then(|rest| rest.strip_suffix("-----"))
        {
            if !open || label != "CERTIFICATE" || body.is_empty() {
                return Err(invalid());
            }
            let der = BASE64.decode(body.as_bytes()).map_err(|_| invalid())?;
            if der.is_empty() {
                return Err(invalid());
            }
            open = false;
            body.clear();
            continue;
        }
        // Any other non-empty line must be base64 inside an open certificate block.
        if !open || !line.bytes().all(is_pem_base64_byte) {
            return Err(invalid());
        }
        body.push_str(line);
    }
    if open || certificates == 0 {
        return Err(invalid());
    }
    Ok(())
}

const fn is_pem_base64_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'+' || byte == b'/' || byte == b'='
}

#[cfg(test)]
pub(crate) mod test_certificates {
    //! Public fixture certificates shared by crate-local tests. Never compiled into production
    //! builds and never used by production code.

    /// Amazon Root CA 3 (the maintained reqwest test bundle).
    pub(crate) const ROOT_CA_3: &str = "\
-----BEGIN CERTIFICATE-----
MIIBtjCCAVugAwIBAgITBmyf1XSXNmY/Owua2eiedgPySjAKBggqhkjOPQQDAjA5
MQswCQYDVQQGEwJVUzEPMA0GA1UEChMGQW1hem9uMRkwFwYDVQQDExBBbWF6b24g
Um9vdCBDQSAzMB4XDTE1MDUyNjAwMDAwMFoXDTQwMDUyNjAwMDAwMFowOTELMAkG
A1UEBhMCVVMxDzANBgNVBAoTBkFtYXpvbjEZMBcGA1UEAxMQQW1hem9uIFJvb3Qg
Q0EgMzBZMBMGByqGSM49AgEGCCqGSM49AwEHA0IABCmXp8ZBf8ANm+gBG1bG8lKl
ui2yEujSLtf6ycXYqm0fc4E7O5hrOXwzpcVOho6AF2hiRVd9RFgdszflZwjrZt6j
QjBAMA8GA1UdEwEB/wQFMAMBAf8wDgYDVR0PAQH/BAQDAgGGMB0GA1UdDgQWBBSr
ttvXBp43rDCGB5Fwx5zEGbF4wDAKBggqhkjOPQQDAgNJADBGAiEA4IWSoxe3jfkr
BqWTrBqYaGFy+uGh0PsceGCmQ5nFuMQCIQCcAu/xlJyzlvnrxir4tiz+OpAUFteM
YyRIHN8wfdVoOw==
-----END CERTIFICATE-----
";

    /// Amazon Root CA 4, so a chain of two blocks can be exercised.
    pub(crate) const ROOT_CA_4: &str = "\
-----BEGIN CERTIFICATE-----
MIIB8jCCAXigAwIBAgITBmyf18G7EEwpQ+Vxe3ssyBrBDjAKBggqhkjOPQQDAzA5
MQswCQYDVQQGEwJVUzEPMA0GA1UEChMGQW1hem9uMRkwFwYDVQQDExBBbWF6b24g
Um9vdCBDQSA0MB4XDTE1MDUyNjAwMDAwMFoXDTQwMDUyNjAwMDAwMFowOTELMAkG
A1UEBhMCVVMxDzANBgNVBAoTBkFtYXpvbjEZMBcGA1UEAxMQQW1hem9uIFJvb3Qg
Q0EgNDB2MBAGByqGSM49AgEGBSuBBAAiA2IABNKrijdPo1MN/sGKe0uoe0ZLY7Bi
9i0b2whxIdIA6GO9mif78DluXeo9pcmBqqNbIJhFXRbb/egQbeOc4OO9X4Ri83Bk
M6DLJC9wuoihKqB1+IGuYgbEgds5bimwHvouXKNCMEAwDwYDVR0TAQH/BAUwAwEB
/zAOBgNVHQ8BAf8EBAMCAYYwHQYDVR0OBBYEFNPsxzplbszh2naaVvuc84ZtV+WB
MAoGCCqGSM49BAMDA2gAMGUCMDqLIfG9fhGt0O9Yli/W651+kI0rz2ZVwyzjKKlw
CkcO8DdZEv8tmZQoTipPNU0zWgIxAOp1AE47xDqUEpHJWEadIRNyp4iciuRMStuW
1KyLa2tJElMzrdfkviT8tQp21KW8EA==
-----END CERTIFICATE-----
";

    /// A two-certificate chain of both fixtures.
    pub(crate) fn chain() -> String {
        format!("{ROOT_CA_3}\n{ROOT_CA_4}")
    }
}

#[cfg(test)]
mod tests {
    use super::test_certificates::{chain, ROOT_CA_3};
    use super::*;

    #[test]
    fn valid_single_certificate_and_chain_are_accepted_and_usable() {
        let single = CaCertificate::parse(ROOT_CA_3).unwrap();
        single.verify_usable().unwrap();
        assert!(single.as_pem().starts_with("-----BEGIN CERTIFICATE-----"));
        let both = CaCertificate::parse(&chain()).unwrap();
        both.verify_usable().unwrap();
        // The two acceptance paths used by the transport: a client with the extra roots and the
        // default client both build, and neither disables verification.
        assert!(build_client(Duration::from_secs(1), Some(&both)).is_ok());
        assert!(build_client(Duration::from_secs(1), None).is_ok());
    }

    #[test]
    fn structure_failures_are_invalid_certificate() {
        let too_many = ROOT_CA_3.repeat(MAX_CA_CERTIFICATES + 1);
        for (label, pem) in [
            ("empty", String::new()),
            ("oversized", "A".repeat(MAX_CA_PEM_BYTES + 1)),
            ("garbage", "not a certificate".into()),
            ("content outside blocks", format!("junk\n{ROOT_CA_3}")),
            (
                "missing end",
                "-----BEGIN CERTIFICATE-----\nMIIB\n".to_owned(),
            ),
            (
                "wrong begin label",
                "-----BEGIN TRUSTED CERTIFICATE-----\nMIIB\n-----END TRUSTED CERTIFICATE-----\n"
                    .to_owned(),
            ),
            (
                "private key only",
                "-----BEGIN EC PRIVATE KEY-----\nMHcCAQEE\n-----END EC PRIVATE KEY-----\n"
                    .to_owned(),
            ),
            (
                "private key inside a chain",
                format!(
                    "{ROOT_CA_3}\n-----BEGIN RSA PRIVATE KEY-----\nMIIB\n-----END RSA PRIVATE KEY-----\n"
                ),
            ),
            ("nested begin", format!("{ROOT_CA_3}\n-----BEGIN CERTIFICATE-----")),
            ("too many certificates", too_many),
            (
                "invalid base64 body",
                "-----BEGIN CERTIFICATE-----\n!!!!\n-----END CERTIFICATE-----\n".to_owned(),
            ),
            (
                "empty body",
                "-----BEGIN CERTIFICATE-----\n-----END CERTIFICATE-----\n".to_owned(),
            ),
        ] {
            assert_eq!(
                CaCertificate::parse(&pem).unwrap_err().code,
                "invalidCertificate",
                "must be rejected: {label}"
            );
        }
    }

    #[test]
    fn structurally_valid_but_unusable_der_is_tls_error_and_never_reaches_a_store() {
        // base64 of `hello`, not a DER certificate: the text is well-formed PEM, but rustls
        // refuses it, so it must be refused before it could be persisted.
        let fake = "-----BEGIN CERTIFICATE-----\naGVsbG8=\n-----END CERTIFICATE-----\n";
        let parsed = CaCertificate::parse(fake).unwrap();
        let error = parsed.verify_usable().unwrap_err();
        assert_eq!(error.code, "tlsError");
        assert!(!format!("{error:?}").contains("aGVsbG8"));
        assert!(build_client(Duration::from_secs(1), Some(&parsed)).is_err());
    }

    #[test]
    fn certificate_never_prints_its_body() {
        let ca = CaCertificate::parse(&chain()).unwrap();
        let debug = format!("{ca:?}");
        assert!(debug.contains("CaCertificate"));
        assert!(!debug.contains("BEGIN CERTIFICATE"));
        assert!(!debug.contains("MIIB"));
    }
}
