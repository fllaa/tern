//! Repository behaviour, with emphasis on the invariants SQL cannot express
//! declaratively — folder cycles, NULL-parent name uniqueness, and the
//! delete semantics that decide whether a host record survives.

use tern_core_store::{AuthKind, HostFilter, HostSource, NewHost, NewSnippet, Store, StoreError};

fn store() -> Store {
    Store::open_in_memory().expect("open in-memory store")
}

#[test]
fn host_round_trips_through_create_and_get() {
    let s = store();
    let mut draft = NewHost::manual("prod-web", "web1.example.com");
    draft.port = 2222;
    draft.username = "deploy".into();
    draft.auth = AuthKind::KeyFile;
    draft.key_path = Some("/home/me/.ssh/id_ed25519".into());
    draft.overrides.keepalive_secs = Some(30);
    draft.overrides.reconnect_enabled = Some(false);
    draft.notes = Some("bastion is required".into());

    let id = s.hosts().create(&draft).expect("create host");
    let got = s.hosts().get(id).expect("get host").expect("host exists");

    assert_eq!(got.name, "prod-web");
    assert_eq!(got.hostname, "web1.example.com");
    assert_eq!(got.port, 2222);
    assert_eq!(got.username, "deploy");
    assert_eq!(got.auth, AuthKind::KeyFile);
    assert_eq!(got.key_path.as_deref(), Some("/home/me/.ssh/id_ed25519"));
    assert_eq!(got.overrides.keepalive_secs, Some(30));
    assert_eq!(got.overrides.reconnect_enabled, Some(false));
    assert_eq!(got.source, HostSource::Manual);
    assert_eq!(got.connect_count, 0);
    assert!(got.last_connected_at.is_none());
}

#[test]
fn agent_forwarding_round_trips_and_defaults_to_unset() {
    // The flag is what lets a remote root authenticate onward as the user, so
    // two things are pinned here: a host that never asked for it stores NULL,
    // and a host that did gets exactly what it asked for back — including a
    // stored `false`, which must not decay into "unset" and then into a
    // default someone later changes.
    let s = store();
    let plain = s
        .hosts()
        .create(&NewHost::manual("plain", "example.com"))
        .expect("create");
    assert_eq!(
        s.hosts()
            .get(plain)
            .expect("get")
            .expect("exists")
            .overrides
            .forward_agent,
        None,
    );

    for wanted in [Some(true), Some(false)] {
        let mut draft = NewHost::manual("fwd", "example.com");
        draft.overrides.forward_agent = wanted;
        let id = s.hosts().create(&draft).expect("create");
        let mut host = s.hosts().get(id).expect("get").expect("exists");
        assert_eq!(host.overrides.forward_agent, wanted);

        // And it survives the full-record update path, which is how the edit
        // dialog turns it back off.
        host.overrides.forward_agent = wanted.map(|v| !v);
        s.hosts().update(&host).expect("update");
        let got = s.hosts().get(id).expect("get").expect("exists");
        assert_eq!(got.overrides.forward_agent, wanted.map(|v| !v));
    }
}

#[test]
fn unset_overrides_stay_none_rather_than_defaulting() {
    // `None` means "inherit the global setting". If a round trip turned that
    // into a concrete value, every host would silently pin whatever the global
    // happened to be at creation time.
    let s = store();
    let id = s
        .hosts()
        .create(&NewHost::manual("plain", "example.com"))
        .expect("create host");
    let got = s.hosts().get(id).expect("get").expect("exists");
    assert_eq!(got.overrides, tern_core_store::HostOverrides::default());
}

#[test]
fn update_replaces_the_whole_record() {
    let s = store();
    let id = s
        .hosts()
        .create(&NewHost::manual("old", "old.example.com"))
        .expect("create");
    let mut host = s.hosts().get(id).expect("get").expect("exists");
    host.name = "new".into();
    host.hostname = "new.example.com".into();
    host.overrides.term = Some("xterm-256color".into());
    s.hosts().update(&host).expect("update");

    let got = s.hosts().get(id).expect("get").expect("exists");
    assert_eq!(got.name, "new");
    assert_eq!(got.hostname, "new.example.com");
    assert_eq!(got.overrides.term.as_deref(), Some("xterm-256color"));
}

