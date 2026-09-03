//! Tauri composition root for the opt-in LAN remote-control gateway.
//!
//! This module owns only local administration and lifecycle.  The gateway
//! itself remains Tauri-free in `pi-remote-control`, so mobile requests never
//! reach desktop commands, the desktop Pi session, or the React stores.

mod wake_on_lan;

use pi_backend_core::projects::{canonical_project_root, DurableJsonStore};
use pi_remote_control::config::RemoteControlConfig;
use pi_remote_control::conversation_protocol::{
    RemoteConversationSnapshot, RemoteMessagePageResponse,
};
use pi_remote_control::conversation_runtime::{
    ConversationRuntimeConfig, ConversationRuntimeManager,
};
use pi_remote_control::device_store::DeviceRegistry;
use pi_remote_control::gateway::{build_router, build_server_config, GatewayServer, GatewayState};
use pi_remote_control::identity::{
    create_initial_identity, load_identity, rotate_identity, IdentityError, IdentityStore,
    StoredIdentity,
};
use pi_remote_control::pairing::PairingError;
use pi_remote_control::pi_session::{PiSessionAdapter, PiSessionConfig, PiSessionContext};
use pi_remote_control::project_catalog::PersistedProject;
use pi_remote_control::protocol::{
    PairingDesktopIdentity, PairingQrPayload, RemoteEndpoint, RemoteEndpointScheme,
    RemoteProjectSummary, WakeOnLanConfig, WakeOnLanTarget,
};
use pi_remote_control::storage::StorageError;
use pi_remote_control::task_manager::format_timestamp;
use pi_remote_control::task_runtime::RemoteTaskRuntimeConfig;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
use std::net::{IpAddr, Ipv4Addr, SocketAddr, UdpSocket};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, Sender, SyncSender};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager, Runtime, State};

const SHUTDOWN_WAIT: Duration = Duration::from_secs(20);
const REMOTE_TASK_DRAIN_WAIT: Duration = Duration::from_secs(6);
const REMOTE_CONTROL_CONFIG_FILE: &str = "remote-control-config.json";
const REMOTE_CONTROL_CONFIG_SCHEMA_VERSION: u32 = 1;
const REMOTE_CONTROL_CONFIG_MAX_BYTES: usize = 16 * 1024;

#[derive(Default)]
pub struct RemoteControlState {
    inner: Mutex<RemoteControlInner>,
    operation: Mutex<()>,
}

struct RemoteControlInner {
    running: Option<RunningGateway>,
    saved_config: Option<PersistedRemoteControlConfig>,
    last_error: Option<String>,
}

impl Default for RemoteControlInner {
    fn default() -> Self {
        Self {
            running: None,
            saved_config: None,
            last_error: None,
        }
    }
}

struct RunningGateway {
    config: RemoteControlConfig,
    gateway: GatewayState,
    project_store_path: PathBuf,
    degraded: Arc<AtomicBool>,
    command_tx: Sender<RuntimeCommand>,
    thread: Option<JoinHandle<()>>,
}

