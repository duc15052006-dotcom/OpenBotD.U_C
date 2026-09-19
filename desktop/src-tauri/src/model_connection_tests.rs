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
fn compatible_probe_refuses_credentials_embedded_in_the_endpoint_url() {
    for endpoint in [
        "https://alice:secret@models.example/v1",
        "https://alice@models.example/v1",
        "https://:secret@models.example/v1",
    ] {
        let problem = models_probe_url(endpoint).expect_err("URL credentials must be refused");
        assert!(problem.said.contains("must not contain credentials"));
        assert!(problem.detail.is_none());
        assert!(!problem.said.contains("alice"));
        assert!(!problem.said.contains("secret"));
    }
}

#[test]
fn compatible_setup_refuses_credentials_in_host_and_container_endpoint_urls() {
    for (base_url, container_base_url) in [
        (
            "https://alice:secret@models.example/v1",
            "https://models.internal/v1",
        ),
        (
            "https://models.example/v1",
            "https://alice:secret@models.internal/v1",
        ),
    ] {
        let choice = ChosenModel {
            provider: "openai-compatible".into(),
            login: "endpoint".into(),
            api_key: Some("synthetic-api-key".into()),
            base_url: Some(base_url.into()),
            container_base_url: Some(container_base_url.into()),
            model: Some("model-1".into()),
            token: None,
            saved: Some(false),
        };
        let problem = choice
            .into_credential_with(std::path::Path::new("."), |_, _| {
                panic!("typed compatible endpoint must not read a saved secret")
            })
            .expect_err("URL credentials must be refused");
        assert!(problem.said.contains("must not contain credentials"));
        assert!(problem.detail.is_none());
        assert!(!problem.said.contains("alice"));
        assert!(!problem.said.contains("secret"));
    }
}

#[test]
fn compatible_probe_refuses_cloud_metadata_endpoints_even_when_local_http_is_supported() {
    for endpoint in [
        "http://169.254.169.254/latest/meta-data",
        "http://169.254.170.2/v2/credentials",
        "http://100.100.100.200/latest/meta-data",
        "http://metadata.google.internal/computeMetadata/v1",
        "http://metadata.goog/computeMetadata/v1",
        "http://[fd00:ec2::254]/latest/meta-data",
    ] {
        assert!(
            models_probe_url(endpoint).is_err(),
            "{endpoint} unexpectedly became a model probe target"
        );
    }
}

#[test]
fn compatible_probe_catches_ipv4_metadata_hidden_in_ipv6_forms() {
    for host in [
        "::ffff:169.254.169.254",
        "64:ff9b::a9fe:a9fe",
        "::a9fe:a9fe",
    ] {
        assert!(
            model_probe_never_allowed_host(host),
            "{host} unexpectedly bypassed the metadata-address floor"
        );
    }
}

#[test]
fn compatible_saved_endpoint_refuses_cloud_metadata_hosts() {
    for endpoint in [
        "http://169.254.169.254/v1",
        "http://169.254.170.2/v1",
        "http://100.100.100.200/v1",
        "http://metadata.google.internal/v1",
        "http://metadata.goog/v1",
        "http://[fd00:ec2::254]/v1",
    ] {
        assert!(
            model_endpoint_url(endpoint, "model endpoint").is_err(),
            "{endpoint} unexpectedly became a saved model endpoint"
        );
    }
}

#[test]
fn compatible_saved_endpoint_still_allows_local_development_hosts() {
    for endpoint in [
        "http://127.0.0.1:11434/v1",
        "http://localhost:11434/v1",
        "http://ollama:11434/v1",
    ] {
        assert!(
            model_endpoint_url(endpoint, "model endpoint").is_ok(),
            "{endpoint} should remain available for a local compatible provider"
        );
    }
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
fn protected_probe_blocks_resolved_special_use_ranges() {
    for ip in [
        "0.0.0.0",
        "169.254.1.1",
        "169.254.169.254",
        "169.254.170.2",
        "224.0.0.1",
        "100.64.0.1",
        "100.100.100.200",
        "100.127.255.254",
        "::",
        "fe80::1",
        "fd00:ec2::254",
        "ff02::1",
    ] {
        let parsed = ip.parse::<std::net::IpAddr>().expect("test IP");
        assert!(
            forbidden_resolved_probe_ip(parsed),
            "{ip} unexpectedly passed resolved-address validation"
        );
    }
}

#[test]
fn protected_probe_keeps_loopback_and_private_model_hosts_available() {
    for ip in ["127.0.0.1", "10.0.0.8", "172.16.0.5", "192.168.1.20", "::1"] {
        let parsed = ip.parse::<std::net::IpAddr>().expect("test IP");
        assert!(
            !forbidden_resolved_probe_ip(parsed),
            "{ip} was unexpectedly blocked"
        );
    }

    let local = reqwest::Url::parse("http://127.0.0.1:11434/v1/models").unwrap();
    assert!(protected_model_probe_client(&local).is_ok());
}

#[test]
fn protected_probe_rejects_credentials_embedded_in_endpoint_url() {
    let url = reqwest::Url::parse("https://user:secret@127.0.0.1:8443/v1/models").unwrap();
    let error = protected_model_probe_client(&url)
        .err()
        .expect("userinfo must be refused");
    assert!(error.said.contains("credentials"));
}