#[test]
fn updating_a_missing_host_reports_not_found() {
    let s = store();
    let id = s
        .hosts()
        .create(&NewHost::manual("gone", "example.com"))
        .expect("create");
    let host = s.hosts().get(id).expect("get").expect("exists");
    s.hosts().delete(id).expect("delete");

    match s.hosts().update(&host) {
        Err(StoreError::NotFound { entity, .. }) => assert_eq!(entity, "host"),
        other => panic!("expected NotFound, got {other:?}"),
    }
}

#[test]
fn two_root_folders_cannot_share_a_name() {
    // The reason `UNIQUE(parent_id, name)` is not enough: SQLite treats NULLs
    // as distinct, so without the ifnull() expression index both inserts would
    // succeed and the sidebar would show two identical root folders.
    let s = store();
    s.folders().create(None, "Production").expect("first");
    assert!(
        s.folders().create(None, "Production").is_err(),
        "duplicate root folder name was accepted"
    );
    // Case-insensitively, too.
    assert!(
        s.folders().create(None, "production").is_err(),
        "duplicate root folder name differing only in case was accepted"
    );
}

#[test]
fn same_name_is_fine_under_different_parents() {
    let s = store();
    let a = s.folders().create(None, "eu-west").expect("a");
    let b = s.folders().create(None, "us-east").expect("b");
    s.folders().create(Some(a), "web").expect("a/web");
    s.folders()
        .create(Some(b), "web")
        .expect("b/web should not collide with a/web");
}

#[test]
fn folder_cannot_be_moved_into_its_own_descendant() {
    let s = store();
    let root = s.folders().create(None, "root").expect("root");
    let mid = s.folders().create(Some(root), "mid").expect("mid");
    let leaf = s.folders().create(Some(mid), "leaf").expect("leaf");

    match s.folders().reparent(root, Some(leaf)) {
        Err(StoreError::FolderCycle { .. }) => {}
        other => panic!("expected FolderCycle, got {other:?}"),
    }
    // And the degenerate self-move.
    match s.folders().reparent(mid, Some(mid)) {
        Err(StoreError::FolderCycle { .. }) => {}
        other => panic!("expected FolderCycle for self-move, got {other:?}"),
    }
    // The tree is intact — nothing was detached by the rejected moves.
    assert_eq!(s.folders().tree().expect("tree").len(), 3);
}

#[test]
fn legitimate_reparent_succeeds() {
    let s = store();
    let a = s.folders().create(None, "a").expect("a");
    let b = s.folders().create(None, "b").expect("b");
    let child = s.folders().create(Some(a), "child").expect("child");

    s.folders().reparent(child, Some(b)).expect("reparent");
    let tree = s.folders().tree().expect("tree");
    let moved = tree.iter().find(|f| f.id == child).expect("child present");
    assert_eq!(moved.parent_id, Some(b));
}

#[test]
fn deleting_a_folder_orphans_its_hosts_instead_of_deleting_them() {
    // The single most destructive thing this store could get wrong. A host
    // carries credentials and connection history; a folder is just grouping.
    let s = store();
    let folder = s.folders().create(None, "staging").expect("folder");
    let mut draft = NewHost::manual("box", "box.example.com");
    draft.folder_id = Some(folder);
    let host = s.hosts().create(&draft).expect("create host");

    s.folders().delete(folder).expect("delete folder");

    let got = s.hosts().get(host).expect("get").expect("host survived");
    assert_eq!(got.folder_id, None, "host should orphan to root");
}