enum RuntimeCommand {
    Shutdown(Sender<Result<(), String>>),
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteControlStatus {
    pub enabled: bool,
    pub degraded: bool,
    pub selected_addresses: Vec<String>,
    pub port: Option<u16>,
    pub identity_epoch: Option<u64>,
    pub projects: Vec<RemoteProjectSummary>,
    pub paired_devices: Vec<pi_remote_control::protocol::PairingDeviceMetadata>,
    pub last_error: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteControlEnableRequest {
    pub selected_addresses: Vec<String>,
    pub port: u16,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PersistedRemoteControlConfig {
    schema_version: u32,
    enabled: bool,
    selected_addresses: Vec<String>,
    port: u16,
}

impl PersistedRemoteControlConfig {
    fn from_request(request: &RemoteControlEnableRequest, enabled: bool) -> Result<Self, String> {
        let config = Self {
            schema_version: REMOTE_CONTROL_CONFIG_SCHEMA_VERSION,
            enabled,
            selected_addresses: request.selected_addresses.clone(),
            port: request.port,
        };
        config.validate()?;
        Ok(config)
    }

    fn from_runtime(config: &RemoteControlConfig, enabled: bool) -> Self {
        Self {
            schema_version: REMOTE_CONTROL_CONFIG_SCHEMA_VERSION,
            enabled,
            selected_addresses: config
                .selected_addresses()
                .iter()
                .map(ToString::to_string)
                .collect(),
            port: config.port(),
        }
    }

    fn enable_request(&self) -> RemoteControlEnableRequest {
        RemoteControlEnableRequest {
            selected_addresses: self.selected_addresses.clone(),
            port: self.port,
        }
    }

    fn validate(&self) -> Result<(), String> {
        if self.schema_version != REMOTE_CONTROL_CONFIG_SCHEMA_VERSION {
            return Err("remote-control config schema version is unsupported".to_owned());
        }
        let addresses = self
            .selected_addresses
            .iter()
            .map(|value| value.parse::<IpAddr>().map_err(|_| "invalid bind address"))
            .collect::<Result<Vec<_>, _>>()?;
        RemoteControlConfig::try_new(true, addresses, self.port)
            .map(|_| ())
            .map_err(|error| error.to_string())
    }
}

impl RemoteControlState {
    pub fn shutdown(&self) {
        let _operation = match self.operation.lock() {
            Ok(operation) => operation,
            Err(_) => {
                eprintln!("[remote-control] shutdown lock unavailable");
                return;
            }
        };
        // Application shutdown stops the live listener but deliberately keeps
        // the persisted `enabled` preference so the next launch can restore it.
        if let Err(error) = self.disable_inner() {
            eprintln!("[remote-control] shutdown failed: {error}");
        }
    }

    pub fn restore_on_startup<R: Runtime>(&self, app: &AppHandle<R>) -> Result<(), String> {
        let _operation = self
            .operation
            .lock()
            .map_err(|_| "remote control operation unavailable".to_owned())?;
        let result = self.restore_on_startup_inner(app);
        if let Err(error) = &result {
            self.record_error(error.clone());
        }
        result
    }

    fn restore_on_startup_inner<R: Runtime>(&self, app: &AppHandle<R>) -> Result<(), String> {
        let path = remote_control_config_path(app)?;
        let Some(saved) = load_remote_control_config(&path)? else {
            return Ok(());
        };
        saved.validate()?;
        {
            let mut inner = self
                .inner
                .lock()
                .map_err(|_| "remote control state unavailable".to_owned())?;
            inner.saved_config = Some(saved.clone());
            inner.last_error = None;
        }
        if saved.enabled {
            self.enable_inner(app, saved.enable_request())?;
        }
        Ok(())
    }

    fn enable<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        request: RemoteControlEnableRequest,
    ) -> Result<RemoteControlStatus, String> {
        let _operation = self
            .operation
            .lock()
            .map_err(|_| "remote control operation unavailable")?;
        let saved = PersistedRemoteControlConfig::from_request(&request, true)?;
        self.enable_inner(app, request)?;
        if let Err(error) = persist_remote_control_config(app, &saved) {
            let rollback_error = self.disable_inner().err();
            let error = match rollback_error {
                Some(rollback) => {
                    format!("{error}; remote-control startup rollback also failed: {rollback}")
                }
                None => error,
            };
            self.record_error(error.clone());
            return Err(error);
        }
        self.set_saved_config(saved)?;
        self.status()
    }

    fn enable_inner<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        request: RemoteControlEnableRequest,
    ) -> Result<RemoteControlStatus, String> {
        let addresses = request
            .selected_addresses
            .iter()
            .map(|value| value.parse::<IpAddr>().map_err(|_| "invalid bind address"))
            .collect::<Result<Vec<_>, _>>()?;
        let config = RemoteControlConfig::try_new(true, addresses, request.port)
            .map_err(|error| error.to_string())?;

        let mut inner = self
            .inner
            .lock()
            .map_err(|_| "remote control state unavailable")?;
        if inner.running.is_some() {
            return Err("remote control is already enabled".to_owned());
        }
        let result = build_running_gateway(app, config);
        match result {
            Ok(running) => {
                inner.last_error = None;
                inner.running = Some(running);
            }
            Err(error) => {
                inner.last_error = Some(error.clone());
                return Err(error);
            }
        }
        drop(inner);
        self.status()
    }

    fn disable<R: Runtime>(&self, app: &AppHandle<R>) -> Result<(), String> {
        let _operation = self
            .operation
            .lock()
            .map_err(|_| "remote control operation unavailable")?;
        let saved = {
            let inner = self
                .inner
                .lock()
                .map_err(|_| "remote control state unavailable".to_owned())?;
            if let Some(running) = &inner.running {
                Some(PersistedRemoteControlConfig::from_runtime(
                    &running.config,
                    false,
                ))
            } else {
                inner.saved_config.clone().map(|mut saved| {
                    saved.enabled = false;
                    saved
                })
            }
        };
        if let Some(saved) = saved {
            if let Err(error) = persist_remote_control_config(app, &saved) {
                self.record_error(error.clone());
                return Err(error);
            }
            self.set_saved_config(saved)?;
        }
        if let Err(error) = self.disable_inner() {
            self.record_error(error.clone());
            return Err(error);
        }
        self.clear_error()?;
        Ok(())
    }

    fn disable_inner(&self) -> Result<(), String> {
        let running = self
            .inner
            .lock()
            .map_err(|_| "remote control state unavailable")?
            .running
            .take();
        let Some(mut running) = running else {
            return Ok(());
        };
        let (reply_tx, reply_rx) = mpsc::channel();
        if running
            .command_tx
            .send(RuntimeCommand::Shutdown(reply_tx))
            .is_err()
        {
            if let Some(thread) = running.thread.take() {
                let _ = thread.join();
            }
            return Ok(());
        }
        let result = match reply_rx.recv_timeout(SHUTDOWN_WAIT) {
            Ok(result) => result,
            Err(_) => {
                let mut inner = self
                    .inner
                    .lock()
                    .map_err(|_| "remote control state unavailable")?;
                inner.running = Some(running);
                return Err("remote control shutdown timed out".to_owned());
            }
        };
        if let Some(thread) = running.thread.take() {
            thread
                .join()
                .map_err(|_| "remote control runtime thread panicked".to_owned())?;
        }
        result
    }

    fn status(&self) -> Result<RemoteControlStatus, String> {
        let inner = self
            .inner
            .lock()
            .map_err(|_| "remote control state unavailable")?;
        let Some(running) = &inner.running else {
            let saved = inner.saved_config.as_ref();
            return Ok(RemoteControlStatus {
                enabled: saved.is_some_and(|config| config.enabled),
                degraded: false,
                selected_addresses: saved
                    .map(|config| config.selected_addresses.clone())
                    .unwrap_or_default(),
                port: saved.map(|config| config.port),
                identity_epoch: None,
                projects: Vec::new(),
                paired_devices: Vec::new(),
                last_error: inner.last_error.clone(),
            });
        };
        Ok(RemoteControlStatus {
            enabled: true,
            degraded: running.degraded.load(Ordering::Acquire),
            selected_addresses: running
                .config
                .selected_addresses()
                .iter()
                .map(ToString::to_string)
                .collect(),
            port: Some(running.config.port()),
            identity_epoch: running.gateway.devices.identity_epoch().ok(),
            projects: running.gateway.projects.list_projects(),
            paired_devices: running.gateway.devices.list_devices().unwrap_or_default(),
            last_error: inner.last_error.clone(),
        })
    }

    fn set_saved_config(&self, saved: PersistedRemoteControlConfig) -> Result<(), String> {
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| "remote control state unavailable".to_owned())?;
        inner.saved_config = Some(saved);
        Ok(())
    }

