# legacy/agent — the Electron desktop app (frozen oracle)

This is the Electron build of the Timo desktop app. It is being replaced by the
Tauri + Rust app (`apps/desktop`, `crates/`). Until cutover it:

- still builds, tests and ships releases (`pnpm --filter @grind/agent ...`);
- is the **parity oracle**: `parity/` runs these TypeScript functions to produce
  the golden fixtures the Rust port must reproduce exactly.

Do not change behaviour here. A genuine bug fix lands here **and** in the Rust
port in the same commit, with the fixtures regenerated. See the root AGENTS.md
section "Desktop — Tauri + Rust".
