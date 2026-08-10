use crate::event_hub::{EventHub, EventPayload};
use crate::principal::{Principal, RemoteScope};
use crate::protocol::{
    RemoteInteractionRequest, RemoteInteractionResponse, RemoteInteractionSnapshot,
    RemoteInteractionStatus, ValidationError,
};
use crate::task_manager::{Clock, SystemClock};
use std::collections::HashMap;
use std::fmt;
use std::sync::{Arc, Mutex};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InteractionError {
    Unauthorized,
    NotFound,
    InvalidRequest(ValidationError),
    InvalidResponse(ValidationError),
    Expired,
    AlreadyResolved,
}

impl fmt::Display for InteractionError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Unauthorized | Self::NotFound | Self::Expired | Self::AlreadyResolved => {
                write!(f, "interaction is not available")
            }
            Self::InvalidRequest(error) | Self::InvalidResponse(error) => error.fmt(f),
        }
    }
}

impl std::error::Error for InteractionError {}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InteractionResponseOutcome {
    pub snapshot: RemoteInteractionSnapshot,
    pub duplicate: bool,
}

#[derive(Debug, Clone)]
struct InteractionRecord {
    owner_device_id: String,
    expires_at_ms: u64,
    snapshot: RemoteInteractionSnapshot,
}

pub struct InteractionManager {
    clock: Arc<dyn Clock>,
    event_hub: Arc<EventHub>,
    inner: Mutex<HashMap<String, InteractionRecord>>,
}

impl InteractionManager {
    pub fn new(event_hub: Arc<EventHub>) -> Self {
        Self::with_clock(event_hub, Arc::new(SystemClock))
    }

    pub fn with_clock(event_hub: Arc<EventHub>, clock: Arc<dyn Clock>) -> Self {
        Self {
            clock,
            event_hub,
            inner: Mutex::new(HashMap::new()),
        }
    }

    pub fn create(
        &self,
        principal: &Principal,
        request: RemoteInteractionRequest,
    ) -> Result<RemoteInteractionSnapshot, InteractionError> {
        let expires_at_ms = parse_timestamp_ms(&request.expires_at).ok_or(
            InteractionError::InvalidRequest(ValidationError::InvalidValue { field: "expiresAt" }),
        )?;
        self.create_at(principal, request, expires_at_ms)
    }

    pub fn create_at(
        &self,
        principal: &Principal,
        request: RemoteInteractionRequest,
        expires_at_ms: u64,
    ) -> Result<RemoteInteractionSnapshot, InteractionError> {
        request
            .validate()
            .map_err(InteractionError::InvalidRequest)?;
        let now = self.clock.now();
        if expires_at_ms <= now.unix_ms {
            return Err(InteractionError::Expired);
        }
        let snapshot = RemoteInteractionSnapshot {
            interaction_id: request.interaction_id.clone(),
            task_id: request.task_id.clone(),
            kind: request.kind.clone(),
            status: RemoteInteractionStatus::Pending,
            prompt: request.prompt,
            options: request.options,
            created_at: request.created_at,
            expires_at: request.expires_at,
            resolved_at: None,
            response: None,
        };
        let owner_device_id = principal.device_id().to_owned();
        let mut inner = self.lock_inner();
        if inner.contains_key(&snapshot.interaction_id) {
            return Err(InteractionError::AlreadyResolved);
        }
        if inner.len() >= 4096 {
            return Err(InteractionError::InvalidRequest(ValidationError::TooMany {
                field: "interactions",
                max: 4096,
            }));
        }
        inner.insert(
            snapshot.interaction_id.clone(),
            InteractionRecord {
                owner_device_id: owner_device_id.clone(),
                expires_at_ms,
                snapshot: snapshot.clone(),
            },
        );
        drop(inner);
        self.event_hub.publish(
            &owner_device_id,
            now.timestamp,
            EventPayload::InteractionRequested {
                interaction_id: snapshot.interaction_id.clone(),
                task_id: snapshot.task_id.clone(),
                interaction_kind: snapshot.kind.clone(),
                prompt: snapshot.prompt.clone(),
                expires_at: snapshot.expires_at.clone(),
            },
        );
        Ok(snapshot)
    }

    pub fn snapshot(
        &self,
        principal: &Principal,
        interaction_id: &str,
    ) -> Result<RemoteInteractionSnapshot, InteractionError> {
        principal
            .require(RemoteScope::RespondToOwnedInteractions)
            .map_err(|_| InteractionError::Unauthorized)?;
        let inner = self.lock_inner();
        let record = inner
            .get(interaction_id)
            .ok_or(InteractionError::NotFound)?;
        if !principal.owns(&record.owner_device_id) {
            return Err(InteractionError::NotFound);
        }
        Ok(record.snapshot.clone())
    }

    pub fn list_owned(
        &self,
        principal: &Principal,
    ) -> Result<Vec<RemoteInteractionSnapshot>, InteractionError> {
        principal
            .require(RemoteScope::RespondToOwnedInteractions)
            .map_err(|_| InteractionError::Unauthorized)?;
        let inner = self.lock_inner();
        let mut snapshots = inner
            .values()
            .filter(|record| principal.owns(&record.owner_device_id))
            .map(|record| record.snapshot.clone())
            .collect::<Vec<_>>();
        snapshots.sort_by(|left, right| {
            right
                .created_at
                .cmp(&left.created_at)
                .then_with(|| right.interaction_id.cmp(&left.interaction_id))
        });
        Ok(snapshots)
    }

