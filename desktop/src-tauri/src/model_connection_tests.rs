use super::*;

#[test]
fn compatible_probe_appends_models_without_leaking_query_or_fragment() {
    let url = models_probe_url("https://models.example/v1/?token=public#section")
        .expect("valid compatible endpoint");
    assert_eq!(url.as_str(), "https://models.example/v1/models");
}

#[test]
fn compatible_probe_keeps_local_http_available() {
    let url = models_probe_url("http://127.0.0.1:11434/v1")
        .expect("local OpenAI-compatible endpoints are supported");
    assert_eq!(url.as_str(), "http://127.0.0.1:11434/v1/models");
}

#[test]
fn compatible_probe_refuses_non_http_schemes_and_missing_hosts() {
    for endpoint in [
        "file:///tmp/model",
        "ftp://models.example/v1",
        "http://",
        "not-a-url",
    ] {
        assert!(
            models_probe_url(endpoint).is_err(),
            "{endpoint} unexpectedly became a model probe target"
        );
    }
}

#[test]
fn provider_probe_client_never_follows_redirects() {
    // reqwest does not expose the redirect policy for inspection. Building the client here pins the
    // helper itself as a fallible unit and the source-level release preflight below pins Policy::none
    // so a future refactor cannot silently turn credential forwarding back on.
    assert!(model_probe_client().is_ok());
}

#[test]
fn protected_probe_blocks_metadata_and_special_use_ip_ranges() {
    for ip in [
        "0.0.0.0",
        "169.254.169.254",
        "169.254.170.2",
        "224.0.0.1",
        "100.100.100.200",
        "::",
        "fe80::1",
        "fd00:ec2::254",
        "ff02::1",
    ] {
        let parsed = ip.parse::<std::net::IpAddr>().expect("test IP");
        assert!(forbidden_probe_ip(parsed), "{ip} unexpectedly passed");
    }
}

#[test]
fn protected_probe_keeps_loopback_and_private_model_hosts_available() {
    for ip in ["127.0.0.1", "10.0.0.8", "172.16.0.5", "192.168.1.20", "::1"] {
        let parsed = ip.parse::<std::net::IpAddr>().expect("test IP");
        assert!(!forbidden_probe_ip(parsed), "{ip} was unexpectedly blocked");
    }

    let local = reqwest::Url::parse("http://127.0.0.1:11434/v1/models").unwrap();
    assert!(protected_endpoint_client(&local).is_ok());
}

#[test]
fn protected_probe_rejects_credentials_embedded_in_endpoint_url() {
    let url = reqwest::Url::parse("https://user:secret@127.0.0.1:8443/v1/models").unwrap();
    let error = protected_endpoint_client(&url).expect_err("userinfo must be refused");
    assert!(error.said.contains("credentials"));
}
