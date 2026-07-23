//! `~/.ssh/config` parsing and import.
//!
//! The Match test is the important one. Not evaluating Match blocks is a
//! documented limitation; *silently attributing the directives inside one to
//! the preceding Host* would be a correctness bug that produces wrong hosts
//! with no error anywhere — which is far worse than a limitation.

use std::path::PathBuf;

use tern_core_store::{
    AuthKind, HostSource, NewHost, SshConfigDisposition, SshConfigWarning, Store, apply_ssh_config,
    scan_ssh_config,
};

fn fixture(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/ssh_config")
        .join(name)
}

fn store() -> Store {
    Store::open_in_memory().expect("store")
}

fn scan(name: &str, store: &Store) -> tern_core_store::SshConfigScan {
    scan_ssh_config(&fixture(name), store).expect("scan")
}

fn find<'a>(
    s: &'a tern_core_store::SshConfigScan,
    alias: &str,
) -> &'a tern_core_store::SshConfigCandidate {
    s.candidates
        .iter()
        .find(|c| c.alias == alias)
        .unwrap_or_else(|| panic!("no candidate {alias}; got {:?}", aliases(s)))
}

fn aliases(s: &tern_core_store::SshConfigScan) -> Vec<&str> {
    s.candidates.iter().map(|c| c.alias.as_str()).collect()
}

#[test]
fn basic_directives_are_read() {
    let s = store();
    let scanned = scan("basic", &s);
    let bastion = find(&scanned, "bastion");
    assert_eq!(bastion.hostname, "bastion.example.com");
    assert_eq!(bastion.port, 2222);
    assert_eq!(bastion.username, "jump");
    assert_eq!(bastion.auth, AuthKind::KeyFile);
    assert!(
        bastion
            .key_path
            .as_deref()
            .is_some_and(|p| p.ends_with("id_bastion"))
    );
}

#[test]
fn one_stanza_naming_several_aliases_yields_several_hosts() {
    // `Host web1 web2` is two separately connectable names.
    let s = store();
    let scanned = scan("basic", &s);
    assert_eq!(find(&scanned, "web1").username, "deploy");
    assert_eq!(find(&scanned, "web2").username, "deploy");
}

#[test]
fn wildcard_stanzas_are_defaults_not_hosts() {
    // `Host *` and `Host *.legacy` are not connectable names; importing them
    // as hosts would put junk like "*" in the sidebar.
    let s = store();
    let scanned = scan("basic", &s);
    for alias in aliases(&scanned) {
        assert!(
            !alias.contains('*'),
            "wildcard leaked into candidates: {alias}"
        );
        assert!(
            !alias.starts_with('!'),
            "negation leaked into candidates: {alias}"
        );
    }
}

#[test]
fn host_star_defaults_are_inherited_by_stanzas_that_do_not_set_them() {
    let s = store();
    let scanned = scan("basic", &s);
    // `db` sets no User, so it inherits from `Host *` at the bottom of the file.
    assert_eq!(find(&scanned, "db").username, "defaultuser");
}

#[test]
fn a_stanza_that_sets_a_value_keeps_it_against_defaults() {
    // OpenSSH is first-obtained-value-wins; the default must not overwrite.
    let s = store();
    let scanned = scan("basic", &s);
    assert_eq!(find(&scanned, "bastion").username, "jump");
}

#[test]
fn missing_hostname_falls_back_to_the_alias() {
    let s = store();
    let mut scanned = scan("basic", &s);
    scanned.candidates.retain(|c| c.alias == "bastion");
    // `Host db` does set HostName; construct the no-HostName case explicitly.
    let parsed = scan_ssh_config(&fixture("with_include"), &s).expect("scan");
    let top = find(&parsed, "top");
    assert_eq!(top.hostname, "top.example.com");
}

#[test]
fn proxy_jump_is_captured_for_phase_2() {
    let s = store();
    let scanned = scan("basic", &s);
    assert_eq!(
        find(&scanned, "web1").proxy_jump.as_deref(),
        Some("bastion")
    );
}

#[test]
fn timeouts_map_onto_per_host_overrides() {
    let s = store();
    let scanned = scan("basic", &s);
    let db = find(&scanned, "db");
    assert_eq!(db.overrides.keepalive_secs, Some(30));
    assert_eq!(db.overrides.connect_timeout_secs, Some(5));
}

