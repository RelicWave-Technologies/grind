//! `legacy/agent/src/main/ipc/insights.ts`: today's productivity score.

use serde::{Deserialize, Serialize};

use crate::api::ApiClient;
use crate::http::RequestOptions;
use crate::tokens::TokenStore;
use crate::urlenc::encode_uri_component;

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Score {
    pub score: f64,
    pub tracked_minutes: f64,
    pub engaged_minutes: f64,
    pub protected_minutes: f64,
    pub idle_minutes: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Totals {
    pub keystrokes: f64,
    pub clicks: f64,
    pub mouse_distance_px: f64,
    pub scroll_events: f64,
}

/// `InsightsToday`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InsightsToday {
    pub day: String,
    pub score: Score,
    pub totals: Totals,
    pub by_hour: Vec<f64>,
}

impl InsightsToday {
    /// `emptyInsights(timezone)`, with `day` computed by the caller
    /// (`dateKeyInTimeZone(new Date(), timezone)`).
    #[must_use]
    pub fn empty(day: String) -> Self {
        Self {
            day,
            score: Score {
                score: 0.0,
                tracked_minutes: 0.0,
                engaged_minutes: 0.0,
                protected_minutes: 0.0,
                idle_minutes: 0.0,
            },
            totals: Totals {
                keystrokes: 0.0,
                clicks: 0.0,
                mouse_distance_px: 0.0,
                scroll_events: 0.0,
            },
            by_hour: vec![0.0; 24],
        }
    }
}

/// `GET /v1/insights/score?tz=<encodeURIComponent(tz)>`; any failure is logged
/// and answered with the zero object for `empty_day`.
pub async fn insights_today<S: TokenStore>(
    api: &ApiClient<S>,
    time_zone: &str,
    empty_day: impl FnOnce() -> String,
) -> InsightsToday {
    let path = format!("/v1/insights/score?tz={}", encode_uri_component(time_zone));
    match api
        .api::<InsightsToday>(&path, &RequestOptions::get())
        .await
    {
        Ok(today) => today,
        Err(err) => {
            tracing::warn!(err = %err, "insights:today failed");
            InsightsToday::empty(empty_day())
        }
    }
}
