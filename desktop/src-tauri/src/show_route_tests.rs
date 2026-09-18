use super::*;

#[test]
fn first_coworker_route_stays_on_the_verified_local_app_origin() {
    let url = openbot_route_url("http://127.0.0.1:3010/", Some(("/agents", "new=true")))
        .expect("fixed coworker route should be valid");
    assert_eq!(url.as_str(), "http://127.0.0.1:3010/agents?new=true");
}

#[test]
fn plain_openbot_route_keeps_the_verified_local_app_url() {
    let url = openbot_route_url("http://[::1]:3010/", None).expect("local app URL should be valid");
    assert_eq!(url.as_str(), "http://[::1]:3010/");
}

#[test]
fn scheme_relative_routes_are_refused() {
    assert!(openbot_route_url(
        "http://127.0.0.1:3010/",
        Some(("//example.com/agents", "new=true")),
    )
    .is_err());
}