#[test]
fn deleting_a_folder_cascades_to_subfolders() {
    let s = store();
    let root = s.folders().create(None, "root").expect("root");
    let child = s.folders().create(Some(root), "child").expect("child");
    s.folders()
        .create(Some(child), "grandchild")
        .expect("grandchild");

    s.folders().delete(root).expect("delete");
    assert!(s.folders().tree().expect("tree").is_empty());
}

#[test]
fn tags_are_idempotent_and_cascade_on_delete() {
    let s = store();
    let host = s
        .hosts()
        .create(&NewHost::manual("tagged", "example.com"))
        .expect("host");

    let prod = s.tags().get_or_create("prod", None).expect("tag");
    // Same name (any case) returns the same row rather than erroring.
    assert_eq!(s.tags().get_or_create("PROD", None).expect("again"), prod);
    let db = s.tags().get_or_create("db", None).expect("tag");

    s.hosts().set_tags(host, &[prod, db]).expect("set tags");
    assert_eq!(
        s.hosts()
            .get(host)
            .expect("get")
            .expect("exists")
            .tags
            .len(),
        2
    );

    s.tags().delete(db).expect("delete tag");
    let got = s.hosts().get(host).expect("get").expect("exists");
    assert_eq!(got.tags, vec![prod], "host_tags row should cascade away");
}

#[test]
fn set_tags_replaces_rather_than_appends() {
    let s = store();
    let host = s
        .hosts()
        .create(&NewHost::manual("h", "example.com"))
        .expect("host");
    let a = s.tags().get_or_create("a", None).expect("a");
    let b = s.tags().get_or_create("b", None).expect("b");

    s.hosts().set_tags(host, &[a, b]).expect("set both");
    s.hosts().set_tags(host, &[a]).expect("narrow to one");
    assert_eq!(
        s.hosts().get(host).expect("get").expect("exists").tags,
        vec![a]
    );
}

#[test]
fn deleting_a_host_cascades_its_tag_links() {
    let s = store();
    let host = s
        .hosts()
        .create(&NewHost::manual("h", "example.com"))
        .expect("host");
    let tag = s.tags().get_or_create("t", None).expect("tag");
    s.hosts().set_tags(host, &[tag]).expect("set tags");

    s.hosts().delete(host).expect("delete host");
    // The tag itself survives; only the link goes.
    assert_eq!(s.tags().list().expect("list").len(), 1);
}

#[test]
fn filter_matches_name_hostname_and_username() {
    let s = store();
    let mut a = NewHost::manual("alpha", "alpha.example.com");
    a.username = "root".into();
    let mut b = NewHost::manual("beta", "beta.internal");
    b.username = "deploy".into();
    s.hosts().create(&a).expect("a");
    s.hosts().create(&b).expect("b");

    let by_name = s
        .hosts()
        .list(&HostFilter {
            query: Some("alph".into()),
            ..HostFilter::default()
        })
        .expect("query");
    assert_eq!(by_name.len(), 1);

    let by_hostname = s
        .hosts()
        .list(&HostFilter {
            query: Some("internal".into()),
            ..HostFilter::default()
        })
        .expect("query");
    assert_eq!(by_hostname.len(), 1);

    let by_username = s
        .hosts()
        .list(&HostFilter {
            query: Some("deploy".into()),
            ..HostFilter::default()
        })
        .expect("query");
    assert_eq!(by_username.len(), 1);
}

#[test]
fn filter_treats_typed_wildcards_as_literal_text() {
    // Someone searching for "100%" must not get every host back.
    let s = store();
    s.hosts()
        .create(&NewHost::manual("alpha", "alpha.example.com"))
        .expect("a");
    s.hosts()
        .create(&NewHost::manual("100% uptime", "b.example.com"))
        .expect("b");

    let hits = s
        .hosts()
        .list(&HostFilter {
            query: Some("100%".into()),
            ..HostFilter::default()
        })
        .expect("query");
    assert_eq!(hits.len(), 1, "LIKE wildcard was not escaped");
    assert_eq!(hits[0].name, "100% uptime");
}