    fn record_error(&self, error: String) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.last_error = Some(error);
        }
    }

    fn clear_error(&self) -> Result<(), String> {
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| "remote control state unavailable".to_owned())?;
        inner.last_error = None;
        Ok(())
    }

    pub(crate) fn sync_selected_project(&self, root: &Path) -> Result<(), String> {
        let _operation = self
            .operation
            .lock()
            .map_err(|_| "remote control operation unavailable".to_owned())?;
        let inner = self
            .inner
            .lock()
            .map_err(|_| "remote control state unavailable".to_owned())?;
        let Some(running) = &inner.running else {
            return Ok(());
        };
        sync_gateway_project(running, root).map(|_| ())
    }

    fn reset_identity<R: Runtime>(
        &self,
        app: &AppHandle<R>,
    ) -> Result<RemoteControlStatus, String> {
        let _operation = self
            .operation
            .lock()
            .map_err(|_| "remote control operation unavailable")?;
        let (selected_addresses, port, next_epoch) = {
            let inner = self
                .inner
                .lock()
                .map_err(|_| "remote control state unavailable")?;
            let running = inner
                .running
                .as_ref()
                .ok_or_else(|| "remote control is disabled".to_owned())?;
            let next_epoch = running
                .gateway
                .identity
                .identity_epoch()
                .saturating_add(1)
                .max(1);
            (
                running
                    .config
                    .selected_addresses()
                    .iter()
                    .map(ToString::to_string)
                    .collect::<Vec<_>>(),
                running.config.port(),
                next_epoch,
            )
        };

        // The TLS server configuration and GatewayState identity are immutable
        // for the lifetime of a listener. Stop the old listener before rotating
        // material so no connection can continue under the old certificate.
        self.disable_inner()?;

        let app_data_dir = remote_control_data_dir(app)?;
        let identity_store =
            JsonIdentityStore::new(app_data_dir.join("remote-control-identity.json"));
        let current = load_identity(&identity_store).map_err(|error| error.to_string())?;
        let storage = pi_remote_control::storage::RemoteStorage::open(
            app_data_dir.join("remote-control.sqlite3"),
        )
        .map_err(storage_error)?;

        // Persist the new authorization epoch before restarting. Any failure
        // leaves the gateway disabled; startup also validates the epoch against
        // the persisted identity rather than silently trusting a mismatch.
        storage.clear_devices().map_err(storage_error)?;
        storage
            .set_identity_epoch(next_epoch)
            .map_err(storage_error)?;
        rotate_identity(
            &identity_store,
            current.desktop_id().to_owned(),
            next_epoch,
            vec!["localhost".to_owned()],
        )
        .map_err(|error| error.to_string())?;

        drop(storage);
        self.enable_inner(
            app,
            RemoteControlEnableRequest {
                selected_addresses,
                port,
            },
        )
    }

    fn with_gateway<T>(
        &self,
        operation: impl FnOnce(&GatewayState) -> Result<T, String>,
    ) -> Result<T, String> {
        let inner = self
            .inner
            .lock()
            .map_err(|_| "remote control state unavailable")?;
        let running = inner
            .running
            .as_ref()
            .ok_or_else(|| "remote control is disabled".to_owned())?;
        operation(&running.gateway)
    }

    fn with_running<T>(
        &self,
        operation: impl FnOnce(&RunningGateway) -> Result<T, String>,
    ) -> Result<T, String> {
        let inner = self
            .inner
            .lock()
            .map_err(|_| "remote control state unavailable")?;
        let running = inner
            .running
            .as_ref()
            .ok_or_else(|| "remote control is disabled".to_owned())?;
        operation(running)
    }
}

fn build_running_gateway<R: Runtime>(
    app: &AppHandle<R>,
    config: RemoteControlConfig,
) -> Result<RunningGateway, String> {
    let app_data_dir = remote_control_data_dir(app)?;
    fs::create_dir_all(&app_data_dir)
        .map_err(|error| format!("cannot create remote-control data directory: {error}"))?;
    let identity_store = JsonIdentityStore::new(app_data_dir.join("remote-control-identity.json"));
    let identity = match identity_store.load().map_err(|error| error.to_string())? {
        Some(_) => load_identity(&identity_store).map_err(|error| error.to_string())?,
        None => {
            create_initial_identity(&identity_store, "pi-desktop", vec!["localhost".to_owned()])
                .map_err(|error| error.to_string())?
        }
    };
    let pi_runtime = crate::pi_command::PiRuntime::discover(None)
        .map_err(|error| format!("Pi CLI is unavailable: {error}"))?;
    let runtime_config = RemoteTaskRuntimeConfig {
        pi_binary: pi_runtime.pi_executable.as_os_str().to_os_string(),
        runtime_path: pi_runtime.runtime_path(),
        ..RemoteTaskRuntimeConfig::default()
    };
    let conversation_pi_binary = runtime_config.pi_binary.clone();
    let conversation_runtime_path = runtime_config.runtime_path.clone();
    let storage_path = app_data_dir.join("remote-control.sqlite3");
    let project_store_path = app_data_dir.join("remote-control-projects.json");
    let devices = Arc::new(DeviceRegistry::new());
    let gateway = GatewayState::with_runtime_config_and_storage(
        identity.clone(),
        devices,
        "pi-desktop",
        runtime_config,
        storage_path,
    )
    .map_err(storage_error)?;
    if gateway.identity.identity_epoch()
        != gateway
            .devices
            .identity_epoch()
            .map_err(|error| error.to_string())?
    {
        gateway.supervisor.stop();
        return Err("remote-control identity and authorization epochs differ".to_owned());
    }
    let selected_project_root = crate::projects::last_project()?.map(PathBuf::from);
    let recent_projects = crate::projects::list_recent()?;
    if let Err(error) =
        sync_gateway_recent_projects(&project_store_path, &gateway, &recent_projects)
    {
        gateway.supervisor.stop();
        return Err(error);
    }

    // V2 is an additive capability. The legacy gateway remains available when
    // the installed Pi cannot pass the private-session compatibility probe;
    // conversation routes stay fail-closed until a verified runtime exists.
    // The active session follows the desktop's current project, not the first
    // catalog entry — the catalog now holds every recent project for mobile.
    let conversation_runtime = match selected_project_root.as_deref() {
        Some(project_root) => {
            let canonical_root = canonical_project_root(project_root).ok();
            let active = gateway
                .projects
                .persisted_projects()
                .into_iter()
                .find(|project| {
                    canonical_root
                        .as_ref()
                        .is_some_and(|root| &project.root == root)
                });
            match active {
                Some(project) => {
                    let session_config = PiSessionConfig::new(
                        conversation_pi_binary,
                        app_data_dir.join("remote-control-sessions"),
                    )
                    .with_runtime_path(conversation_runtime_path);
                    let probe_context = PiSessionContext {
                        owner_device_id: "remote-control-probe".to_owned(),
                        conversation_id: "probe".to_owned(),
                        project_id: project.project_id.clone(),
                        project_root: project_root.to_path_buf(),
                    };
                    match PiSessionAdapter::probe(session_config.clone(), probe_context) {
                        Ok(probe) => match PiSessionAdapter::new(session_config, probe) {
                            Ok(adapter) => {
                                if let Some(storage) = gateway.storage.clone() {
                                    let recovery_ms = now_ms();
                                    let recovery_at = format_timestamp(recovery_ms);
                                    storage
                                        .recover_non_terminal_turns(recovery_ms, &recovery_at)
                                        .map_err(storage_error)?;
                                    let manager = ConversationRuntimeManager::new(
                                        storage,
                                        Arc::clone(&gateway.projects),
                                        Arc::new(adapter),
                                        ConversationRuntimeConfig::default(),
                                    );
                                    manager.start();
                                    Some(manager)
                                } else {
                                    None
                                }
                            }
                            Err(_) => None,
                        },
                        Err(_) => None,
                    }
                }
                None => None,
            }
        }
        None => None,
    };
    let gateway = if let Some(manager) = conversation_runtime.clone() {
        gateway.with_conversation_runtime(manager)
    } else {
        gateway
    };
    let gateway = gateway.with_models(
        pi_remote_control::models::HostModelCatalog::new(
            crate::pi_settings::home_dir()
                .ok()
                .map(|home| home.join(".pi").join("agent").join("models.json")),
            String::new(),
            String::new(),
        )
        .map(std::sync::Arc::new),
    );
    let tls = build_server_config(&identity).map_err(|error| error.to_string())?;
    let router = build_router(gateway.clone());
    let (command_tx, command_rx) = mpsc::channel();
    let (ready_tx, ready_rx) = mpsc::sync_channel(1);
    let degraded = Arc::new(AtomicBool::new(false));
    let thread_config = config.clone();
    let thread_gateway = gateway.clone();
    let thread_degraded = Arc::clone(&degraded);
    let thread = thread::Builder::new()
        .name("remote-control-gateway".to_owned())
        .spawn(move || {
            run_gateway_thread(
                thread_config,
                thread_gateway,
                router,
                tls,
                command_rx,
                ready_tx,
                thread_degraded,
            )
        })
        .map_err(|error| format!("cannot start remote-control thread: {error}"))?;
    match ready_rx.recv_timeout(Duration::from_secs(8)) {
        Ok(Ok(())) => Ok(RunningGateway {
            config,
            gateway,
            project_store_path,
            degraded,
            command_tx,
            thread: Some(thread),
        }),
        Ok(Err(error)) => {
            let _ = thread.join();
            Err(error)
        }
        Err(_) => {
            let (shutdown_tx, _shutdown_rx) = mpsc::channel();
            let _ = command_tx.send(RuntimeCommand::Shutdown(shutdown_tx));
            let _ = thread.join();
            Err("remote-control gateway startup timed out".to_owned())
        }
    }
}

