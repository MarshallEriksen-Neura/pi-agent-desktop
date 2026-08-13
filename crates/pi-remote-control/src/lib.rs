//! pi-remote-control: Tauri-free Axum LAN gateway for mobile remote control.
//!
//! Stage 1 owns the Tauri-free wire DTOs and the in-memory domain contracts.
//! Hosting, persistence and Pi process execution remain separate stages.

pub mod config;
pub mod conversation_protocol;
pub mod conversation_runtime;
pub mod device_store;
pub mod event_hub;
pub mod gateway;
pub mod identity;
pub mod interaction;
pub mod pairing;
pub mod pi_session;
pub mod principal;
pub mod project_catalog;
pub mod protocol;
pub mod observability;
pub mod storage;
pub mod task_manager;
pub mod task_runtime;
pub mod task_supervisor;
