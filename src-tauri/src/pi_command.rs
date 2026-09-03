//! Cross-platform Pi runtime discovery and command construction.

use std::collections::HashSet;
use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::process::Command;

const PI_PACKAGE_PARTS: [&str; 2] = ["@earendil-works", "pi-coding-agent"];

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PiRuntimeSource {
    Explicit,
    Path,
    ManagedInstall,
    StandardLocation,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PiInstallKind {
    Managed,
    Npm,
    Standalone,
    NpmFallback,
    Unknown,
}

/// One coherent Pi installation. Package and Node resolution are anchored to
/// the selected Pi executable before falling back to deterministic host paths.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PiRuntime {
    pub pi_executable: PathBuf,
    pub node_executable: Option<PathBuf>,
    pub package_root: Option<PathBuf>,
    pub source: PiRuntimeSource,
    pub install_kind: PiInstallKind,
}

impl PiRuntime {
    pub fn discover(explicit_pi: Option<&str>) -> Result<Self, String> {
        discover_pi_runtime_from(explicit_pi, &DiscoveryContext::from_env())
    }

    pub fn dist_index(&self) -> Result<PathBuf, String> {
        let package = self.package_root.as_ref().ok_or_else(|| {
            format!(
                "Pi CLI was found at `{}`, but its JavaScript package could not be located. Reinstall Pi with `npm install -g @earendil-works/pi-coding-agent`.",
                self.pi_executable.display()
            )
        })?;
        let entry = package.join("dist").join("index.js");
        entry.is_file().then_some(entry).ok_or_else(|| {
            format!(
                "Pi package was found at `{}`, but `dist/index.js` is missing. Reinstall Pi.",
                package.display()
            )
        })
    }

    pub fn require_node(&self) -> Result<&Path, String> {
        self.node_executable.as_deref().ok_or_else(|| {
            format!(
                "Pi CLI was found at `{}`, but Node.js could not be located. Install Node.js 22.19.0 or newer and restart Pi.",
                self.pi_executable.display()
            )
        })
    }

    /// PATH used by Pi and Node child processes.
    pub fn runtime_path(&self) -> Option<OsString> {
        let mut directories = Vec::new();
        if let Some(parent) = self.node_executable.as_deref().and_then(Path::parent) {
            directories.push(parent.to_path_buf());
        }
        if let Some(parent) = self.pi_executable.parent() {
            directories.push(parent.to_path_buf());
        }
        if let Some(path) = std::env::var_os("PATH") {
            directories.extend(std::env::split_paths(&path));
        }
        deduplicate_paths(&mut directories);
        std::env::join_paths(directories).ok()
    }

    /// Ensure `/usr/bin/env node` shims and Pi-spawned npm CLIs see the same
    /// runtime even when a macOS app inherits Finder's restricted PATH.
    pub fn configure_command(&self, command: &mut Command) {
        if let Some(path) = self.runtime_path() {
            command.env("PATH", path);
        }
    }

    pub fn command(&self) -> Command {
        let mut command = Command::new(&self.pi_executable);
        self.configure_command(&mut command);
        command
    }
}

#[derive(Clone, Debug)]
struct DiscoveryContext {
    home: Option<PathBuf>,
    pi_agent_dir: Option<PathBuf>,
    xdg_data_home: Option<PathBuf>,
    path: OsString,
    #[cfg(windows)]
    path_ext: OsString,
    #[cfg(windows)]
    appdata: Option<PathBuf>,
}

impl DiscoveryContext {
    fn from_env() -> Self {
        Self {
            home: home_dir(),
            pi_agent_dir: std::env::var_os("PI_CODING_AGENT_DIR").map(PathBuf::from),
            xdg_data_home: std::env::var_os("XDG_DATA_HOME").map(PathBuf::from),
            path: std::env::var_os("PATH").unwrap_or_default(),
            #[cfg(windows)]
            path_ext: std::env::var_os("PATHEXT").unwrap_or_else(|| ".COM;.EXE;.BAT;.CMD".into()),
            #[cfg(windows)]
            appdata: std::env::var_os("APPDATA").map(PathBuf::from),
        }
    }
}

pub fn pi_command(binary: Option<&str>) -> Result<Command, String> {
    Ok(PiRuntime::discover(binary)?.command())
}