fn remote_control_data_dir<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    #[cfg(any(test, feature = "remote-control-smoke"))]
    if let Some(path) = std::env::var_os("RAGCODE_REMOTE_CONTROL_DATA_DIR") {
        return Ok(PathBuf::from(path));
    }
    app.path()
        .app_data_dir()
        .map_err(|error| format!("cannot resolve remote-control data directory: {error}"))
}

fn remote_control_config_path<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    Ok(remote_control_data_dir(app)?.join(REMOTE_CONTROL_CONFIG_FILE))
}

fn load_remote_control_config(path: &Path) -> Result<Option<PersistedRemoteControlConfig>, String> {
    DurableJsonStore::new(path)
        .with_max_bytes(REMOTE_CONTROL_CONFIG_MAX_BYTES)
        .load()
        .map_err(|error| format!("remote-control config unavailable: {error}"))
}

fn persist_remote_control_config<R: Runtime>(
    app: &AppHandle<R>,
    config: &PersistedRemoteControlConfig,
) -> Result<(), String> {
    config.validate()?;
    let path = remote_control_config_path(app)?;
    DurableJsonStore::new(path)
        .with_max_bytes(REMOTE_CONTROL_CONFIG_MAX_BYTES)
        .store(config)
        .map_err(|error| format!("cannot persist remote-control config: {error}"))
}

fn run_gateway_thread(
    config: RemoteControlConfig,
    gateway: GatewayState,
    router: axum::Router,
    tls: Arc<rustls::ServerConfig>,
    command_rx: Receiver<RuntimeCommand>,
    ready_tx: SyncSender<Result<(), String>>,
    degraded: Arc<AtomicBool>,
) {
    let runtime = match tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(error) => {
            stop_conversation_runtime(&gateway);
            gateway.supervisor.stop();
            let _ = ready_tx.send(Err(format!("cannot create gateway runtime: {error}")));
            return;
        }
    };
    let server = match runtime.block_on(GatewayServer::start(&config, router, tls)) {
        Ok(server) => server,
        Err(error) => {
            stop_conversation_runtime(&gateway);
            gateway.supervisor.stop();
            let _ = ready_tx.send(Err(error.to_string()));
            return;
        }
    };
    if ready_tx.send(Ok(())).is_err() {
        let _ = runtime.block_on(server.shutdown());
        stop_conversation_runtime(&gateway);
        gateway.supervisor.stop();
        return;
    }
    let reply = loop {
        match command_rx.recv_timeout(Duration::from_secs(1)) {
            Ok(RuntimeCommand::Shutdown(reply)) => break reply,
            Err(mpsc::RecvTimeoutError::Timeout) => {
                if !selected_addresses_available(&config) {
                    degraded.store(true, Ordering::Release);
                    let _ = runtime.block_on(server.shutdown());
                    stop_conversation_runtime(&gateway);
                    gateway.supervisor.stop();
                    let _ = gateway.supervisor.wait_for_idle(REMOTE_TASK_DRAIN_WAIT);
                    return;
                }
                degraded.store(false, Ordering::Release);
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                let _ = runtime.block_on(server.shutdown());
                stop_conversation_runtime(&gateway);
                gateway.supervisor.stop();
                let _ = gateway.supervisor.wait_for_idle(REMOTE_TASK_DRAIN_WAIT);
                return;
            }
        }
    };
    let shutdown_result = runtime
        .block_on(server.shutdown())
        .map_err(|error| error.to_string());
    stop_conversation_runtime(&gateway);
    gateway.supervisor.stop();
    let _ = gateway.supervisor.wait_for_idle(REMOTE_TASK_DRAIN_WAIT);
    let _ = reply.send(shutdown_result);
}

fn stop_conversation_runtime(gateway: &GatewayState) {
    if let Some(manager) = &gateway.conversations {
        manager.stop();
    }
}

fn selected_addresses_available(config: &RemoteControlConfig) -> bool {
    config
        .selected_addresses()
        .iter()
        .all(|address| std::net::TcpListener::bind(std::net::SocketAddr::new(*address, 0)).is_ok())
}

fn is_private_lan_address(address: IpAddr) -> bool {
    let IpAddr::V4(address) = address else {
        return false;
    };
    let octets = address.octets();
    octets[0] == 10
        || (octets[0] == 172 && (16..=31).contains(&octets[1]))
        || (octets[0] == 192 && octets[1] == 168)
}

fn discover_private_addresses() -> Vec<String> {
    // UDP connect selects a route without sending traffic. Probing distinct
    // private ranges plus the default internet route covers ordinary LAN, VPN,
    // and offline-private-network setups without platform-specific APIs.
    const ROUTE_PROBES: [Ipv4Addr; 4] = [
        Ipv4Addr::new(192, 168, 0, 1),
        Ipv4Addr::new(10, 0, 0, 1),
        Ipv4Addr::new(172, 16, 0, 1),
        Ipv4Addr::new(1, 1, 1, 1),
    ];

    let mut addresses = Vec::new();
    for probe in ROUTE_PROBES {
        let Ok(socket) = UdpSocket::bind(SocketAddr::new(IpAddr::V4(Ipv4Addr::UNSPECIFIED), 0))
        else {
            continue;
        };
        if socket
            .connect(SocketAddr::new(IpAddr::V4(probe), 9))
            .is_err()
        {
            continue;
        }
        let Ok(local) = socket.local_addr() else {
            continue;
        };
        if is_private_lan_address(local.ip()) {
            addresses.push(local.ip().to_string());
        }
    }
    addresses.sort();
    addresses.dedup();
    addresses
}