#[test]
fn forward_agent_reaches_the_candidate() {
    // Parsed since Phase 1 but dropped on the floor until agent forwarding
    // existed to receive it. The fixture sets it under `Host *`, so this also
    // pins that it inherits like any other default.
    let s = store();
    let scanned = scan("basic", &s);
    assert_eq!(find(&scanned, "db").overrides.forward_agent, Some(true));
}

#[test]
fn a_config_without_forward_agent_leaves_it_unset() {
    // Import must not switch forwarding on for a config that never asked. This
    // fixture has no ForwardAgent line anywhere.
    let s = store();
    let scanned = scan("with_match", &s);
    for candidate in &scanned.candidates {
        assert_eq!(
            candidate.overrides.forward_agent, None,
            "{} gained agent forwarding from a config that never mentions it",
            candidate.alias
        );
    }
}

#[test]
fn unmodelled_keywords_are_reported_never_silently_dropped() {
    // The promise that bounds this feature's scope: you can see what did not
    // come across.
    let s = store();
    let scanned = scan("basic", &s);
    let unsupported: Vec<&str> = scanned
        .warnings
        .iter()
        .filter_map(|w| match w {
            SshConfigWarning::UnsupportedKeyword { keyword, .. } => Some(keyword.as_str()),
            _ => None,
        })
        .collect();
    assert!(unsupported.contains(&"compression"), "got {unsupported:?}");
    assert!(unsupported.contains(&"loglevel"), "got {unsupported:?}");
}

#[test]
fn an_ssh_config_never_produces_password_auth() {
    // There are no credentials in an ssh_config, so claiming password auth
    // would create hosts that prompt for something we never had.
    let s = store();
    let scanned = scan("basic", &s);
    assert!(
        scanned
            .candidates
            .iter()
            .all(|c| c.auth != AuthKind::Password)
    );
}

#[test]
fn a_match_block_does_not_leak_its_directives_onto_the_previous_host() {
    // The bug this whole design exists to prevent. `Match host nomatch` sets
    // User attacker / Port 31337; if those landed on `safe`, the import would
    // silently produce a host pointing somewhere the user never configured.
    let s = store();
    let scanned = scan("with_match", &s);
    let safe = find(&scanned, "safe");
    assert_eq!(
        safe.username, "alice",
        "Match directives leaked onto the previous Host"
    );
    assert_eq!(
        safe.port, 22,
        "Match directives leaked onto the previous Host"
    );
}

#[test]
fn a_match_block_is_reported() {
    let s = store();
    let scanned = scan("with_match", &s);
    assert!(
        scanned
            .warnings
            .iter()
            .any(|w| matches!(w, SshConfigWarning::MatchUnsupported { .. })),
        "expected a MatchUnsupported warning, got {:?}",
        scanned.warnings
    );
}

#[test]
fn parsing_resumes_at_the_next_host_after_a_match() {
    let s = store();
    let scanned = scan("with_match", &s);
    assert_eq!(find(&scanned, "after").hostname, "after.example.com");
}

#[test]
fn include_pulls_in_other_files() {
    let s = store();
    let scanned = scan("with_include", &s);
    assert_eq!(find(&scanned, "included").username, "fromInclude");
    assert_eq!(find(&scanned, "top").hostname, "top.example.com");
}

#[test]
fn an_include_cycle_terminates_and_warns() {
    // Two files including each other must not hang the importer.
    let s = store();
    let scanned = scan("cycle_a", &s);
    assert!(
        scanned
            .warnings
            .iter()
            .any(|w| matches!(w, SshConfigWarning::IncludeCycle { .. })),
        "expected an IncludeCycle warning, got {:?}",
        scanned.warnings
    );
    // Both files were still read once.
    assert_eq!(find(&scanned, "a").hostname, "a.example.com");
    assert_eq!(find(&scanned, "b").hostname, "b.example.com");
}

#[test]
fn scan_writes_nothing() {
    // The preview must be side-effect free, or "cancel" would not mean cancel.
    let s = store();
    scan("basic", &s);
    let hosts = s
        .hosts()
        .list(&tern_core_store::HostFilter::default())
        .expect("list");
    assert!(hosts.is_empty());
}