/// Construct a Pi command, optionally using an explicitly configured binary.
pub fn command(binary: Option<&str>) -> Result<Command, String> {
    pi_command(binary)
}

/// Resolve a bare program name to an executable path using the inherited PATH.
/// Windows also searches `PATHEXT` and `%APPDATA%\\npm` for npm shims.
pub fn resolve_executable(binary: &str) -> Option<PathBuf> {
    resolve_executable_from(binary, &DiscoveryContext::from_env())
}

fn discover_pi_runtime_from(
    explicit_pi: Option<&str>,
    context: &DiscoveryContext,
) -> Result<PiRuntime, String> {
    let explicit = explicit_pi.filter(|value| !value.trim().is_empty());
    if let Some(binary) = explicit {
        let pi = resolve_executable_from(binary, context).ok_or_else(|| {
            format!("Configured Pi CLI `{binary}` was not found or is not executable.")
        })?;
        return Ok(runtime_from_pi(pi, PiRuntimeSource::Explicit, context));
    }

    if let Some(pi) = resolve_executable_from("pi", context) {
        return Ok(runtime_from_pi(pi, PiRuntimeSource::Path, context));
    }

    for (candidate, source) in standard_pi_candidates(context) {
        if is_executable_file(&candidate) {
            return Ok(runtime_from_pi(candidate, source, context));
        }
    }

    Err("Pi CLI was not found on PATH or in supported install locations (managed install, user-local bins, standalone pi-node, Homebrew, or the Windows npm prefix). Install it with `npm install -g @earendil-works/pi-coding-agent` and restart Pi.".into())
}

fn runtime_from_pi(
    pi_executable: PathBuf,
    source: PiRuntimeSource,
    context: &DiscoveryContext,
) -> PiRuntime {
    let managed_package = managed_package_for_pi(&pi_executable);
    let local_package = managed_package
        .clone()
        .or_else(|| package_root_from_pi(&pi_executable))
        .or_else(|| package_root_from_layout(&pi_executable));
    let (package_root, install_kind) = if let Some(package) = local_package {
        let kind = if managed_package.is_some() {
            PiInstallKind::Managed
        } else {
            classify_local_install(&pi_executable, &package)
        };
        (Some(package), kind)
    } else if let Some(package) = npm_global_package(&pi_executable, context) {
        (Some(package), PiInstallKind::NpmFallback)
    } else {
        (None, PiInstallKind::Unknown)
    };
    let source = if managed_package.is_some() {
        PiRuntimeSource::ManagedInstall
    } else {
        source
    };
    let node_executable = find_node_for_runtime(&pi_executable, package_root.as_deref(), context);
    PiRuntime {
        pi_executable,
        node_executable,
        package_root,
        source,
        install_kind,
    }
}

fn standard_pi_candidates(context: &DiscoveryContext) -> Vec<(PathBuf, PiRuntimeSource)> {
    let mut candidates = Vec::new();
    if let Some(agent_dir) = &context.pi_agent_dir {
        add_pi_directory(
            &mut candidates,
            agent_dir.join("bin"),
            PiRuntimeSource::StandardLocation,
            context,
        );
    }
    if let Some(home) = &context.home {
        add_pi_directory(
            &mut candidates,
            home.join(".pi").join("agent").join("bin"),
            PiRuntimeSource::ManagedInstall,
            context,
        );
        for directory in [
            home.join(".local").join("bin"),
            home.join("bin"),
            home.join(".bin"),
            home.join("local").join("bin"),
            home.join(".npm-global").join("bin"),
        ] {
            add_pi_directory(
                &mut candidates,
                directory,
                PiRuntimeSource::StandardLocation,
                context,
            );
        }
    }
    if let Some(data_home) = data_home(context) {
        add_pi_directory(
            &mut candidates,
            data_home.join("pi-node").join("current").join("bin"),
            PiRuntimeSource::StandardLocation,
            context,
        );
    }
    #[cfg(windows)]
    if let Some(appdata) = &context.appdata {
        add_pi_directory(
            &mut candidates,
            appdata.join("npm"),
            PiRuntimeSource::StandardLocation,
            context,
        );
    }
    #[cfg(not(windows))]
    for directory in ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"] {
        add_pi_directory(
            &mut candidates,
            PathBuf::from(directory),
            PiRuntimeSource::StandardLocation,
            context,
        );
    }
    candidates
}