    pub fn respond(
        &self,
        principal: &Principal,
        response: RemoteInteractionResponse,
    ) -> Result<InteractionResponseOutcome, InteractionError> {
        principal
            .require(RemoteScope::RespondToOwnedInteractions)
            .map_err(|_| InteractionError::Unauthorized)?;
        let now = self.clock.now();
        let mut inner = self.lock_inner();
        let record = inner
            .get_mut(&response.interaction_id)
            .ok_or(InteractionError::NotFound)?;
        if !principal.owns(&record.owner_device_id) {
            return Err(InteractionError::NotFound);
        }
        if record.snapshot.status != RemoteInteractionStatus::Pending {
            if record.snapshot.response.as_ref() == Some(&response) {
                return Ok(InteractionResponseOutcome {
                    snapshot: record.snapshot.clone(),
                    duplicate: true,
                });
            }
            return Err(InteractionError::AlreadyResolved);
        }
        if record.expires_at_ms <= now.unix_ms {
            record.snapshot.status = RemoteInteractionStatus::Expired;
            record.snapshot.resolved_at = Some(now.timestamp.clone());
            let owner_device_id = record.owner_device_id.clone();
            let task_id = record.snapshot.task_id.clone();
            let interaction_id = record.snapshot.interaction_id.clone();
            drop(inner);
            self.event_hub.publish(
                &owner_device_id,
                now.timestamp,
                EventPayload::InteractionExpired {
                    interaction_id,
                    task_id,
                },
            );
            return Err(InteractionError::Expired);
        }
        response
            .validate(record.snapshot.options.as_deref())
            .map_err(InteractionError::InvalidResponse)?;
        if response.kind != record.snapshot.kind {
            return Err(InteractionError::InvalidResponse(
                ValidationError::InvalidValue { field: "kind" },
            ));
        }
        record.snapshot.status = RemoteInteractionStatus::Resolved;
        record.snapshot.resolved_at = Some(now.timestamp.clone());
        record.snapshot.response = Some(response.clone());
        let snapshot = record.snapshot.clone();
        let task_id = snapshot.task_id.clone();
        let owner_device_id = record.owner_device_id.clone();
        drop(inner);
        self.event_hub.publish(
            &owner_device_id,
            now.timestamp,
            EventPayload::InteractionResolved {
                interaction_id: snapshot.interaction_id.clone(),
                task_id,
                response,
            },
        );
        Ok(InteractionResponseOutcome {
            snapshot,
            duplicate: false,
        })
    }

    pub fn expire_due(&self) -> Vec<RemoteInteractionSnapshot> {
        let now = self.clock.now();
        let mut inner = self.lock_inner();
        let mut expired = Vec::new();
        for record in inner.values_mut() {
            if record.snapshot.status == RemoteInteractionStatus::Pending
                && record.expires_at_ms <= now.unix_ms
            {
                record.snapshot.status = RemoteInteractionStatus::Expired;
                record.snapshot.resolved_at = Some(now.timestamp.clone());
                expired.push((
                    record.owner_device_id.clone(),
                    record.snapshot.interaction_id.clone(),
                    record.snapshot.task_id.clone(),
                    record.snapshot.clone(),
                ));
            }
        }
        drop(inner);
        for (owner, interaction_id, task_id, _) in &expired {
            self.event_hub.publish(
                owner,
                now.timestamp.clone(),
                EventPayload::InteractionExpired {
                    interaction_id: interaction_id.clone(),
                    task_id: task_id.clone(),
                },
            );
        }
        expired
            .into_iter()
            .map(|(_, _, _, snapshot)| snapshot)
            .collect()
    }

    pub fn pending_len(&self) -> usize {
        self.lock_inner()
            .values()
            .filter(|record| record.snapshot.status == RemoteInteractionStatus::Pending)
            .count()
    }

    fn lock_inner(&self) -> std::sync::MutexGuard<'_, HashMap<String, InteractionRecord>> {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

fn parse_timestamp_ms(value: &str) -> Option<u64> {
    if value.len() < 24 || !value.ends_with('Z') {
        return None;
    }
    let year = value.get(0..4)?.parse::<i64>().ok()?;
    let month = value.get(5..7)?.parse::<i64>().ok()?;
    let day = value.get(8..10)?.parse::<i64>().ok()?;
    let hour = value.get(11..13)?.parse::<u64>().ok()?;
    let minute = value.get(14..16)?.parse::<u64>().ok()?;
    let second = value.get(17..19)?.parse::<u64>().ok()?;
    let millis = if value.as_bytes().get(19) == Some(&b'.') {
        value.get(20..23)?.parse::<u64>().ok()?
    } else {
        0
    };
    if month == 0 || month > 12 || day == 0 || day > 31 || hour > 23 || minute > 59 || second > 59 {
        return None;
    }
    let days = days_from_civil(year, month, day)?;
    Some((days as u64 * 86_400 + hour * 3_600 + minute * 60 + second) * 1000 + millis)
}

fn days_from_civil(year: i64, month: i64, day: i64) -> Option<i64> {
    let adjusted_year = year - if month <= 2 { 1 } else { 0 };
    let era = if adjusted_year >= 0 {
        adjusted_year
    } else {
        adjusted_year - 399
    } / 400;
    let year_of_era = adjusted_year - era * 400;
    let month_prime = month + if month > 2 { -3 } else { 9 };
    let day_of_year = (153 * month_prime + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    Some(era * 146_097 + day_of_era - 719_468)
}