#[tauri::command]
pub fn remote_control_status(
    state: State<'_, RemoteControlState>,
) -> Result<RemoteControlStatus, String> {
    state.status()
}

#[tauri::command]
pub fn remote_control_private_addresses() -> Vec<String> {
    discover_private_addresses()
}

#[tauri::command]
pub fn remote_control_enable<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, RemoteControlState>,
    request: RemoteControlEnableRequest,
) -> Result<RemoteControlStatus, String> {
    state.enable(&app, request)
}

#[tauri::command]
pub fn remote_control_disable<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, RemoteControlState>,
) -> Result<RemoteControlStatus, String> {
    state.disable(&app)?;
    state.status()
}

#[tauri::command]
pub fn remote_control_pairing_payload(
    state: State<'_, RemoteControlState>,
) -> Result<PairingQrPayload, String> {
    state.with_running(|running| {
        let wake_targets = wake_on_lan::discover_targets(running.config.selected_addresses());
        let wake_on_lan = (!wake_targets.is_empty()).then(|| WakeOnLanConfig {
            targets: wake_targets
                .into_iter()
                .map(|target| WakeOnLanTarget {
                    mac_address: target.mac_address,
                    broadcast_address: target.broadcast_address,
                })
                .collect(),
        });
        let endpoints = running
            .config
            .selected_socket_addresses()
            .map_err(|error| error.to_string())?;
        let endpoints = endpoints
            .into_iter()
            .map(|address| RemoteEndpoint {
                scheme: RemoteEndpointScheme::Https,
                host: address.ip().to_string(),
                port: address.port(),
            })
            .collect::<Vec<_>>();
        running
            .gateway
            .pairing
            .issue_ticket(
                PairingDesktopIdentity {
                    desktop_id: running.gateway.identity.desktop_id().to_owned(),
                    display_name: "Pi Desktop".to_owned(),
                },
                endpoints,
                running.gateway.identity.certificate_pin().clone(),
                wake_on_lan,
                now_ms(),
            )
            .map_err(pairing_error)
    })
}

#[tauri::command]
pub fn remote_control_revoke_device(
    state: State<'_, RemoteControlState>,
    device_id: String,
) -> Result<RemoteControlStatus, String> {
    state.with_gateway(|gateway| {
        gateway.event_hub.unsubscribe_device(&device_id);
        gateway.supervisor.cancel_owner(&device_id);
        gateway.tasks.revoke_owner(&device_id);
        if let Some(storage) = &gateway.storage {
            storage.remove_device(&device_id).map_err(storage_error)?;
        }
        gateway
            .devices
            .revoke(&device_id)
            .map_err(|error| error.to_string())?;
        Ok(())
    })?;
    state.status()
}

#[tauri::command]
pub fn remote_control_reset_identity<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, RemoteControlState>,
) -> Result<RemoteControlStatus, String> {
    state.reset_identity(&app)
}

#[tauri::command]
pub fn remote_conversations_list(
    state: State<'_, RemoteControlState>,
    limit: Option<usize>,
) -> Result<Vec<RemoteConversationSnapshot>, String> {
    state.with_gateway(|gateway| {
        let storage = gateway
            .storage
            .as_ref()
            .ok_or_else(|| "remote conversation storage is unavailable".to_owned())?;
        storage
            .list_conversations_for_desktop(limit.unwrap_or(100))
            .map_err(storage_error)
    })
}

#[tauri::command]
pub fn remote_conversation_get(
    state: State<'_, RemoteControlState>,
    conversation_id: String,
) -> Result<RemoteConversationSnapshot, String> {
    state.with_gateway(|gateway| {
        let storage = gateway
            .storage
            .as_ref()
            .ok_or_else(|| "remote conversation storage is unavailable".to_owned())?;
        storage
            .load_conversation_for_desktop(&conversation_id)
            .map_err(storage_error)?
            .ok_or_else(|| "remote conversation was not found".to_owned())
    })
}

#[tauri::command]
pub fn remote_conversation_messages(
    state: State<'_, RemoteControlState>,
    conversation_id: String,
    after_ordinal: Option<u64>,
    limit: Option<usize>,
) -> Result<RemoteMessagePageResponse, String> {
    state.with_gateway(|gateway| {
        let storage = gateway
            .storage
            .as_ref()
            .ok_or_else(|| "remote conversation storage is unavailable".to_owned())?;
        storage
            .load_conversation_messages_for_desktop(
                &conversation_id,
                after_ordinal,
                limit.unwrap_or(100),
            )
            .map_err(storage_error)?
            .ok_or_else(|| "remote conversation was not found".to_owned())
    })
}

#[tauri::command]
pub fn remote_conversation_append(
    state: State<'_, RemoteControlState>,
    conversation_id: String,
    prompt: String,
    model_ref: Option<String>,
    request_id: String,
) -> Result<pi_remote_control::conversation_protocol::RemoteTurnAppendResponse, String> {
    state.with_gateway(|gateway| {
        let storage = gateway
            .storage
            .as_ref()
            .ok_or_else(|| "remote conversation storage is unavailable".to_owned())?;
        if prompt.trim().is_empty() {
            return Err("prompt must not be empty".to_owned());
        }
        if request_id.is_empty() || request_id.len() > 128 {
            return Err("requestId is invalid".to_owned());
        }
        let event_id = format!("desktop-append-{request_id}");
        storage
            .append_conversation_turn_for_desktop(
                &conversation_id,
                prompt.trim(),
                Vec::new(),
                model_ref,
                request_id,
                event_id,
            )
            .map_err(storage_error)
    })
}

#[tauri::command]
pub fn remote_conversation_cancel(
    state: State<'_, RemoteControlState>,
    conversation_id: String,
    turn_id: String,
) -> Result<bool, String> {
    state.with_gateway(|gateway| {
        let storage = gateway
            .storage
            .as_ref()
            .ok_or_else(|| "remote conversation storage is unavailable".to_owned())?;
        let snapshot = storage
            .load_conversation_for_desktop(&conversation_id)
            .map_err(storage_error)?
            .ok_or_else(|| "remote conversation was not found".to_owned())?;
        let manager = gateway
            .conversations
            .as_ref()
            .ok_or_else(|| "remote conversation runtime is unavailable".to_owned())?;
        Ok(manager.cancel_turn(&snapshot.owner_device_id, &conversation_id, &turn_id))
    })
}