fn add_pi_directory(
    candidates: &mut Vec<(PathBuf, PiRuntimeSource)>,
    directory: PathBuf,
    source: PiRuntimeSource,
    context: &DiscoveryContext,
) {
    candidates.extend(
        program_candidates_in(&directory, "pi", context)
            .into_iter()
            .map(|candidate| (candidate, source)),
    );
}

fn package_root_from_pi(pi: &Path) -> Option<PathBuf> {
    let real = std::fs::canonicalize(pi).ok()?;
    real.ancestors()
        .find(|ancestor| is_pi_package_root(ancestor))
        .map(Path::to_path_buf)
}

fn package_root_from_layout(pi: &Path) -> Option<PathBuf> {
    let bin = pi.parent()?;
    let prefix = bin.parent();
    let mut roots = vec![bin.join("node_modules")];
    if let Some(prefix) = prefix {
        roots.push(prefix.join("node_modules"));
        roots.push(prefix.join("lib").join("node_modules"));
    }
    roots
        .into_iter()
        .map(|root| pi_package_in(&root))
        .find(|package| is_pi_package_root(package))
}

fn classify_local_install(pi: &Path, package: &Path) -> PiInstallKind {
    let Some(node_modules) = package.parent().and_then(Path::parent) else {
        return PiInstallKind::Unknown;
    };
    let pi_bin = pi.parent();
    let package_prefix = node_modules.parent();
    if package_prefix == pi_bin {
        return PiInstallKind::Npm;
    }
    if package_prefix.and_then(Path::file_name) == Some(OsStr::new("lib"))
        && package_prefix.and_then(Path::parent) == pi_bin.and_then(Path::parent)
    {
        PiInstallKind::Npm
    } else {
        PiInstallKind::Standalone
    }
}

fn npm_global_package(pi: &Path, context: &DiscoveryContext) -> Option<PathBuf> {
    let npm = resolve_executable_from("npm", context)?;
    let mut command = Command::new(npm);
    command.args(["root", "-g"]);
    command.env("PATH", &context.path);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    let output = command.output().ok()?;
    if !output.status.success() {
        return None;
    }
    let root = String::from_utf8(output.stdout).ok()?;
    let node_modules = PathBuf::from(root.trim());
    if node_modules.as_os_str().is_empty() {
        return None;
    }
    let package = pi_package_in(&node_modules);
    if !is_pi_package_root(&package) {
        return None;
    }

    // `npm root -g` is only accepted when that prefix owns the selected Pi
    // executable. This keeps the compatibility fallback from mixing installs.
    let prefix = node_modules.parent()?;
    let mut bin_directories = vec![prefix.to_path_buf(), prefix.join("bin")];
    if prefix.file_name() == Some(OsStr::new("lib")) {
        if let Some(root_prefix) = prefix.parent() {
            bin_directories.push(root_prefix.join("bin"));
        }
    }
    bin_directories
        .into_iter()
        .flat_map(|directory| program_candidates_in(&directory, "pi", context))
        .any(|candidate| is_executable_file(&candidate) && same_executable(pi, &candidate))
        .then_some(package)
}

fn same_executable(left: &Path, right: &Path) -> bool {
    if left == right {
        return true;
    }
    match (std::fs::canonicalize(left), std::fs::canonicalize(right)) {
        (Ok(left), Ok(right)) => left == right,
        _ => false,
    }
}

fn managed_package_for_pi(pi: &Path) -> Option<PathBuf> {
    let real = std::fs::canonicalize(pi).unwrap_or_else(|_| pi.to_path_buf());
    for executable in [pi, real.as_path()] {
        let agent = executable.parent()?.parent()?;
        let install = agent.join("install");
        if !valid_managed_marker(&install.join("managed-install.json")) {
            continue;
        }
        let version = std::fs::read_to_string(install.join("current-version")).ok()?;
        let version = version.trim();
        if !valid_managed_version(version) {
            continue;
        }
        let package = pi_package_in(&install.join("releases").join(version).join("node_modules"));
        if is_pi_package_root(&package) {
            return Some(package);
        }
    }
    None
}

