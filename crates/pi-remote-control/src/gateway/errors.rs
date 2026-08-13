use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Serialize;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct GatewayErrorBody {
    pub code: &'static str,
    pub message: &'static str,
    #[serde(rename = "requestId", skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GatewayError {
    InvalidRequest,
    Unauthorized,
    Forbidden,
    NotFound,
    Conflict,
    PayloadTooLarge,
    RateLimited,
    ServiceUnavailable,
    Internal,
    InteractionPending,
    QueueLimitReached,
}

impl GatewayError {
    pub fn with_request_id(self, request_id: Option<String>) -> GatewayErrorResponse {
        GatewayErrorResponse {
            error: self,
            request_id,
        }
    }

    fn status_code(self) -> StatusCode {
        match self {
            Self::InvalidRequest => StatusCode::BAD_REQUEST,
            Self::Unauthorized => StatusCode::UNAUTHORIZED,
            Self::Forbidden => StatusCode::FORBIDDEN,
            Self::NotFound => StatusCode::NOT_FOUND,
            Self::Conflict => StatusCode::CONFLICT,
            Self::PayloadTooLarge => StatusCode::PAYLOAD_TOO_LARGE,
            Self::RateLimited => StatusCode::TOO_MANY_REQUESTS,
            Self::ServiceUnavailable => StatusCode::SERVICE_UNAVAILABLE,
            Self::Internal => StatusCode::INTERNAL_SERVER_ERROR,
            Self::InteractionPending => StatusCode::CONFLICT,
            Self::QueueLimitReached => StatusCode::CONFLICT,
        }
    }

    fn code(self) -> &'static str {
        match self {
            Self::InvalidRequest => "invalid_request",
            Self::Unauthorized => "unauthorized",
            Self::Forbidden => "forbidden",
            Self::NotFound => "not_found",
            Self::Conflict => "conflict",
            Self::PayloadTooLarge => "payload_too_large",
            Self::RateLimited => "rate_limited",
            Self::ServiceUnavailable => "service_unavailable",
            Self::Internal => "internal_error",
            Self::InteractionPending => "interaction_pending",
            Self::QueueLimitReached => "queue_full",
        }
    }

    fn message(self) -> &'static str {
        match self {
            Self::InvalidRequest => "request is invalid",
            Self::Unauthorized => "authentication is required",
            Self::Forbidden => "operation is not permitted",
            Self::NotFound => "resource is not available",
            Self::Conflict => "request conflicts with current state",
            Self::PayloadTooLarge => "request body is too large",
            Self::RateLimited => "request rate limit exceeded",
            Self::ServiceUnavailable => "remote control is unavailable",
            Self::Internal => "remote control request failed",
            Self::InteractionPending => "an interaction is awaiting a response",
            Self::QueueLimitReached => "the conversation turn queue is full",
        }
    }
}

#[derive(Debug, Clone)]
pub struct GatewayErrorResponse {
    error: GatewayError,
    request_id: Option<String>,
}

impl IntoResponse for GatewayErrorResponse {
    fn into_response(self) -> Response {
        (
            self.error.status_code(),
            Json(GatewayErrorBody {
                code: self.error.code(),
                message: self.error.message(),
                request_id: self.request_id,
            }),
        )
            .into_response()
    }
}

impl IntoResponse for GatewayError {
    fn into_response(self) -> Response {
        self.with_request_id(None).into_response()
    }
}

pub fn request_id(headers: &axum::http::HeaderMap) -> Option<String> {
    let value = headers.get("x-request-id")?.to_str().ok()?;
    if value.is_empty() || value.len() > 128 || value.chars().any(char::is_control) {
        return None;
    }
    Some(value.to_owned())
}
