use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use pi_remote_control::event_hub::{EventHub, EventHubConfig};
use pi_remote_control::principal::Principal;
use pi_remote_control::project_catalog::{
    ProjectCatalog, ProjectCatalogConfig, ProjectCatalogError, MAX_TREE_ENTRIES_PER_PAGE,
};
use pi_remote_control::protocol::{
    RemoteTaskCreateRequest, RemoteTaskFailureCode, RemoteTaskState,
};
use pi_remote_control::task_manager::TaskManager;

fn temp_project(label: &str) -> PathBuf {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock after epoch")
        .as_nanos();
    let root = std::env::temp_dir().join(format!("pi-remote-{label}-{nonce}"));
    fs::create_dir_all(&root).expect("create fixture root");
    root
}

fn request(request_id: &str, project_id: &str) -> RemoteTaskCreateRequest {
    RemoteTaskCreateRequest {
        request_id: request_id.to_owned(),
        project_id: project_id.to_owned(),
        prompt: "inspect the selected project".to_owned(),
        context_files: Vec::new(),
        execution_profile: None,
    }
}

fn owner() -> Principal {
    Principal::v1("device-a", 1).expect("valid principal")
}

#[test]
fn allowlist_returns_only_opaque_project_metadata() {
    let root = temp_project("opaque");
    fs::create_dir(root.join("src")).expect("src directory");
    let catalog = ProjectCatalog::new(ProjectCatalogConfig::default());
    let summary = catalog
        .allow_project(&root, "Fixture project", None)
        .expect("allow project");

    assert!(summary.project_id.starts_with("project-"));
    assert!(!summary
        .project_id
        .contains(&root.to_string_lossy().to_string()));
    assert_eq!(summary.name, "Fixture project");
    assert_eq!(catalog.list_projects(), vec![summary.clone()]);
    assert!(catalog.project_summary("project-does-not-exist").is_err());

    fs::remove_dir_all(root).expect("remove fixture");
}

#[test]
fn tree_is_denied_bounded_and_cursor_is_opaque() {
    let root = temp_project("tree");
    for index in 0..205 {
        fs::write(root.join(format!("file-{index:03}.txt")), b"fixture").expect("file");
    }
    fs::write(root.join(".env"), b"secret").expect("env");
    fs::write(root.join("private.pem"), b"secret").expect("pem");
    fs::create_dir(root.join("node_modules")).expect("denied directory");
    fs::write(root.join("node_modules").join("hidden.txt"), b"hidden").expect("hidden");

    let catalog = ProjectCatalog::new(ProjectCatalogConfig::default());
    let summary = catalog
        .allow_project(&root, "Tree fixture", None)
        .expect("allow project");
    let first = catalog
        .tree(&summary.project_id, "", None)
        .expect("first page");
    assert_eq!(first.entries.len(), MAX_TREE_ENTRIES_PER_PAGE);
    assert!(first.next_cursor.is_some());
    assert!(first
        .entries
        .iter()
        .all(|entry| !entry.relative_path.starts_with(".env")
            && !entry.relative_path.contains("node_modules")));
    let cursor = first.next_cursor.as_deref().expect("next cursor");
    assert!(!cursor.contains(&root.to_string_lossy().to_string()));
    let second = catalog
        .tree(&summary.project_id, "", Some(cursor))
        .expect("second page");
    assert!(!second.entries.is_empty());
    assert!(second.next_cursor.is_none());

    fs::remove_dir_all(root).expect("remove fixture");
}

#[test]
fn directory_mutation_invalidates_previous_cursor() {
    let root = temp_project("cursor-generation");
    for index in 0..201 {
        fs::write(root.join(format!("file-{index:03}.txt")), b"fixture").expect("file");
    }
    let catalog = ProjectCatalog::new(ProjectCatalogConfig::default());
    let summary = catalog
        .allow_project(&root, "Cursor fixture", None)
        .expect("allow project");
    let first = catalog
        .tree(&summary.project_id, "", None)
        .expect("first page");
    let cursor = first.next_cursor.expect("cursor");
    fs::write(root.join("new-entry.txt"), b"changed").expect("mutate directory");
    assert_eq!(
        catalog.tree(&summary.project_id, "", Some(&cursor)),
        Err(ProjectCatalogError::InvalidCursor)
    );
    fs::remove_dir_all(root).expect("remove fixture");
}

#[test]
fn traversal_absolute_and_denied_context_paths_fail_without_root_disclosure() {
    let root = temp_project("paths");
    fs::write(root.join("safe.txt"), b"safe").expect("safe file");
    fs::write(root.join(".envrc"), b"secret").expect("env file");
    let catalog = ProjectCatalog::new(ProjectCatalogConfig::default());
    let summary = catalog
        .allow_project(&root, "Path fixture", None)
        .expect("allow project");

    let cases = [
        "../outside.txt",
        "C:\\Windows\\win.ini",
        "/etc/passwd",
        "safe.txt/../x",
        "file.txt:secret",
        "CON.txt",
    ];
    for path in cases {
        let error = catalog
            .resolve_context_file(&summary.project_id, path)
            .expect_err("unsafe path must fail");
        assert!(!error
            .to_string()
            .contains(&root.to_string_lossy().to_string()));
    }
    assert_eq!(
        catalog.resolve_context_file(&summary.project_id, ".envrc"),
        Err(ProjectCatalogError::DeniedEntry)
    );
    assert!(catalog
        .resolve_context_file(&summary.project_id, "safe.txt")
        .is_ok());

    fs::remove_dir_all(root).expect("remove fixture");
}

