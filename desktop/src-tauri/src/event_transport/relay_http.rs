//! The seam's default implementation: the NIP-98 authenticated HTTP relay
//! path buzz has always used.
//!
//! This is the one place in the tree that still builds a NIP-98 auth header
//! and `POST`s a signed event to `/events` — every call site that used to do
//! this itself now builds a [`SignedEventSubmission`] and calls
//! [`super::dispatch`] instead (see the module doc for the full list).
//! `desktop/scripts/check-rust-transport-seam.mjs` keeps it that way.

use reqwest::Method;

use super::{EventTransport, SignedEventSubmission};
use crate::app_state::AppState;
use crate::relay::{
    build_nip98_auth_header_for_keys, classify_request_error, parse_json_response,
    relay_error_message, SubmitEventResponse,
};

pub struct RelayHttpTransport;

#[async_trait::async_trait]
impl EventTransport for RelayHttpTransport {
    async fn submit(
        &self,
        state: &AppState,
        submission: SignedEventSubmission<'_>,
    ) -> Result<SubmitEventResponse, String> {
        // Wait before signing the NIP-98 auth header: the relay enforces
        // ±60s freshness on it, and the gate may hold for up to
        // MAX_HINT_SECONDS (300s). The event itself was already signed by
        // the caller — callers that need the event's own timestamp fresh
        // too (huddle STT) wait before calling `dispatch` as well; this wait
        // is then a harmless immediate no-op the second time.
        crate::relay_admission::wait_for_rate_limit().await;

        let auth_header = build_nip98_auth_header_for_keys(
            submission.keys,
            &Method::POST,
            &submission.api_url,
            submission.body,
        )?;

        let mut request = state
            .http_client
            .post(&submission.api_url)
            .header("Authorization", auth_header)
            .header("Content-Type", "application/json");
        if let Some(tag) = submission.auth_tag {
            request = request.header("x-auth-tag", tag);
        }

        let response = request
            .body(submission.body.to_vec())
            .send()
            .await
            .map_err(|e| classify_request_error(&e))?;

        if !response.status().is_success() {
            return Err(relay_error_message(response).await);
        }

        let result: SubmitEventResponse = parse_json_response(response).await?;
        if !result.accepted {
            return Err(format!("relay rejected event: {}", result.message));
        }

        Ok(result)
    }
}
