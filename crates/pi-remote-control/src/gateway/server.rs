use crate::config::{BindPolicyError, RemoteControlConfig};
use crate::identity::CertificateIdentity;
use axum::Router;
use hyper_util::rt::TokioIo;
use hyper_util::service::TowerToHyperService;
use rustls::ServerConfig;
use std::fmt;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::watch;
use tokio::task::{JoinHandle, JoinSet};
use tokio::time::{timeout, Instant};
use tokio_rustls::TlsAcceptor;
use tower::Service;

pub const STARTUP_DEADLINE: Duration = Duration::from_secs(5);
pub const SHUTDOWN_DEADLINE: Duration = Duration::from_secs(10);

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GatewayServerError {
    Disabled,
    BindPolicy(BindPolicyError),
    StartupTimeout,
    BindFailed,
    ShutdownDeadlineExceeded,
}

impl fmt::Display for GatewayServerError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("remote control gateway lifecycle operation failed")
    }
}

impl std::error::Error for GatewayServerError {}

pub struct GatewayServer {
    shutdown: watch::Sender<bool>,
    workers: Vec<JoinHandle<()>>,
}

impl GatewayServer {
    pub async fn start(
        config: &RemoteControlConfig,
        router: Router,
        tls: Arc<ServerConfig>,
    ) -> Result<Self, GatewayServerError> {
        if !config.is_enabled() {
            return Err(GatewayServerError::Disabled);
        }
        let addresses = config
            .selected_socket_addresses()
            .map_err(GatewayServerError::BindPolicy)?;
        let deadline = Instant::now() + STARTUP_DEADLINE;
        let mut listeners = Vec::with_capacity(addresses.len());
        for address in addresses {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(GatewayServerError::StartupTimeout);
            }
            let listener = timeout(remaining, TcpListener::bind(address))
                .await
                .map_err(|_| GatewayServerError::StartupTimeout)?
                .map_err(|_| GatewayServerError::BindFailed)?;
            listeners.push(listener);
        }

        let (shutdown, shutdown_rx) = watch::channel(false);
        let acceptor = TlsAcceptor::from(tls);
        let mut workers = Vec::with_capacity(listeners.len());
        for listener in listeners {
            let router = router.clone();
            let acceptor = acceptor.clone();
            let shutdown_rx = shutdown_rx.clone();
            workers.push(tokio::spawn(accept_loop(
                listener,
                router,
                acceptor,
                shutdown_rx,
            )));
        }
        Ok(Self { shutdown, workers })
    }

    pub async fn shutdown(mut self) -> Result<(), GatewayServerError> {
        let _ = self.shutdown.send(true);
        let join = async {
            for worker in &mut self.workers {
                let _ = worker.await;
            }
        };
        if timeout(SHUTDOWN_DEADLINE, join).await.is_err() {
            for worker in &self.workers {
                worker.abort();
            }
            return Err(GatewayServerError::ShutdownDeadlineExceeded);
        }
        Ok(())
    }
}

async fn accept_loop(
    listener: TcpListener,
    router: Router,
    acceptor: TlsAcceptor,
    mut shutdown: watch::Receiver<bool>,
) {
    let mut connections = JoinSet::new();
    loop {
        tokio::select! {
            changed = shutdown.changed() => {
                if changed.is_err() || *shutdown.borrow() {
                    break;
                }
            }
            accepted = listener.accept() => {
                let Ok((stream, remote_addr)) = accepted else { break };
                let router = router.clone();
                let acceptor = acceptor.clone();
                connections.spawn(async move {
                    serve_connection(stream, remote_addr, router, acceptor).await;
                });
            }
            joined = connections.join_next(), if !connections.is_empty() => {
                let _ = joined;
            }
        }
    }
    connections.abort_all();
    while connections.join_next().await.is_some() {}
}

async fn serve_connection(
    stream: TcpStream,
    remote_addr: SocketAddr,
    router: Router,
    acceptor: TlsAcceptor,
) {
    let Ok(stream) = acceptor.accept(stream).await else {
        return;
    };
    let io = TokioIo::new(stream);
    let mut make_service = router.into_make_service();
    let service = make_service
        .call(remote_addr)
        .await
        .expect("Axum Router service construction is infallible");
    let service = TowerToHyperService::new(service);
    let _ = hyper::server::conn::http1::Builder::new()
        .serve_connection(io, service)
        .with_upgrades()
        .await;
}

pub fn tls_identity_is_usable(identity: &CertificateIdentity) -> bool {
    !identity.certificate_der().is_empty() && !identity.private_key_der().is_empty()
}