#[test]
fn project_removal_invalidates_id_and_revokes_queued_and_active_tasks() {
    let root = temp_project("revoke");
    let catalog = ProjectCatalog::new(ProjectCatalogConfig::default());
    let summary = catalog
        .allow_project(&root, "Revocation fixture", None)
        .expect("allow project");
    let hub = EventHub::new(EventHubConfig::default()).expect("event hub");
    let manager = TaskManager::new(hub);
    let principal = owner();
    let queued = manager
        .submit(&principal, request("queued", &summary.project_id))
        .expect("queued task")
        .snapshot;
    let active = manager
        .submit(&principal, request("active", &summary.project_id))
        .expect("active task")
        .snapshot;
    manager
        .start(&principal, &active.task_id)
        .expect("start active");
    let revoked = catalog
        .remove_project_and_revoke(&summary.project_id, &manager)
        .expect("revoke project");

    assert_eq!(revoked.summary.project_id, summary.project_id);
    assert_eq!(revoked.revoked_tasks.len(), 2);
    let queued_snapshot = revoked
        .revoked_tasks
        .iter()
        .find(|task| task.task_id == queued.task_id)
        .expect("queued snapshot");
    assert_eq!(queued_snapshot.state, RemoteTaskState::Failed);
    assert_eq!(
        queued_snapshot.error.as_ref().map(|error| &error.code),
        Some(&RemoteTaskFailureCode::ProjectRevoked)
    );
    let active_snapshot = revoked
        .revoked_tasks
        .iter()
        .find(|task| task.task_id == active.task_id)
        .expect("active snapshot");
    assert_eq!(active_snapshot.state, RemoteTaskState::Cancelled);
    assert_eq!(
        catalog.project_summary(&summary.project_id),
        Err(ProjectCatalogError::ProjectNotFound)
    );
    assert_eq!(
        catalog.tree(&summary.project_id, "", None),
        Err(ProjectCatalogError::ProjectNotFound)
    );

    fs::remove_dir_all(root).expect("remove fixture");
}

#[test]
fn desktop_project_replacement_is_single_project_and_rollback_safe() {
    let first = temp_project("desktop-current-first");
    let second = temp_project("desktop-current-second");
    let replacement = temp_project("desktop-current-replacement");
    fs::create_dir_all(&first).expect("first project");
    fs::create_dir_all(&second).expect("second project");
    fs::create_dir_all(&replacement).expect("replacement project");
    let catalog = ProjectCatalog::new(ProjectCatalogConfig::default());
    let first_summary = catalog
        .allow_project(&first, "first", None)
        .expect("allow first");
    let second_summary = catalog
        .allow_project(&second, "second", None)
        .expect("allow second");

    let (current, previous) = catalog
        .replace_with_single_project(&replacement, "replacement", None)
        .expect("replace with desktop project");
    assert_eq!(catalog.list_projects(), vec![current]);
    assert_eq!(previous.len(), 2);
    assert_eq!(
        catalog.project_summary(&first_summary.project_id),
        Err(ProjectCatalogError::ProjectNotFound)
    );

    catalog
        .replace_with_persisted_projects(previous)
        .expect("restore prior catalog");
    let restored = catalog.list_projects();
    assert_eq!(restored.len(), 2);
    assert!(restored
        .iter()
        .any(|project| project.project_id == first_summary.project_id));
    assert!(restored
        .iter()
        .any(|project| project.project_id == second_summary.project_id));

    fs::remove_dir_all(first).expect("remove first");
    fs::remove_dir_all(second).expect("remove second");
    fs::remove_dir_all(replacement).expect("remove replacement");
}

#[cfg(any(unix, windows))]
#[test]
fn symlink_escape_is_not_a_context_file() {
    let root = temp_project("symlink");
    let outside = temp_project("outside");
    fs::write(outside.join("secret.txt"), b"secret").expect("outside file");
    let link = root.join("escape.txt");
    let created = {
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(outside.join("secret.txt"), &link).is_ok()
        }
        #[cfg(windows)]
        {
            std::os::windows::fs::symlink_file(outside.join("secret.txt"), &link).is_ok()
        }
    };
    if created {
        let catalog = ProjectCatalog::new(ProjectCatalogConfig::default());
        let summary = catalog
            .allow_project(&root, "Symlink fixture", None)
            .expect("allow project");
        assert!(matches!(
            catalog.resolve_context_file(&summary.project_id, "escape.txt"),
            Err(ProjectCatalogError::PathPolicy) | Err(ProjectCatalogError::ReparsePoint)
        ));
    }
    fs::remove_dir_all(root).expect("remove root");
    fs::remove_dir_all(outside).expect("remove outside");
}
