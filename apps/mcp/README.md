# Timo MCP

Read-only MCP server for Timo workspace data.

The server runs locally over stdio and talks only to the Timo API. It does not connect to the VM, Postgres, screenshots, or raw activity samples.

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

- `timo_version_adoption`
- `timo_device_health`
- `timo_running_users`
- `timo_people_list`
- `timo_time_summary`
- `timo_manual_time_requests`

## Security

- Use one token per person or machine.
- Do not paste tokens into chat or commit them to git.
- Revoke lost or shared tokens from **Integrations**.
- Tokens are scoped and read-only, but they can still expose workspace people, device health, running status, time summaries, and manual-time requests.

## Local Development

```bash
pnpm --filter @anish23_05/timo-mcp build
TIMO_API_BASE=http://localhost:4010 TIMO_API_TOKEN=token node apps/mcp/dist/index.cjs
```