fn valid_managed_marker(marker: &Path) -> bool {
    let Ok(source) = std::fs::read_to_string(marker) else {
        return false;
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&source) else {
        return false;
    };
    value.get("kind").and_then(|value| value.as_str()) == Some("pi-managed-install")
        && value.get("schemaVersion").and_then(|value| value.as_u64()) == Some(1)
        && value.get("layout").and_then(|value| value.as_str()) == Some("releases-v1")
}

fn valid_managed_version(version: &str) -> bool {
    !version.is_empty()
        && version != "."
        && version != ".."
        && version
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._+-".contains(&byte))
}

fn is_pi_package_root(path: &Path) -> bool {
    path.file_name() == Some(OsStr::new(PI_PACKAGE_PARTS[1]))
        && path.parent().and_then(Path::file_name) == Some(OsStr::new(PI_PACKAGE_PARTS[0]))
        && path.join("dist").join("index.js").is_file()
}

fn pi_package_in(node_modules: &Path) -> PathBuf {
    node_modules
        .join(PI_PACKAGE_PARTS[0])
        .join(PI_PACKAGE_PARTS[1])
}

fn data_home(context: &DiscoveryContext) -> Option<PathBuf> {
    context
        .xdg_data_home
        .clone()
        .or_else(|| context.home.as_ref().map(|home| home.join(".local/share")))
}

fn find_node_for_runtime(
    pi: &Path,
    package_root: Option<&Path>,
    context: &DiscoveryContext,
) -> Option<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(bin) = pi.parent() {
        candidates.extend(program_candidates_in(bin, "node", context));
    }
    if let Some(package) = package_root {
        if let Some(node_modules) = package.parent().and_then(Path::parent) {
            if node_modules.file_name() == Some(OsStr::new("node_modules")) {
                if let Some(parent) = node_modules.parent() {
                    let prefix = if parent.file_name() == Some(OsStr::new("lib")) {
                        parent.parent()
                    } else {
                        Some(parent)
                    };
                    if let Some(prefix) = prefix {
                        candidates.extend(program_candidates_in(
                            &prefix.join("bin"),
                            "node",
                            context,
                        ));
                    }
                }
            }
        }
    }
    if let Some(data_home) = data_home(context) {
        candidates.extend(program_candidates_in(
            &data_home.join("pi-node").join("current").join("bin"),
            "node",
            context,
        ));
    }
    if let Some(node) = resolve_executable_from("node", context) {
        candidates.push(node);
    }
    #[cfg(not(windows))]
    for directory in ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"] {
        candidates.push(PathBuf::from(directory).join("node"));
    }
    candidates.into_iter().find(|path| is_executable_file(path))
}

fn resolve_executable_from(binary: &str, context: &DiscoveryContext) -> Option<PathBuf> {
    let requested = Path::new(binary);
    if requested.components().count() > 1 || requested.is_absolute() {
        return is_executable_file(requested).then(|| requested.to_path_buf());
    }

    for directory in std::env::split_paths(&context.path) {
        for candidate in program_candidates_in(&directory, binary, context) {
            if is_executable_file(&candidate) {
                return Some(candidate);
            }
        }
    }
    #[cfg(windows)]
    if let Some(appdata) = &context.appdata {
        for candidate in program_candidates_in(&appdata.join("npm"), binary, context) {
            if is_executable_file(&candidate) {
                return Some(candidate);
            }
        }
    }
    None
}

#[cfg(windows)]
fn program_candidates_in(
    directory: &Path,
    binary: &str,
    context: &DiscoveryContext,
) -> Vec<PathBuf> {
    let requested = Path::new(binary);
    if requested.extension().is_some() {
        vec![directory.join(requested)]
    } else {
        windows_program_names(binary, &context.path_ext)
            .into_iter()
            .map(|name| directory.join(name))
            .collect()
    }
}

#[cfg(not(windows))]
fn program_candidates_in(
    directory: &Path,
    binary: &str,
    _context: &DiscoveryContext,
) -> Vec<PathBuf> {
    vec![directory.join(binary)]
}