#[tauri::command]
pub fn remote_conversation_archive(
    state: State<'_, RemoteControlState>,
    conversation_id: String,
) -> Result<bool, String> {
    state.with_gateway(|gateway| {
        let storage = gateway
            .storage
            .as_ref()
            .ok_or_else(|| "remote conversation storage is unavailable".to_owned())?;
        let snapshot = storage
            .load_conversation_for_desktop(&conversation_id)
            .map_err(storage_error)?
            .ok_or_else(|| "remote conversation was not found".to_owned())?;
        let manager = gateway
            .conversations
            .as_ref()
            .ok_or_else(|| "remote conversation runtime is unavailable".to_owned())?;
        Ok(manager.archive_conversation(&snapshot.owner_device_id, &conversation_id))
    })
}

/// Grants or revokes the elevated model-administration scope for one paired
/// device. Persisted through gateway storage and audited; the registry and
/// the database are updated together so the live scope cannot drift from
/// the durable grant.
#[tauri::command]
pub fn remote_control_set_model_admin(
    state: State<'_, RemoteControlState>,
    device_id: String,
    granted: bool,
) -> Result<bool, String> {
    state.with_gateway(|gateway| {
        let registry = &gateway.devices;
        registry
            .set_model_admin(&device_id, granted)
            .map_err(|error| error.to_string())?;
        let storage = gateway
            .storage
            .as_ref()
            .ok_or_else(|| "remote conversation storage is unavailable".to_owned())?;
        let at_ms = now_ms();
        storage
            .set_model_admin_grant(&device_id, granted, at_ms)
            .map_err(storage_error)?;
        let _ = storage.record_model_admin_audit(
            &format!("audit-grant-{at_ms}-{device_id}"),
            if granted { "grant" } else { "revoke" },
            &device_id,
            None,
            at_ms,
        );
        Ok(granted)
    })
}

fn storage_error(error: StorageError) -> String {
    error.to_string()
}

fn pairing_error(error: PairingError) -> String {
    error.to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct PersistedProjectFile {
    project_id: String,
    root: PathBuf,
    name: String,
    last_opened_at: Option<String>,
}

fn sync_gateway_project(
    running: &RunningGateway,
    root: &Path,
) -> Result<RemoteProjectSummary, String> {
    let recents = crate::projects::list_recent()?;
    sync_gateway_recent_projects(&running.project_store_path, &running.gateway, &recents)?;
    let canonical = canonical_project_root(root).map_err(|error| error.to_string())?;
    let project = running
        .gateway
        .projects
        .persisted_projects()
        .into_iter()
        .find(|project| project.root == canonical)
        .ok_or_else(|| "opened project is not visible to remote control".to_owned())?;
    running
        .gateway
        .projects
        .project_summary(&project.project_id)
        .map_err(|error| error.to_string())
}

/// Reconcile the remotely visible project catalog with the desktop's recent
/// projects. Previously persisted opaque ids are restored first so the mobile
/// side keeps stable ids across desktop restarts; projects removed from the
/// recents list are dropped from the allowlist (and their tasks revoked) only
/// after the allowlist file has been durably updated.
fn sync_gateway_recent_projects(
    project_store_path: &Path,
    gateway: &GatewayState,
    recents: &[crate::projects::RecentProject],
) -> Result<(), String> {
    let mut desired = Vec::new();
    for recent in recents {
        let Ok(canonical_root) = canonical_project_root(Path::new(&recent.path)) else {
            continue;
        };
        desired.push((
            canonical_root,
            recent.name.clone(),
            format_timestamp(recent.last_opened_at),
        ));
    }
    let desired_roots = desired
        .iter()
        .map(|(root, _, _)| root.clone())
        .collect::<HashSet<_>>();

    if let Ok(bytes) = fs::read(project_store_path) {
        if let Ok(records) = serde_json::from_slice::<Vec<PersistedProjectFile>>(&bytes) {
            for record in records {
                let Ok(record_root) = canonical_project_root(&record.root) else {
                    continue;
                };
                if !desired_roots.contains(&record_root) {
                    continue;
                }
                let _ = gateway.projects.restore_project(PersistedProject {
                    project_id: record.project_id,
                    root: record.root,
                    name: record.name,
                    last_opened_at: record.last_opened_at,
                });
            }
        }
    }

    let previous = gateway.projects.persisted_projects();

    for (root, name, last_opened_at) in &desired {
        gateway
            .projects
            .allow_project(root, name.clone(), Some(last_opened_at.clone()))
            .map_err(|error| error.to_string())?;
    }

    let dropped = gateway
        .projects
        .persisted_projects()
        .into_iter()
        .filter(|project| !desired_roots.contains(&project.root))
        .map(|project| {
            gateway
                .projects
                .remove_project(&project.project_id)
                .map(|_| project)
        })
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;

    let next = gateway.projects.persisted_projects();
    if let Err(error) = persist_project_records(project_store_path, &next) {
        let _ = gateway
            .projects
            .replace_with_persisted_projects(previous.clone());
        return Err(error);
    }

    for project in &dropped {
        gateway.supervisor.cancel_project(&project.project_id);
        gateway.tasks.revoke_project(&project.project_id);
    }
    Ok(())
}

fn persist_project_records(path: &Path, projects: &[PersistedProject]) -> Result<(), String> {
    let projects = projects
        .iter()
        .cloned()
        .map(|project| PersistedProjectFile {
            project_id: project.project_id,
            root: project.root,
            name: project.name,
            last_opened_at: project.last_opened_at,
        })
        .collect::<Vec<_>>();
    let bytes = serde_json::to_vec_pretty(&projects)
        .map_err(|_| "project allowlist could not be encoded".to_owned())?;
    let parent = path
        .parent()
        .ok_or_else(|| "project allowlist path is invalid".to_owned())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("cannot create project allowlist directory: {error}"))?;
    let temp = parent.join(format!(
        ".remote-control-projects-{}.tmp",
        std::process::id()
    ));
    fs::write(&temp, bytes).map_err(|error| format!("cannot write project allowlist: {error}"))?;
    replace_file(&temp, path)
}