#[test]
fn tag_filter_requires_every_listed_tag() {
    let s = store();
    let both = s
        .hosts()
        .create(&NewHost::manual("both", "both.example.com"))
        .expect("both");
    let one = s
        .hosts()
        .create(&NewHost::manual("one", "one.example.com"))
        .expect("one");
    let prod = s.tags().get_or_create("prod", None).expect("prod");
    let db = s.tags().get_or_create("db", None).expect("db");
    s.hosts().set_tags(both, &[prod, db]).expect("tags");
    s.hosts().set_tags(one, &[prod]).expect("tags");

    let hits = s
        .hosts()
        .list(&HostFilter {
            tag_ids: vec![prod, db],
            ..HostFilter::default()
        })
        .expect("query");
    assert_eq!(hits.len(), 1, "AND semantics expected, not OR");
    assert_eq!(hits[0].id, both);
}

#[test]
fn recording_a_connection_bumps_count_and_timestamp() {
    let s = store();
    let id = s
        .hosts()
        .create(&NewHost::manual("h", "example.com"))
        .expect("host");
    s.hosts()
        .record_connection(id, 1_700_000_000)
        .expect("record");
    s.hosts()
        .record_connection(id, 1_700_000_100)
        .expect("record");

    let got = s.hosts().get(id).expect("get").expect("exists");
    assert_eq!(got.connect_count, 2);
    assert_eq!(got.last_connected_at, Some(1_700_000_100));
}

#[test]
fn ssh_config_hosts_are_unique_by_alias_but_manual_ones_are_not() {
    let s = store();
    let mut imported = NewHost::manual("web", "web.example.com");
    imported.source = HostSource::SshConfig;
    imported.source_alias = Some("web".into());
    s.hosts().create(&imported).expect("first import");

    assert!(
        s.hosts().create(&imported).is_err(),
        "re-importing the same alias should collide so the caller upserts"
    );

    // The partial index must not constrain hand-made hosts.
    let mut manual = NewHost::manual("web", "web.example.com");
    manual.source_alias = Some("web".into());
    s.hosts()
        .create(&manual)
        .expect("manual host with the same alias is unconstrained");

    let found = s
        .hosts()
        .find_by_source_alias("web")
        .expect("lookup")
        .expect("imported host found");
    assert_eq!(found.source, HostSource::SshConfig);
}

#[test]
fn settings_round_trip_as_typed_json() {
    let s = store();
    s.settings()
        .set("reconnect.enabled", &true)
        .expect("set bool");
    s.settings()
        .set("reconnect.max_attempts", &10_u32)
        .expect("set int");
    s.settings()
        .set("terminal.font", &"JetBrains Mono".to_string())
        .expect("set string");

    assert_eq!(
        s.settings().get::<bool>("reconnect.enabled").expect("get"),
        Some(true)
    );
    assert_eq!(
        s.settings()
            .get::<u32>("reconnect.max_attempts")
            .expect("get"),
        Some(10)
    );
    assert_eq!(s.settings().get::<bool>("missing").expect("get"), None);
    assert!(s.settings().get_or("missing", true).expect("get_or"));
}

#[test]
fn setting_the_same_key_twice_updates_rather_than_erroring() {
    let s = store();
    s.settings().set("k", &1_u32).expect("first");
    s.settings().set("k", &2_u32).expect("second");
    assert_eq!(s.settings().get::<u32>("k").expect("get"), Some(2));
    assert_eq!(s.settings().all_raw().expect("all").len(), 1);
}

#[test]
fn auth_fallbacks_round_trip_through_create_and_update() {
    let s = store();
    let mut draft = NewHost::manual("h", "example.com");
    draft.auth = AuthKind::Agent;
    draft.auth_fallbacks = vec![AuthKind::KeyFile, AuthKind::Password];
    let id = s.hosts().create(&draft).expect("create");

    let mut host = s.hosts().get(id).expect("get").expect("exists");
    assert_eq!(
        host.auth_fallbacks,
        vec![AuthKind::KeyFile, AuthKind::Password],
        "order is the whole point of the chain and must survive storage"
    );

    host.auth_fallbacks = vec![AuthKind::Password];
    s.hosts().update(&host).expect("update");
    let reread = s.hosts().get(id).expect("get").expect("exists");
    assert_eq!(reread.auth_fallbacks, vec![AuthKind::Password]);
}

