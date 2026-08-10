use std::fmt;
use std::time::{Duration, Instant};
use thiserror::Error;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ShutdownStage {
    StopAccepting,
    CloseInputs,
    CancelWork,
    TerminateProcesses,
    FlushDiagnostics,
    JoinWorkers,
}

impl fmt::Display for ShutdownStage {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{self:?}")
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ShutdownReport {
    pub completed: Vec<ShutdownStage>,
    pub elapsed: Duration,
}

#[derive(Debug, Error)]
pub enum ShutdownError {
    #[error("shutdown deadline expired before {stage}")]
    Deadline { stage: ShutdownStage },
    #[error("shutdown stage {stage} failed: {detail}")]
    Stage {
        stage: ShutdownStage,
        detail: String,
    },
}

pub type ShutdownHook<'a> = Box<dyn FnMut(Duration) -> Result<(), String> + 'a>;

pub struct ShutdownCoordinator<'a> {
    hooks: Vec<(ShutdownStage, ShutdownHook<'a>)>,
}

impl<'a> ShutdownCoordinator<'a> {
    pub fn new() -> Self {
        Self { hooks: Vec::new() }
    }

    pub fn push(
        &mut self,
        stage: ShutdownStage,
        hook: impl FnMut(Duration) -> Result<(), String> + 'a,
    ) {
        self.hooks.push((stage, Box::new(hook)));
    }

    pub fn run(mut self, timeout: Duration) -> Result<ShutdownReport, ShutdownError> {
        let started = Instant::now();
        let deadline = started + timeout;
        let mut completed = Vec::with_capacity(self.hooks.len());
        for (stage, hook) in &mut self.hooks {
            let remaining = deadline
                .checked_duration_since(Instant::now())
                .ok_or(ShutdownError::Deadline { stage: *stage })?;
            hook(remaining).map_err(|detail| ShutdownError::Stage {
                stage: *stage,
                detail,
            })?;
            if Instant::now() >= deadline {
                return Err(ShutdownError::Deadline { stage: *stage });
            }
            completed.push(*stage);
        }
        Ok(ShutdownReport {
            completed,
            elapsed: started.elapsed(),
        })
    }
}

impl Default for ShutdownCoordinator<'_> {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    #[test]
    fn shutdown_is_ordered_and_bounded() {
        let observed = Arc::new(Mutex::new(Vec::new()));
        let mut coordinator = ShutdownCoordinator::new();
        for stage in [
            ShutdownStage::StopAccepting,
            ShutdownStage::CloseInputs,
            ShutdownStage::CancelWork,
            ShutdownStage::TerminateProcesses,
            ShutdownStage::FlushDiagnostics,
            ShutdownStage::JoinWorkers,
        ] {
            let observed = Arc::clone(&observed);
            coordinator.push(stage, move |remaining| {
                assert!(remaining > Duration::ZERO);
                observed.lock().unwrap().push(stage);
                Ok(())
            });
        }
        let report = coordinator.run(Duration::from_secs(1)).unwrap();
        assert_eq!(*observed.lock().unwrap(), report.completed);
        assert!(report.elapsed < Duration::from_secs(1));
    }

    #[test]
    fn rejects_a_hook_that_overruns_its_deadline() {
        let mut coordinator = ShutdownCoordinator::new();
        coordinator.push(ShutdownStage::TerminateProcesses, |_| {
            std::thread::sleep(Duration::from_millis(25));
            Ok(())
        });
        assert!(matches!(
            coordinator.run(Duration::from_millis(5)),
            Err(ShutdownError::Deadline {
                stage: ShutdownStage::TerminateProcesses
            })
        ));
    }
}