#[cfg(windows)]
fn windows_program_names(binary: &str, path_ext: &OsStr) -> Vec<OsString> {
    path_ext
        .to_string_lossy()
        .split(';')
        .filter_map(|extension| {
            let extension = extension.trim();
            if extension.is_empty() {
                None
            } else if extension.starts_with('.') {
                Some(OsString::from(format!(
                    "{binary}{}",
                    extension.to_ascii_lowercase()
                )))
            } else {
                Some(OsString::from(format!(
                    "{binary}.{}",
                    extension.to_ascii_lowercase()
                )))
            }
        })
        .collect()
}

#[cfg(unix)]
fn is_executable_file(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    path.metadata()
        .map(|metadata| metadata.is_file() && metadata.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

#[cfg(windows)]
fn is_executable_file(path: &Path) -> bool {
    path.is_file()
}

fn home_dir() -> Option<PathBuf> {
    #[cfg(windows)]
    let home = std::env::var_os("USERPROFILE");
    #[cfg(not(windows))]
    let home = std::env::var_os("HOME");
    home.map(PathBuf::from)
}

#[cfg(not(windows))]
fn deduplicate_paths(paths: &mut Vec<PathBuf>) {
    let mut seen = HashSet::new();
    paths.retain(|path| seen.insert(path.clone()));
}

#[cfg(windows)]
fn deduplicate_paths(paths: &mut Vec<PathBuf>) {
    let mut seen = HashSet::new();
    paths.retain(|path| {
        let mut key = path.to_string_lossy().replace('/', "\\").to_lowercase();
        if key.len() > 3 {
            key = key.trim_end_matches('\\').to_owned();
        }
        seen.insert(key)
    });
}

/// Best-effort location of npm's global bin directory.
fn npm_bin_dir() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        std::env::var_os("APPDATA").map(|value| PathBuf::from(value).join("npm"))
    }
    #[cfg(not(windows))]
    {
        let home = home_dir()?;
        [
            home.join(".npm-global").join("bin"),
            home.join(".local").join("bin"),
        ]
        .into_iter()
        .find(|candidate| candidate.is_dir())
    }
}

fn with_npm_bin_prepended(path: &OsStr, npm_bin: &Path) -> Option<OsString> {
    let mut directories: Vec<PathBuf> = std::env::split_paths(path).collect();
    if directories.iter().any(|directory| directory == npm_bin) {
        return None;
    }
    directories.insert(0, npm_bin.to_path_buf());
    std::env::join_paths(directories).ok()
}

