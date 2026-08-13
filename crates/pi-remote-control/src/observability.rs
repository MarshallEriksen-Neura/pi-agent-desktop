//! Redacted v2 gateway observability.
//!
//! Counters contain no request content, filesystem material, session identity,
//! or provider data. Dynamic queue/active values are read from SQLite by the
//! diagnostics handler; event counters are process-local and monotonic.

use std::sync::atomic::{AtomicU64, Ordering};

#[derive(Default)]
pub struct V2Metrics {
    pub resume_success: AtomicU64,
    pub resume_failure: AtomicU64,
    pub host_interrupted_turns: AtomicU64,
    pub duplicate_requests: AtomicU64,
    pub dropped_deltas: AtomicU64,
    pub snapshot_resyncs: AtomicU64,
}

impl V2Metrics {
    pub fn inc_resume_success(&self) {
        self.resume_success.fetch_add(1, Ordering::Relaxed);
    }

    pub fn inc_resume_failure(&self) {
        self.resume_failure.fetch_add(1, Ordering::Relaxed);
    }

    pub fn inc_host_interrupted_turns(&self, count: u64) {
        self.host_interrupted_turns.fetch_add(count, Ordering::Relaxed);
    }

    pub fn inc_duplicate_requests(&self) {
        self.duplicate_requests.fetch_add(1, Ordering::Relaxed);
    }

    pub fn inc_dropped_deltas(&self) {
        self.dropped_deltas.fetch_add(1, Ordering::Relaxed);
    }

    pub fn inc_snapshot_resyncs(&self) {
        self.snapshot_resyncs.fetch_add(1, Ordering::Relaxed);
    }

    pub fn snapshot(&self) -> V2MetricSnapshot {
        V2MetricSnapshot {
            resume_success: self.resume_success.load(Ordering::Relaxed),
            resume_failure: self.resume_failure.load(Ordering::Relaxed),
            host_interrupted_turns: self.host_interrupted_turns.load(Ordering::Relaxed),
            duplicate_requests: self.duplicate_requests.load(Ordering::Relaxed),
            dropped_deltas: self.dropped_deltas.load(Ordering::Relaxed),
            snapshot_resyncs: self.snapshot_resyncs.load(Ordering::Relaxed),
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct V2MetricSnapshot {
    pub resume_success: u64,
    pub resume_failure: u64,
    pub host_interrupted_turns: u64,
    pub duplicate_requests: u64,
    pub dropped_deltas: u64,
    pub snapshot_resyncs: u64,
}
