<p align="center">
  <img src="https://unpkg.com/@anish23_05/timo-mcp@latest/assets/timo-mascot.png" width="112" alt="Timo mascot" />
</p>

<h1 align="center">Timo MCP</h1>

<p align="center">
  Detailed read-only MCP tools for Timo workspace operations, device health, time summaries, and audit context.
</p>

---

Timo MCP runs locally over stdio and talks only to the Timo API using a scoped API token.

It does not connect to the VM, Postgres, dashboard cookies, Lark write APIs, screenshots, or raw activity samples.

## Install

Create an API token in Timo:

1. Open Timo Dashboard.
2. Go to **Integrations**.
3. Create an API token with the read-only scopes you want.
4. Copy the token once and keep it private.

Add this to your MCP client config:

```json
{
  "mcpServers": {
    "timo": {
      "command": "npx",
      "args": ["-y", "@anish23_05/timo-mcp@latest"],
      "env": {
        "TIMO_API_BASE": "https://timo.emiactech.com",
        "TIMO_API_TOKEN": "timo_mcp_atk_..."
      }
    }
  }
}
```

Restart the MCP client after editing the config.

## Tools

- `timo_mcp_capabilities` — explains tools, scopes, limits, date formats, and privacy boundaries.
- `timo_workspace_overview` — workspace totals for people, teams, devices, versions, today time, manual-time requests, and open activity flags.
- `timo_people_list` — active people with role, team, managed team, shift, and device summary.
- `timo_user_detail` — one user's profile, device health, time totals, and recent manual-time requests.
- `timo_device_health` — app version, platform, runtime state, heartbeat freshness, and permission health.
- `timo_version_adoption` — version/platform/state adoption buckets and unknown/stale users.
- `timo_running_users` — users currently RUNNING with a fresh heartbeat.
- `timo_team_summary` — team managers, roster, device counts, permission issues, and time totals.
- `timo_break_summary` — inferred break time by user/day with source-of-truth gap evidence; lunch is separated as the longest qualifying candidate when a long break overlaps the local lunch window.
- `timo_time_summary` — per-user/per-day tracked, meeting, manual, invalidated, and total time.
- `timo_manual_time_requests` — manual-time request and decision audit metadata.
- `timo_activity_flags_summary` — privacy-safe flag counts and recent flag summaries.

## Scopes

- `read:people` — people, roles, teams, shifts, roster context.
- `read:device-health` — desktop platform, version, runtime state, heartbeat, permissions.
- `read:time-summary` — aggregated time summaries and privacy-safe activity flag summaries.
- `read:manual-time` — manual-time requests and approval audit metadata.

Some detailed tools require multiple scopes. If a token is missing a scope, the tool fails clearly with `insufficient_scope` instead of returning partial or guessed data.

## Example Questions

- "Which Timo version is everyone using?"
- "Who is currently running Timo?"
- "Show me users with stale or missing desktop heartbeats."
- "Which Mac users are missing Screen Recording or Accessibility?"
- "Summarize today's tracked time by team."
- "Kal kisne kitna break liya?"
- "Yesterday, show lunch candidates separately from other breaks."
- "For yesterday's breaks, show the actual gaps and any manual-time approval reasons."
- "Show pending manual-time requests."
- "Give me privacy-safe activity flag counts for this week."
- "What can this Timo MCP read, and what is intentionally blocked?"

## Privacy

This MCP never exposes:

- screenshots or screenshot URLs
- S3 keys
- raw `ActivitySample` rows
- raw keystroke/click/mouse minute timelines
- foreground window titles
- browser URLs
- dashboard cookies
- token hashes or secrets

It also has no write tools. It cannot approve requests, edit time, create users, change settings, or send Lark messages.

## Limits

- List tools return at most 200 rows.
- Summary-style tools allow at most 31 days per request.
- Dates use `YYYY-MM-DD`.
- Timezone accepts IANA names such as `Asia/Kolkata` or `UTC`.
- Break summaries default to yesterday. Breaks are inferred from gaps between tracked work/meeting/manual blocks; each gap includes previous/next tracked-block evidence. Lunch is the longest qualifying candidate only unless users explicitly label it.

## Security

- Use one token per person or machine.
- Do not paste tokens into chat or commit them to git.
- Revoke lost or shared tokens from **Integrations**.
- Rotate any token that was accidentally shared.

## Local Development

```bash
pnpm --filter @anish23_05/timo-mcp build
TIMO_API_BASE=http://localhost:4010 TIMO_API_TOKEN=token node apps/mcp/dist/index.cjs
```