pub fn prepend_npm_bin_to_path(command: &mut Command) {
    let Some(npm_bin) = npm_bin_dir() else {
        return;
    };
    let configured_path = command.get_envs().find_map(|(key, value)| {
        if key == "PATH" {
            value.map(OsStr::to_os_string)
        } else {
            None
        }
    });
    let Some(path) = configured_path.or_else(|| std::env::var_os("PATH")) else {
        return;
    };
    if let Some(joined) = with_npm_bin_prepended(&path, &npm_bin) {
        command.env("PATH", joined);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_dir(label: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory = std::env::temp_dir().join(format!("pi-desktop-{label}-{nonce}"));
        fs::create_dir_all(&directory).unwrap();
        directory
    }

    fn touch(path: &Path) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(path, []).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
        }
    }

    fn package(root: &Path) -> PathBuf {
        let package = pi_package_in(root);
        touch(&package.join("dist/index.js"));
        package
    }

    fn context(home: &Path, path: &Path) -> DiscoveryContext {
        DiscoveryContext {
            home: Some(home.to_path_buf()),
            pi_agent_dir: None,
            xdg_data_home: None,
            path: path.as_os_str().to_os_string(),
            #[cfg(windows)]
            path_ext: OsString::from(".CMD;.EXE"),
            #[cfg(windows)]
            appdata: None,
        }
    }

    #[test]
    fn rejects_unsafe_managed_versions() {
        assert!(valid_managed_version("0.84.4-beta.1"));
        assert!(!valid_managed_version("../current"));
        assert!(!valid_managed_version("release/1"));
        assert!(!valid_managed_version(""));
    }

    #[test]
    fn accepts_only_the_supported_managed_marker() {
        let root = temp_dir("managed-marker");
        let marker = root.join("managed-install.json");
        fs::write(
            &marker,
            r#"{"kind":"pi-managed-install","schemaVersion":1,"layout":"releases-v1"}"#,
        )
        .unwrap();
        assert!(valid_managed_marker(&marker));
        fs::write(
            &marker,
            r#"{"kind":"pi-managed-install","schemaVersion":2}"#,
        )
        .unwrap();
        assert!(!valid_managed_marker(&marker));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn finds_package_beside_windows_style_npm_shim() {
        let root = temp_dir("npm-layout");
        let shim = root.join(if cfg!(windows) { "pi.cmd" } else { "pi" });
        touch(&shim);
        let expected = package(&root.join("node_modules"));
        assert_eq!(package_root_from_layout(&shim), Some(expected.clone()));
        let runtime = runtime_from_pi(shim, PiRuntimeSource::Path, &context(&root, &root));
        assert_eq!(runtime.package_root, Some(expected));
        assert_eq!(runtime.install_kind, PiInstallKind::Npm);
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn finder_path_discovers_user_local_pi_and_associated_node() {
        let home = temp_dir("finder-home");
        let empty_path = home.join("empty-path");
        fs::create_dir_all(&empty_path).unwrap();
        let pi = home.join(".local/bin/pi");
        let node = home.join(".local/bin/node");
        touch(&pi);
        touch(&node);
        let expected_package = package(&home.join(".local/lib/node_modules"));

        let runtime = discover_pi_runtime_from(None, &context(&home, &empty_path)).unwrap();
        assert_eq!(runtime.pi_executable, pi);
        assert_eq!(runtime.node_executable, Some(node));
        assert_eq!(runtime.package_root, Some(expected_package));
        assert_eq!(runtime.install_kind, PiInstallKind::Npm);
        fs::remove_dir_all(home).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn classifies_standalone_layout_and_prefers_sibling_node() {
        let root = temp_dir("standalone-runtime");
        let bin = root.join("bin");
        let pi = bin.join("pi");
        let node = bin.join("node");
        touch(&pi);
        touch(&node);
        let expected = package(&root.join("node_modules"));
        let runtime = runtime_from_pi(pi, PiRuntimeSource::Explicit, &context(&root, &bin));
        assert_eq!(runtime.install_kind, PiInstallKind::Standalone);
        assert_eq!(runtime.package_root, Some(expected));
        assert_eq!(runtime.node_executable, Some(node));
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn resolves_bundled_cli_symlink_to_the_library_package() {
        let root = temp_dir("bundle-symlink");
        let package_root = package(&root.join("lib/node_modules"));
        let cli = package_root.join("dist/bundle/cli.js");
        touch(&cli);
        let bin = root.join("bin");
        fs::create_dir_all(&bin).unwrap();
        let shim = bin.join("pi");
        std::os::unix::fs::symlink(&cli, &shim).unwrap();
        let runtime = runtime_from_pi(shim, PiRuntimeSource::Path, &context(&root, &bin));
        assert_eq!(runtime.install_kind, PiInstallKind::Npm);
        assert_eq!(
            runtime.package_root,
            Some(fs::canonicalize(package_root).unwrap())
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn resolves_managed_launcher_to_current_release() {
        let home = temp_dir("managed-runtime");
        let empty_path = home.join("empty-path");
        fs::create_dir_all(&empty_path).unwrap();
        let agent = home.join(".pi/agent");
        let pi = agent.join("bin/pi");
        touch(&pi);
        let install = agent.join("install");
        fs::create_dir_all(&install).unwrap();
        fs::write(
            install.join("managed-install.json"),
            r#"{"kind":"pi-managed-install","schemaVersion":1,"layout":"releases-v1"}"#,
        )
        .unwrap();
        fs::write(install.join("current-version"), "0.84.4\n").unwrap();
        let expected = package(&install.join("releases/0.84.4/node_modules"));
        let standalone_node = home.join(".local/share/pi-node/current/bin/node");
        touch(&standalone_node);

        let runtime = discover_pi_runtime_from(None, &context(&home, &empty_path)).unwrap();
        assert_eq!(runtime.source, PiRuntimeSource::ManagedInstall);
        assert_eq!(runtime.install_kind, PiInstallKind::Managed);
        assert_eq!(runtime.package_root, Some(expected));
        assert_eq!(runtime.node_executable, Some(standalone_node));
        fs::remove_dir_all(home).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn resolves_npm_cmd_shim_and_preserves_pathext_precedence() {
        let home = temp_dir("cmd-path");
        let cmd = home.join("pi.cmd");
        let exe = home.join("pi.exe");
        touch(&cmd);
        touch(&exe);
        let resolved = resolve_executable_from("pi", &context(&home, &home));
        assert_eq!(resolved, Some(cmd));
        fs::remove_dir_all(home).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn discovers_pi_from_windows_npm_prefix() {
        let home = temp_dir("windows-appdata");
        let empty_path = home.join("empty-path");
        fs::create_dir_all(&empty_path).unwrap();
        let appdata = home.join("appdata");
        let npm_prefix = appdata.join("npm");
        let pi = npm_prefix.join("pi.cmd");
        touch(&pi);
        let expected_package = package(&npm_prefix.join("node_modules"));
        let mut discovery = context(&home, &empty_path);
        discovery.appdata = Some(appdata);
        let runtime = discover_pi_runtime_from(None, &discovery).unwrap();
        assert_eq!(runtime.pi_executable, pi);
        assert_eq!(runtime.package_root, Some(expected_package));
        assert_eq!(runtime.install_kind, PiInstallKind::Npm);
        fs::remove_dir_all(home).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn runtime_path_deduplicates_windows_paths_case_insensitively() {
        let mut paths = vec![
            PathBuf::from("C:/Tools"),
            PathBuf::from("c:\\tools\\"),
            PathBuf::from("D:/bin"),
        ];
        deduplicate_paths(&mut paths);
        assert_eq!(
            paths,
            vec![PathBuf::from("C:/Tools"), PathBuf::from("D:/bin")]
        );
    }

    #[test]
    fn includes_configured_agent_and_xdg_standalone_bins() {
        let home = temp_dir("configured-candidates");
        let empty_path = home.join("empty-path");
        fs::create_dir_all(&empty_path).unwrap();
        let agent_dir = home.join("custom-agent");
        let xdg_data_home = home.join("xdg-data");
        let mut discovery = context(&home, &empty_path);
        discovery.pi_agent_dir = Some(agent_dir.clone());
        discovery.xdg_data_home = Some(xdg_data_home.clone());
        discovery.home = None;
        let candidates = standard_pi_candidates(&discovery);
        assert!(candidates
            .iter()
            .any(|(candidate, _)| candidate.parent() == Some(agent_dir.join("bin").as_path())));
        assert!(candidates.iter().any(|(candidate, _)| candidate.parent()
            == Some(xdg_data_home.join("pi-node/current/bin").as_path())));
        fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn runtime_path_prioritizes_selected_node_and_pi_bins() {
        let root = temp_dir("runtime-path");
        let node_bin = root.join("node-bin");
        let pi_bin = root.join("pi-bin");
        let runtime = PiRuntime {
            pi_executable: pi_bin.join(if cfg!(windows) { "pi.cmd" } else { "pi" }),
            node_executable: Some(node_bin.join(if cfg!(windows) { "node.exe" } else { "node" })),
            package_root: None,
            source: PiRuntimeSource::Explicit,
            install_kind: PiInstallKind::Unknown,
        };
        let path = runtime.runtime_path().unwrap();
        let directories: Vec<PathBuf> = std::env::split_paths(&path).collect();
        assert_eq!(directories[0], node_bin);
        assert_eq!(directories[1], pi_bin);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn prepends_npm_bin_without_duplicating() {
        let npm_bin = PathBuf::from(if cfg!(windows) {
            "C:/npm-prefix"
        } else {
            "/tmp/npm-prefix"
        });
        let original = std::env::join_paths([PathBuf::from(if cfg!(windows) {
            "C:/tools"
        } else {
            "/usr/bin"
        })])
        .unwrap();
        let prepended = with_npm_bin_prepended(&original, &npm_bin).unwrap();
        let directories: Vec<PathBuf> = std::env::split_paths(&prepended).collect();
        assert_eq!(directories[0], npm_bin);
        assert!(with_npm_bin_prepended(&prepended, &npm_bin).is_none());
    }
}
