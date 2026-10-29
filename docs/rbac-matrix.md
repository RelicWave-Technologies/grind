# RBAC — role × action matrix

What each role may do in Timo, and where it is enforced. Source of truth for
capabilities: `packages/types/src/rbac.ts`. Source of truth for *whom*:
`apps/api/src/middleware/scope.ts`. Walked per role in
`apps/api/test/rbacRoles.test.ts` (plus `managerSelfActions.test.ts` for
"never on yourself").

## HR in one line

HR's only extra is the **People tab**, workspace-wide (never on an ADMIN or
another HR, only grants MEMBER, no hard delete). Everything else is her
position's: without a team she is a member for reports and edits; managing a
team she is that team's manager.

## Scope

| | ADMIN | MANAGER | HR (no team) | HR (manages a team) | MEMBER |
|---|---|---|---|---|---|
| `scope` | workspace | team | self | team | self |
| `userIds` — whom you may **read** | everyone active | self + team | self | self + team | self |
| `editUserIds` — whom you may **change** | = `userIds` | = `userIds` | = `userIds` | = `userIds` | = `userIds` |
| People routes (`people.manage`) | whole workspace | — | whole workspace | whole workspace | — |
| `isAdmin` | yes | no | no | no | no |

Rule: every write that targets another person checks `editUserIds` (or is
`requireAdmin` / `people.manage`), never `userIds`. Review queues (approvals,
anti-cheat flags, team settings) list `editUserIds`. The People list reaches
past HR's scope, so per row it only carries what People needs: sync health
(about someone's time) is null outside the caller's `userIds`, and `canEdit`
says whose time she may change.

## Matrix

✅ allowed · ❌ refused · 👥 own team only · 🙋 self only

| Action | API gate | ADMIN | MANAGER | HR | HR + team | MEMBER |
|---|---|---|---|---|---|---|
| **People** — list (`GET /admin/users`) | `people.manage` → workspace, else `userIds` | ✅ | 👥 | ✅ | ✅ | 🙋 |
| Invite (`POST /admin/users`) | `people.manage`; non-admin → MEMBER only | ✅ any role | ❌ | ✅ MEMBER | ✅ MEMBER | ❌ |
| Edit name/team/unit/shift/birth date (`PATCH /admin/users/:id`) | `people.manage` + `hrMayNotManage` | ✅ | ❌ | ✅ not ADMIN/HR | ✅ not ADMIN/HR | ❌ |
| Change role | non-admin → MEMBER only | ✅ | ❌ | MEMBER only | MEMBER only | ❌ |
| Idle countdown (`idleWarningSeconds`) | `isAdmin` | ✅ | ❌ | ❌ | ❌ | ❌ |
| Activate / suspend / reactivate | `people.manage` + `hrMayNotManage` | ✅ | ❌ | ✅ not ADMIN/HR | ✅ not ADMIN/HR | ❌ |
| Hard delete / deletion plan | `requireAdmin` | ✅ | ❌ | ❌ | ❌ | ❌ |
| Teams list (`GET /admin/teams`) | `teams.read`; `people.manage` → all | ✅ all | 👥 | ✅ all | ✅ all | ❌ |
| Shifts list, units | `shifts.read` / signed in | ✅ | ✅ | ✅ | ✅ | units only |
| Teams create/rename/managers/delete | `requireAdmin` | ✅ | ❌ | ❌ | ❌ | ❌ |
| **Reports** — month sheet | `reports.self.read` + `userIds` | ✅ | 👥 | 🙋 | 👥 | 🙋 |
| Members, attendance, timesheets, CSV/XLSX, unit-wise | `reports.team.read` + `userIds` | ✅ | 👥 | ❌ | 👥 | ❌ |
| Member report / day apps / day screenshots | `reports.team.read` + `userIds` | ✅ | 👥 | ❌ | 👥 | ❌ |
| Screenshots of a **suspended** person | `canReadEvidenceOf` (`isAdmin`) | ✅ | ❌ | ❌ | ❌ | ❌ |
| Team today (`/admin/overview`) | `overview.read` | ✅ | 👥 | ❌ | 👥 | ❌ |
| **Edits** — correct attendance | `attendance.correct` + `editUserIds`, never self (non-admin) | ✅ | 👥 | ❌ | 👥 | ❌ |
| Add/edit/delete someone's time | `time.team.edit` + `editUserIds` | ✅ | 👥 | 🙋 | 👥 | 🙋 |
| Approvals queue + decide | `approvals.*.decide` + `editUserIds`; self-approve ADMIN/MANAGER/HR | ✅ | 👥 + own | 🙋 own (auto-approved on create) | 👥 + own | ❌ |
| Reopen a decided request | `requireAdmin` | ✅ | ❌ | ❌ | ❌ | ❌ |
| Anti-cheat flags list + resolve | `flags.*.review` + `editUserIds`, never self (non-admin) | ✅ | 👥 | ❌ | 👥 | ❌ |
| Team settings (shift, screenshot interval, idle threshold) | `team.settings.manage` + `editUserIds`, never self (non-admin) | ✅ | 👥 | ❌ | 👥 | ❌ |
| Team settings — idle countdown, remote/exempt rule mode | `isAdmin` | ✅ | ❌ | ❌ | ❌ | ❌ |
| **Leave** — calendar, balances | scope `userIds` | ✅ | 👥 | 🙋 | 👥 | 🙋 |
| Holidays, leave policy, member leave settings, adjustments | `requireAdmin` | ✅ | ❌ | ❌ | ❌ | ❌ |
| **Settings** — workspace settings, policy, monitoring audits, month-pointer recompute | `requireAdmin` / `policy.manage` | ✅ | ❌ | ❌ | ❌ | ❌ |
| Shifts create/edit/delete | `requireAdmin` | ✅ | ❌ | ❌ | ❌ | ❌ |
| API tokens / Integrations | `requireAdmin` | ✅ | ❌ | ❌ | ❌ | ❌ |
| MCP (`/v1/mcp/*`) | API token scopes; token dies when its creator stops being ADMIN | token | — | — | — | — |
| Lark manual-time card | the request's `approverId` (home-team manager, else first admin) | if approver | if approver | — | if approver | — |
| Lark access-request card (#173) | decider must be ADMIN; cards go to admins | ✅ | ❌ | ❌ (dashboard only) | ❌ (dashboard only) | ❌ |

## Dashboard mirrors

The nav (`components/Layout.tsx`) and route guards (`router.tsx`) use the same
capabilities. Per-person edit affordances come from the server, never from
the role alone:

- month sheet rows → `row.canEdit` (`canCorrectAttendanceOf`)
- member drawer → `canCorrect` (attendance) and `canEdit` (approve/reject)
- Edit time person picker and edit mode → `GET /admin/users` `canEdit` (HR's People list is wider than whom she may edit)
- People row actions → `people.manage`, and for non-admins not on ADMIN/HR rows