fn replace_file(temp: &Path, target: &Path) -> Result<(), String> {
    let backup = target.with_extension(format!("bak-{}", std::process::id()));
    let had_target = target.exists();
    if had_target {
        fs::rename(target, &backup)
            .map_err(|error| format!("cannot stage existing local state: {error}"))?;
    }
    if let Err(error) = fs::rename(temp, target) {
        if had_target {
            let _ = fs::rename(&backup, target);
        }
        return Err(format!("cannot commit local state: {error}"));
    }
    if had_target {
        fs::remove_file(&backup)
            .map_err(|error| format!("cannot finalize local state: {error}"))?;
    }
    Ok(())
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

struct JsonIdentityStore {
    path: PathBuf,
}

impl JsonIdentityStore {
    fn new(path: PathBuf) -> Self {
        Self { path }
    }
}

impl IdentityStore for JsonIdentityStore {
    fn load(&self) -> Result<Option<StoredIdentity>, IdentityError> {
        if !self.path.exists() {
            return Ok(None);
        }
        let bytes = fs::read(&self.path).map_err(|_| IdentityError::StoreUnavailable)?;
        serde_json::from_slice(&bytes)
            .map(Some)
            .map_err(|_| IdentityError::CorruptMaterial)
    }

    fn save(&self, identity: &StoredIdentity) -> Result<(), IdentityError> {
        let parent = self.path.parent().ok_or(IdentityError::StoreUnavailable)?;
        fs::create_dir_all(parent).map_err(|_| IdentityError::StoreUnavailable)?;
        let bytes = serde_json::to_vec(identity).map_err(|_| IdentityError::StoreUnavailable)?;
        let temp = parent.join(format!(
            ".remote-control-identity-{}.tmp",
            std::process::id()
        ));
        fs::write(&temp, bytes).map_err(|_| IdentityError::StoreUnavailable)?;
        fs::rename(&temp, &self.path).map_err(|_| IdentityError::StoreUnavailable)
    }

    fn clear(&self) -> Result<(), IdentityError> {
        if self.path.exists() {
            fs::remove_file(&self.path).map_err(|_| IdentityError::StoreUnavailable)?;
        }
        Ok(())
    }
}

#[cfg(any(test, feature = "remote-control-smoke"))]
mod command_smoke {
    use super::*;
    use serde_json::{json, Value};
    use std::net::{IpAddr, Ipv4Addr, SocketAddr, TcpListener, UdpSocket};
    use tauri::test::{get_ipc_response, mock_builder, mock_context, noop_assets, MockRuntime};
    use tauri::{webview::InvokeRequest, Url, WebviewWindowBuilder};

    fn test_app() -> tauri::App<MockRuntime> {
        mock_builder()
            .manage(RemoteControlState::default())
            .invoke_handler(tauri::generate_handler![
                remote_control_status,
                remote_control_private_addresses,
                remote_control_enable,
                remote_control_disable,
                remote_control_pairing_payload,
                remote_control_reset_identity,
                crate::projects::project_open
            ])
            .build(mock_context(noop_assets()))
            .expect("mock Tauri app should build")
    }

    fn request(command: &str, body: Value) -> InvokeRequest {
        InvokeRequest {
            cmd: command.to_owned(),
            callback: tauri::ipc::CallbackFn(0),
            error: tauri::ipc::CallbackFn(1),
            url: Url::parse("http://tauri.localhost").unwrap(),
            body: body.into(),
            headers: Default::default(),
            invoke_key: tauri::test::INVOKE_KEY.to_owned(),
        }
    }

    fn invoke(webview: &tauri::WebviewWindow<MockRuntime>, command: &str, body: Value) -> Value {
        get_ipc_response(webview, request(command, body))
            .unwrap_or_else(|error| panic!("Tauri command {command} failed: {error}"))
            .deserialize::<Value>()
            .expect("Tauri command response should be JSON")
    }

    fn private_interface_address() -> IpAddr {
        if let Some(value) = std::env::var_os("RAGCODE_REMOTE_CONTROL_SMOKE_ADDRESS") {
            return value
                .to_string_lossy()
                .parse()
                .expect("RAGCODE_REMOTE_CONTROL_SMOKE_ADDRESS must be an IP address");
        }
        let socket = UdpSocket::bind(SocketAddr::new(IpAddr::V4(Ipv4Addr::UNSPECIFIED), 0))
            .expect("UDP socket should bind for interface discovery");
        socket
            .connect(SocketAddr::new(
                IpAddr::V4(Ipv4Addr::new(192, 168, 31, 132)),
                9,
            ))
            .expect("LAN route should be discoverable");
        let address = socket.local_addr().expect("local LAN address").ip();
        assert!(matches!(address, IpAddr::V4(value) if {
            let octets = value.octets();
            octets[0] == 10
                || (octets[0] == 172 && (16..=31).contains(&octets[1]))
                || (octets[0] == 192 && octets[1] == 168)
        }));
        address
    }

    fn free_port(address: IpAddr) -> u16 {
        TcpListener::bind(SocketAddr::new(address, 0))
            .expect("selected LAN interface should accept a probe bind")
            .local_addr()
            .expect("probe address")
            .port()
    }

    pub fn run() {
        if std::env::var_os("RAGCODE_REMOTE_CONTROL_DATA_DIR").is_none() {
            let workspace = Path::new(env!("CARGO_MANIFEST_DIR"))
                .parent()
                .expect("src-tauri should have a workspace parent");
            std::env::set_var(
                "RAGCODE_REMOTE_CONTROL_DATA_DIR",
                workspace
                    .join(".tmp")
                    .join("remote-control")
                    .join(format!("command-smoke-data-{}", std::process::id())),
            );
        }
        let data_dir = PathBuf::from(
            std::env::var_os("RAGCODE_REMOTE_CONTROL_DATA_DIR")
                .expect("remote-control smoke data directory should be configured"),
        );
        if std::env::var_os("RAGCODE_DESKTOP_STATE_PATH").is_none() {
            std::env::set_var("RAGCODE_DESKTOP_STATE_PATH", data_dir.join("desktop.json"));
        }
        let project_a = data_dir.join("projects").join("current-project-a");
        let project_b = data_dir.join("projects").join("current-project-b");
        fs::create_dir_all(&project_a).expect("first desktop project fixture");
        fs::create_dir_all(&project_b).expect("second desktop project fixture");
        let safe_config = PersistedRemoteControlConfig {
            schema_version: REMOTE_CONTROL_CONFIG_SCHEMA_VERSION,
            enabled: true,
            selected_addresses: vec!["192.168.31.199".to_owned()],
            port: 8443,
        };
        assert!(safe_config.validate().is_ok());
        let mut unsupported = safe_config.clone();
        unsupported.schema_version += 1;
        assert!(unsupported.validate().is_err());
        let mut wildcard = safe_config.clone();
        wildcard.selected_addresses = vec!["0.0.0.0".to_owned()];
        assert!(wildcard.validate().is_err());
        let mut invalid_port = safe_config;
        invalid_port.port = 0;
        assert!(invalid_port.validate().is_err());

        let app = test_app();
        app.state::<RemoteControlState>()
            .restore_on_startup(app.handle())
            .expect("missing config should keep the gateway disabled");
        let webview = WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .expect("mock webview should build");
        let address = private_interface_address();
        let port = free_port(address);

        let disabled = invoke(&webview, "remote_control_status", json!({}));
        assert_eq!(disabled["enabled"], false);
        let opened = invoke(
            &webview,
            "project_open",
            json!({ "path": project_a.to_string_lossy() }),
        );
        assert!(opened.as_str().is_some());

        let enabled = invoke(
            &webview,
            "remote_control_enable",
            json!({
                "request": {
                    "selectedAddresses": [address.to_string()],
                    "port": port
                }
            }),
        );
        assert_eq!(enabled["enabled"], true);
        assert_eq!(enabled["selectedAddresses"], json!([address.to_string()]));
        let projects = enabled["projects"]
            .as_array()
            .expect("enabled status should include the desktop project");
        assert_eq!(projects.len(), 1);
        assert_eq!(projects[0]["name"], "current-project-a");
        let config_path = remote_control_config_path(app.handle()).expect("config path");
        let saved = load_remote_control_config(&config_path)
            .expect("saved config should be readable")
            .expect("enable should persist config");
        assert!(saved.enabled);
        assert_eq!(saved.selected_addresses, vec![address.to_string()]);
        assert_eq!(saved.port, port);

        let pairing = invoke(&webview, "remote_control_pairing_payload", json!({}));
        assert!(pairing["pairingId"].as_str().is_some());
        assert!(pairing["secret"].as_str().is_some());
        assert_eq!(pairing["certificatePin"]["algorithm"], "spki-sha256");
        assert!(pairing.get("wakeOnLan").is_none());
        let first_epoch = enabled["identityEpoch"].as_u64().expect("identity epoch");

        let reset = invoke(&webview, "remote_control_reset_identity", json!({}));
        assert_eq!(reset["enabled"], true);
        assert!(reset["identityEpoch"].as_u64().unwrap() > first_epoch);
        assert_eq!(reset["pairedDevices"], json!([]));
        assert_eq!(reset["projects"].as_array().map(Vec::len), Some(1));

        let opened = invoke(
            &webview,
            "project_open",
            json!({ "path": project_b.to_string_lossy() }),
        );
        assert!(opened.as_str().is_some());
        let switched = invoke(&webview, "remote_control_status", json!({}));
        let projects = switched["projects"]
            .as_array()
            .expect("switched status should include the desktop projects");
        assert_eq!(projects.len(), 2, "recent projects stay visible on mobile");
        let switched_names = projects
            .iter()
            .map(|p| p["name"].as_str().unwrap_or_default())
            .collect::<Vec<_>>();
        assert!(switched_names.contains(&"current-project-a"));
        assert!(switched_names.contains(&"current-project-b"));
        let second_project_id = projects
            .iter()
            .find(|p| p["name"].as_str() == Some("current-project-b"))
            .and_then(|p| p["projectId"].as_str())
            .expect("opened project should have an opaque id")
            .to_owned();

        // A normal application exit stops only the listener. The durable
        // preference remains enabled and a fresh state restores it on launch.
        app.state::<RemoteControlState>().shutdown();
        let saved = load_remote_control_config(&config_path)
            .expect("saved config should remain readable")
            .expect("shutdown must retain config");
        assert!(saved.enabled);
        drop(webview);
        drop(app);

        let app = test_app();
        app.state::<RemoteControlState>()
            .restore_on_startup(app.handle())
            .expect("enabled config should restore the listener");
        let webview = WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .expect("restored mock webview should build");
        let restored = invoke(&webview, "remote_control_status", json!({}));
        assert_eq!(restored["enabled"], true);
        assert_eq!(restored["selectedAddresses"], json!([address.to_string()]));
        assert_eq!(restored["port"], port);
        let projects = restored["projects"]
            .as_array()
            .expect("restored status should include the desktop projects");
        assert_eq!(
            projects.len(),
            2,
            "recent projects survive a desktop restart"
        );
        let restored_b = projects
            .iter()
            .find(|p| p["name"].as_str() == Some("current-project-b"))
            .expect("recent project should survive a desktop restart");
        assert_eq!(restored_b["projectId"], json!(second_project_id));

        let disabled = invoke(&webview, "remote_control_disable", json!({}));
        assert_eq!(disabled["enabled"], false);
        assert_eq!(disabled["selectedAddresses"], json!([address.to_string()]));
        assert_eq!(disabled["port"], port);
        let saved = load_remote_control_config(&config_path)
            .expect("disabled config should be readable")
            .expect("disable should retain network config");
        assert!(!saved.enabled);
        assert_eq!(saved.selected_addresses, vec![address.to_string()]);
        assert_eq!(saved.port, port);

        drop(webview);
        drop(app);
        let app = test_app();
        app.state::<RemoteControlState>()
            .restore_on_startup(app.handle())
            .expect("disabled config should restore without starting a listener");
        let webview = WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .expect("disabled-state mock webview should build");
        let disabled = invoke(&webview, "remote_control_status", json!({}));
        assert_eq!(disabled["enabled"], false);
        assert_eq!(disabled["selectedAddresses"], json!([address.to_string()]));
        assert_eq!(disabled["port"], port);

        // Corrupt startup state is never overwritten or used to bind a
        // listener; the diagnostic remains available through status.
        drop(webview);
        drop(app);
        fs::write(&config_path, b"{not-json").expect("corrupt config fixture");
        let app = test_app();
        let error = app
            .state::<RemoteControlState>()
            .restore_on_startup(app.handle())
            .expect_err("corrupt config must fail closed");
        assert!(error.contains("config unavailable"));
        let webview = WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .expect("failure-state mock webview should build");
        let failed = invoke(&webview, "remote_control_status", json!({}));
        assert_eq!(failed["enabled"], false);
        assert!(failed["lastError"]
            .as_str()
            .is_some_and(|message| message.contains("config unavailable")));
        assert_eq!(fs::read(&config_path).unwrap(), b"{not-json");
    }
}

#[cfg(test)]
mod tests {
    use super::{discover_private_addresses, is_private_lan_address};
    use std::net::{IpAddr, Ipv4Addr};

    #[test]
    fn private_address_discovery_returns_only_rfc1918_ipv4() {
        assert!(is_private_lan_address(IpAddr::V4(Ipv4Addr::new(
            10, 1, 2, 3
        ))));
        assert!(is_private_lan_address(IpAddr::V4(Ipv4Addr::new(
            172, 16, 0, 1
        ))));
        assert!(is_private_lan_address(IpAddr::V4(Ipv4Addr::new(
            192, 168, 31, 199
        ))));
        assert!(!is_private_lan_address(IpAddr::V4(Ipv4Addr::new(
            172, 32, 0, 1
        ))));
        assert!(!is_private_lan_address(IpAddr::V4(Ipv4Addr::new(
            1, 1, 1, 1
        ))));
        assert!(discover_private_addresses()
            .into_iter()
            .all(|address| address.parse().is_ok_and(is_private_lan_address)));
    }

    #[test]
    fn tauri_commands_cover_enable_pairing_reset_disable_lifecycle() {
        super::command_smoke::run();
    }
}

#[cfg(feature = "remote-control-smoke")]
pub(crate) use command_smoke::run as run_command_smoke;
