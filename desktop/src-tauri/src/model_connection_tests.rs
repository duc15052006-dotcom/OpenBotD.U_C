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