/// Hosts created before fallbacks existed — and every host created without
/// them since — must keep trying exactly one method.
#[test]
fn a_host_without_fallbacks_reads_back_with_an_empty_chain() {
    let s = store();
    let id = s
        .hosts()
        .create(&NewHost::manual("h", "example.com"))
        .expect("create");
    let host = s.hosts().get(id).expect("get").expect("exists");
    assert!(host.auth_fallbacks.is_empty());
}

/// A fallback this build does not recognise costs the fallback, not the host.
/// The likely writer is a newer version, and an unreadable row would be a far
/// worse outcome than a shorter chain.
#[test]
fn an_unknown_stored_fallback_is_dropped_rather_than_failing_the_read() {
    use tern_core_store::{decode_auth_fallbacks, encode_auth_fallbacks};

    assert_eq!(
        decode_auth_fallbacks(Some("agent,keyboard_interactive,password")),
        vec![AuthKind::Agent, AuthKind::Password]
    );
    assert!(decode_auth_fallbacks(None).is_empty());
    // Empty encodes to NULL, so "no fallback" is never stored as data.
    assert_eq!(encode_auth_fallbacks(&[]), None);
}

fn snippet(name: &str, body: &str) -> NewSnippet {
    NewSnippet {
        name: name.into(),
        body: body.into(),
        description: None,
    }
}

#[test]
fn snippet_round_trips_through_create_and_get() {
    let s = store();
    let draft = NewSnippet {
        name: "tail syslog".into(),
        body: "tail -f /var/log/syslog".into(),
        description: Some("follow the system log".into()),
    };
    let id = s.snippets().create(&draft).expect("create");
    let got = s.snippets().get(id).expect("get").expect("exists");

    assert_eq!(got.name, "tail syslog");
    assert_eq!(got.body, "tail -f /var/log/syslog");
    assert_eq!(got.description.as_deref(), Some("follow the system log"));
    // Created and updated are stamped together, so an untouched snippet reads
    // back with them equal.
    assert_eq!(got.created_at, got.updated_at);
}

#[test]
fn snippets_list_by_name_case_insensitively() {
    let s = store();
    for name in ["zebra", "Alpha", "middle"] {
        s.snippets().create(&snippet(name, "x")).expect("create");
    }
    let names: Vec<String> = s
        .snippets()
        .list()
        .expect("list")
        .into_iter()
        .map(|x| x.name)
        .collect();
    assert_eq!(names, vec!["Alpha", "middle", "zebra"]);
}

#[test]
fn updating_a_snippet_replaces_the_whole_record() {
    let s = store();
    let id = s.snippets().create(&snippet("old", "one")).expect("create");
    let mut got = s.snippets().get(id).expect("get").expect("exists");
    got.name = "new".into();
    got.body = "two".into();
    got.description = Some("now described".into());
    s.snippets().update(&got).expect("update");

    let after = s.snippets().get(id).expect("get").expect("exists");
    assert_eq!(after.name, "new");
    assert_eq!(after.body, "two");
    assert_eq!(after.description.as_deref(), Some("now described"));
}

/// The name is all the palette can show, so a blank one is refused rather than
/// stored as a row nobody can find again.
#[test]
fn a_snippet_needs_a_name() {
    let s = store();
    assert!(matches!(
        s.snippets().create(&snippet("   ", "x")),
        Err(StoreError::Invalid(_))
    ));
}

#[test]
fn deleting_an_unknown_snippet_is_an_error_not_a_silent_no_op() {
    let s = store();
    assert!(matches!(
        s.snippets().delete(999),
        Err(StoreError::NotFound { .. })
    ));
}
