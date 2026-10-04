//! What a decrypted file must hold to count as a session.

use serde_json::Value;

use super::super::StoredTokens;

/// Port of `tokenStore.ts::isStoredTokens` on the parsed JSON: an object whose
/// `accessToken`, `refreshToken`, `userId` and `workspaceId` are non-empty
/// strings. Extra keys are ignored; with a repeated key the last wins, as in
/// `JSON.parse`. Invalid UTF-8 is not JSON (Electron's `decryptString` would
/// have produced replacement characters; no session the agent wrote has any).
pub(super) fn parse_tokens(plaintext: &[u8]) -> Option<StoredTokens> {
    let value: Value = serde_json::from_slice(plaintext).ok()?;
    let field = |key: &str| value.get(key).and_then(Value::as_str).map(str::to_owned);
    let tokens = StoredTokens {
        access_token: field("accessToken")?,
        refresh_token: field("refreshToken")?,
        user_id: field("userId")?,
        workspace_id: field("workspaceId")?,
    };
    tokens.is_valid().then_some(tokens)
}
