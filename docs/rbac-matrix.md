# RBAC — role × action matrix

What each role may do in Timo, and where it is enforced. Source of truth for
capabilities: `packages/types/src/rbac.ts`. Source of truth for *whom*:
`apps/api/src/middleware/scope.ts`. Walked per role in
`apps/api/test/rbacRoles.test.ts` (plus `managerSelfActions.test.ts` for
"never on yourself").

## The two id lists

| | ADMIN | MANAGER | HR (no team) | HR (manages a team) | MEMBER |
|---|---|---|---|---|---|
| `scope` | workspace | team | workspace | workspace | self |
| `userIds` — whom you may **read** | everyone active | self + team | everyone active | everyone active | self |
| `editUserIds` — whom you may **change** | everyone active | self + team | self | self + her team | self |
| `isAdmin` | yes | no | no | no | no |

Rule: every write that targets another person checks `editUserIds` (or is
`requireAdmin` / `people.manage`), never `userIds`. Review queues (approvals,
anti-cheat flags, team settings) list `editUserIds` too — a queue shows only
what you can act on.

## Matrix

✅ allowed · ❌ refused · 👥 own team only · 🙋 self only

| Action | API gate | ADMIN | MANAGER | HR | HR + team | MEMBER |
|---|---|---|---|---|---|---|
| **People** — list (`GET /admin/users`) | scope `userIds` | ✅ | 👥 | ✅ | ✅ | 🙋 |
| Invite (`POST /admin/users`) | `people.manage`; non-admin → MEMBER only | ✅ any role | ❌ | ✅ MEMBER | ✅ MEMBER | ❌ |
| Edit name/team/unit/shift/birth date (`PATCH /admin/users/:id`) | `people.manage` + `hrMayNotManage` | ✅ | ❌ | ✅ not ADMIN/HR | ✅ not ADMIN/HR | ❌ |
| Change role | non-admin → MEMBER only | ✅ | ❌ | MEMBER only | MEMBER only | ❌ |
| Idle countdown (`idleWarningSeconds`) | `isAdmin` | ✅ | ❌ | ❌ | ❌ | ❌ |
| Activate / suspend / reactivate | `people.manage` + `hrMayNotManage` | ✅ | ❌ | ✅ not ADMIN/HR | ✅ not ADMIN/HR | ❌ |
| Hard delete / deletion plan | `requireAdmin` | ✅ | ❌ | ❌ | ❌ | ❌ |
| Teams list (`GET /admin/teams`) | `teams.read`; workspace scope → all | ✅ all | 👥 | ✅ all | ✅ all | ❌ |
| Teams create/rename/managers/delete | `requireAdmin` | ✅ | ❌ | ❌ | ❌ | ❌ |
| **Reports** — month sheet, members, attendance, timesheets, CSV/XLSX, unit-wise | `reports.team.read` + `userIds` | ✅ | 👥 | ✅ | ✅ | 🙋 (month sheet + own report) |
| Member report / day apps / day screenshots | `reports.team.read` + `userIds` | ✅ | 👥 | ✅ | ✅ | ❌ |
| Screenshots of a **suspended** person | `canReadEvidenceOf` (workspace scope) | ✅ | ❌ | ✅ | ✅ | ❌ |
| Team today (`/admin/overview`) | `overview.read` | ✅ | 👥 | ❌ | ❌ | ❌ |
| **Edits** — correct attendance | `attendance.correct` + `editUserIds`, never self (non-admin) | ✅ | 👥 | ❌ | 👥 | ❌ |
| Add/edit/delete someone's time | `time.team.edit` + `editUserIds` | ✅ | 👥 | ❌ | 👥 | 🙋 |
| Approvals queue + decide | `approvals.*.decide` + `editUserIds`; self only ADMIN/MANAGER | ✅ | 👥 | ❌ | 👥 (not self) | ❌ |
| Reopen a decided request | `requireAdmin` | ✅ | ❌ | ❌ | ❌ | ❌ |
| Anti-cheat flags list + resolve | `flags.*.review` + `editUserIds`, never self (non-admin) | ✅ | 👥 | ❌ | 👥 | ❌ |
| Team settings (shift, screenshot interval, idle threshold) | `team.settings.manage` + `editUserIds`, never self (non-admin) | ✅ | 👥 | ❌ | 👥 | ❌ |
| Team settings — idle countdown, remote/exempt rule mode | `isAdmin` | ✅ | ❌ | ❌ | ❌ | ❌ |
| **Leave** — calendar, own balance | scope `userIds` | ✅ | 👥 | ✅ | ✅ | 🙋 |
| Holidays, leave policy, member leave settings, adjustments | `requireAdmin` | ✅ | ❌ | ❌ | ❌ | ❌ |
| **Settings** — workspace settings, policy, monitoring audits, month-pointer recompute | `requireAdmin` / `policy.manage` | ✅ | ❌ | ❌ | ❌ | ❌ |
| Shifts create/edit/delete | `requireAdmin` | ✅ | ❌ | ❌ | ❌ | ❌ |
| API tokens / Integrations | `requireAdmin` | ✅ | ❌ | ❌ | ❌ | ❌ |
| MCP (`/v1/mcp/*`) | API token scopes; token dies when its creator stops being ADMIN | token | — | — | — | — |
| Lark manual-time card | the request's `approverId` (home-team manager, else first admin) | if approver | if approver | — | if approver | — |

## Dashboard mirrors

The nav (`components/Layout.tsx`) and route guards (`router.tsx`) use the same
capabilities. Per-person edit affordances come from the server, never from
the role alone:

- month sheet rows → `row.canEdit` (`canCorrectAttendanceOf`)
- member drawer → `canCorrect` (attendance) and `canEdit` (approve/reject)
- Edit time person picker and edit mode → `GET /admin/users` `canEdit`
- People row actions → `people.manage`, and for non-admins not on ADMIN/HR rows