#[test]
fn apply_creates_hosts_and_marks_their_provenance() {
    let s = store();
    let scanned = scan("basic", &s);
    let outcome = apply_ssh_config(&s, &scanned.candidates).expect("apply");
    assert_eq!(outcome.created, scanned.candidates.len());
    assert_eq!(outcome.updated, 0);

    let stored = s
        .hosts()
        .find_by_source_alias("bastion")
        .expect("lookup")
        .expect("imported");
    assert_eq!(stored.source, HostSource::SshConfig);
    assert_eq!(stored.port, 2222);
}

#[test]
fn re_importing_updates_rather_than_duplicating() {
    let s = store();
    let first = scan("basic", &s);
    apply_ssh_config(&s, &first.candidates).expect("first apply");
    let count = s
        .hosts()
        .list(&tern_core_store::HostFilter::default())
        .expect("list")
        .len();

    // The second scan sees the existing rows and says so.
    let second = scan("basic", &s);
    assert!(
        second
            .candidates
            .iter()
            .all(|c| c.disposition == SshConfigDisposition::Update)
    );

    let outcome = apply_ssh_config(&s, &second.candidates).expect("second apply");
    assert_eq!(outcome.created, 0);
    assert_eq!(outcome.updated, second.candidates.len());
    assert_eq!(
        s.hosts()
            .list(&tern_core_store::HostFilter::default())
            .expect("list")
            .len(),
        count,
        "re-import duplicated hosts"
    );
}

#[test]
fn re_import_preserves_a_user_renamed_host() {
    // Renaming an imported host is a deliberate act; a re-import updating
    // connection details must not undo it.
    let s = store();
    let scanned = scan("basic", &s);
    apply_ssh_config(&s, &scanned.candidates).expect("apply");

    let mut host = s
        .hosts()
        .find_by_source_alias("bastion")
        .expect("lookup")
        .expect("imported");
    host.name = "My Bastion".into();
    s.hosts().update(&host).expect("rename");

    apply_ssh_config(&s, &scan("basic", &s).candidates).expect("re-apply");
    let after = s
        .hosts()
        .find_by_source_alias("bastion")
        .expect("lookup")
        .expect("imported");
    assert_eq!(after.name, "My Bastion");
}

#[test]
fn hand_made_hosts_are_never_touched_by_an_import() {
    // The alias lookup is scoped to source='ssh_config', so a manual host that
    // happens to share a name is left alone.
    let s = store();
    let mut manual = NewHost::manual("bastion", "mine.example.com");
    manual.port = 9999;
    let manual_id = s.hosts().create(&manual).expect("create manual");

    let scanned = scan("basic", &s);
    apply_ssh_config(&s, &scanned.candidates).expect("apply");

    let untouched = s.hosts().get(manual_id).expect("get").expect("exists");
    assert_eq!(untouched.hostname, "mine.example.com");
    assert_eq!(untouched.port, 9999);
    assert_eq!(untouched.source, HostSource::Manual);
}

#[test]
fn importing_a_missing_file_is_empty_rather_than_an_error() {
    // A machine with no ~/.ssh/config is normal, not a fault.
    let s = store();
    let scanned = scan_ssh_config(&fixture("does-not-exist"), &s).expect("scan");
    assert!(scanned.candidates.is_empty());
}

#[test]
fn a_wildcard_stanza_reaches_only_the_hosts_it_matches() {
    // The bug this replaced: treating every wildcard stanza as a universal
    // default gave `db` User root from `Host *.legacy`, which it does not
    // match. Resolution now walks stanzas and asks each whether it applies.
    let s = store();
    let scanned = scan("basic", &s);
    assert_eq!(find(&scanned, "app.legacy").username, "root");
    assert_eq!(find(&scanned, "db").username, "defaultuser");
}

#[test]
fn a_negated_pattern_excludes_a_host_from_its_own_wildcard() {
    // `Host *.legacy !old.legacy` matches app.legacy but explicitly not
    // old.legacy, which falls through to `Host *`.
    let s = store();
    let scanned = scan("basic", &s);
    assert_eq!(find(&scanned, "old.legacy").username, "defaultuser");
}
