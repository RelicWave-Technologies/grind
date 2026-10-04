/**
 * The fictional workspace: Saffron Loop Studio, a 16-person agency across
 * Design, Engineering and Growth. Static definitions only — the store turns
 * them into rows with dates relative to today.
 */
import type { ActivityRoleTitle, LaunchAtLoginState, LaunchOrigin, Role } from '@grind/types';
import type { ShiftSchedule } from '@grind/types/shifts';
import type { ScreenKind } from './images';

export const WORKSPACE = {
  id: 'ws_saffronloop',
  name: 'Saffron Loop Studio',
  domain: 'saffronloop.studio',
};

export type Persona = 'steady' | 'early' | 'late' | 'erratic' | 'night' | 'meetings' | 'sales';
export type Discipline = 'design' | 'eng' | 'growth' | 'ops';
export type TeamKey = 'design' | 'eng' | 'growth' | 'video';

export interface AgentDef {
  platform: 'darwin' | 'win32' | 'linux' | null;
  version: string | null;
  screen: 'ok' | 'needs-restart' | 'needs-settings' | 'needs-grant' | null;
  accessibilityTrusted: boolean | null;
  accessibilityReady: boolean | null;
  hookRunning: boolean | null;
  launch: LaunchAtLoginState | null;
  origin: LaunchOrigin | null;
}

export interface PersonDef {
  id: string;
  name: string;
  email: string;
  role: Role;
  title: ActivityRoleTitle;
  team: TeamKey | null;
  discipline: Discipline;
  persona: Persona;
  shift: string | null;
  avatar: boolean;
  joinedDaysAgo: number;
  birthDate: string | null;
  agent: AgentDef;
  status?: 'pending' | 'deactivated';
  settings?: { screenshotIntervalMin: 1 | 2 | 3 | null; idleThresholdMin: number | null; idleWarningSeconds: number | null };
  leave?: { accrualDays: number | null; lastSaturdayOff: boolean | null; joinedOnSet: boolean };
}

const mac = (over: Partial<AgentDef> = {}): AgentDef => ({
  platform: 'darwin',
  version: '2.8.1',
  screen: 'ok',
  accessibilityTrusted: true,
  accessibilityReady: true,
  hookRunning: true,
  launch: 'READY',
  origin: 'LOGIN_ITEM',
  ...over,
});
const win = (over: Partial<AgentDef> = {}): AgentDef => ({
  platform: 'win32',
  version: '2.8.1',
  screen: null,
  accessibilityTrusted: null,
  accessibilityReady: null,
  hookRunning: null,
  launch: 'READY',
  origin: 'USER',
  ...over,
});
const none: AgentDef = {
  platform: null,
  version: null,
  screen: null,
  accessibilityTrusted: null,
  accessibilityReady: null,
  hookRunning: null,
  launch: null,
  origin: null,
};

const at = (local: string) => `${local}@${WORKSPACE.domain}`;

export const PEOPLE: PersonDef[] = [
  { id: 'usr_meera', name: 'Meera Iyer', email: at('meera'), role: 'ADMIN', title: 'OTHER', team: null, discipline: 'ops', persona: 'steady', shift: 'shf_general', avatar: true, joinedDaysAgo: 720, birthDate: '1986-03-14', agent: mac() },
  { id: 'usr_kabir', name: 'Kabir Malhotra', email: at('kabir'), role: 'MANAGER', title: 'DESIGNER', team: 'design', discipline: 'design', persona: 'meetings', shift: 'shf_general', avatar: true, joinedDaysAgo: 610, birthDate: '1989-11-02', agent: mac({ origin: 'USER' }) },
  { id: 'usr_ananya', name: 'Ananya Raghunathan', email: at('ananya'), role: 'MEMBER', title: 'DESIGNER', team: 'design', discipline: 'design', persona: 'steady', shift: 'shf_general', avatar: true, joinedDaysAgo: 402, birthDate: '1996-07-21', agent: mac() },
  { id: 'usr_sofia', name: 'Sofia Almeida', email: at('sofia'), role: 'MEMBER', title: 'DESIGNER', team: 'design', discipline: 'design', persona: 'early', shift: 'shf_early', avatar: false, joinedDaysAgo: 188, birthDate: '1994-01-30', agent: mac({ version: '2.7.4', screen: 'needs-restart', launch: 'NEEDS_REPAIR', origin: 'USER' }), settings: { screenshotIntervalMin: 2, idleThresholdMin: 10, idleWarningSeconds: 30 } },
  { id: 'usr_rhea', name: 'Rhea Kapoor', email: at('rhea'), role: 'MEMBER', title: 'DESIGNER', team: 'design', discipline: 'design', persona: 'late', shift: 'shf_general', avatar: true, joinedDaysAgo: 96, birthDate: null, agent: win() },
  { id: 'usr_arjun', name: 'Arjun Menon', email: at('arjun'), role: 'MANAGER', title: 'DEVELOPER', team: 'eng', discipline: 'eng', persona: 'steady', shift: 'shf_general', avatar: false, joinedDaysAgo: 655, birthDate: '1990-05-09', agent: mac() },
  { id: 'usr_vikram', name: 'Vikram Singh Rathore', email: at('vikram'), role: 'MEMBER', title: 'DEVELOPER', team: 'eng', discipline: 'eng', persona: 'erratic', shift: 'shf_general', avatar: true, joinedDaysAgo: 530, birthDate: '1993-09-17', agent: { ...none, platform: 'linux', version: '2.6.0', launch: 'UNAVAILABLE', origin: 'UNKNOWN' } },
  { id: 'usr_daniel', name: 'Daniel Okafor', email: at('daniel'), role: 'MEMBER', title: 'DEVELOPER', team: 'eng', discipline: 'eng', persona: 'night', shift: 'shf_night', avatar: true, joinedDaysAgo: 240, birthDate: '1995-12-03', agent: win({ version: '2.8.0', launch: 'BLOCKED' }), settings: { screenshotIntervalMin: 3, idleThresholdMin: 15, idleWarningSeconds: null } },
  { id: 'usr_priya', name: 'Priya Venkataraman', email: at('priya'), role: 'MEMBER', title: 'DEVELOPER', team: 'eng', discipline: 'eng', persona: 'steady', shift: 'shf_general', avatar: false, joinedDaysAgo: 310, birthDate: '1997-02-26', agent: mac({ accessibilityTrusted: false, accessibilityReady: false, hookRunning: false }) },
  { id: 'usr_hiroshi', name: 'Hiroshi Tanaka', email: at('hiroshi'), role: 'MEMBER', title: 'DEVELOPER', team: 'eng', discipline: 'eng', persona: 'early', shift: 'shf_early', avatar: true, joinedDaysAgo: 140, birthDate: '1992-08-11', agent: mac({ version: '2.8.0', screen: 'needs-grant', launch: 'NEEDS_APPROVAL', origin: 'USER' }), settings: { screenshotIntervalMin: 1, idleThresholdMin: 5, idleWarningSeconds: 20 } },
  { id: 'usr_nisha', name: 'Nisha Chaudhary', email: at('nisha'), role: 'MANAGER', title: 'SALES', team: 'growth', discipline: 'growth', persona: 'meetings', shift: 'shf_studio', avatar: true, joinedDaysAgo: 470, birthDate: '1988-04-19', agent: mac() },
  { id: 'usr_rohan', name: 'Rohan Deshpande', email: at('rohan'), role: 'MEMBER', title: 'SALES', team: 'growth', discipline: 'growth', persona: 'sales', shift: 'shf_studio', avatar: false, joinedDaysAgo: 205, birthDate: '1998-10-05', agent: win({ version: '2.7.9', launch: 'NEEDS_INSTALL' }), leave: { accrualDays: 1, lastSaturdayOff: true, joinedOnSet: true } },
  { id: 'usr_emily', name: 'Emily Clarke', email: at('emily'), role: 'MEMBER', title: 'SALES', team: 'growth', discipline: 'growth', persona: 'steady', shift: 'shf_general', avatar: true, joinedDaysAgo: 330, birthDate: '1991-06-28', agent: mac({ origin: 'USER' }), leave: { accrualDays: 2, lastSaturdayOff: null, joinedOnSet: true } },
  { id: 'usr_aditya', name: 'Aditya Narayanaswamy Subramaniam-Venkatakrishnan', email: at('aditya.narayanaswamy.subramaniam'), role: 'MEMBER', title: 'OTHER', team: 'growth', discipline: 'growth', persona: 'late', shift: 'shf_general', avatar: false, joinedDaysAgo: 58, birthDate: '1999-01-15', agent: none },
  { id: 'usr_farhan', name: 'Farhan Qureshi', email: at('farhan'), role: 'MEMBER', title: 'OTHER', team: null, discipline: 'eng', persona: 'steady', shift: null, avatar: false, joinedDaysAgo: 2, birthDate: null, agent: none, status: 'pending' },
  { id: 'usr_tom', name: 'Tom Becker', email: at('tom'), role: 'MEMBER', title: 'DESIGNER', team: 'design', discipline: 'design', persona: 'steady', shift: 'shf_general', avatar: true, joinedDaysAgo: 380, birthDate: '1990-02-02', agent: mac({ version: '2.5.2' }), status: 'deactivated' },
];

/** Who the dev panel signs in as for each role. */
export const ROLE_PERSONA: Record<Role, string> = {
  ADMIN: 'usr_meera',
  MANAGER: 'usr_arjun',
  MEMBER: 'usr_ananya',
};

export const TEAMS: Array<{ key: TeamKey; id: string; name: string; createdDaysAgo: number }> = [
  { key: 'design', id: 'team_design', name: 'Design', createdDaysAgo: 700 },
  { key: 'eng', id: 'team_eng', name: 'Engineering', createdDaysAgo: 700 },
  { key: 'growth', id: 'team_growth', name: 'Growth & Partnerships', createdDaysAgo: 480 },
  { key: 'video', id: 'team_video', name: 'Video Lab', createdDaysAgo: 12 },
];

export const TEAM_MANAGERS: Record<TeamKey, string[]> = {
  design: ['usr_kabir'],
  eng: ['usr_arjun'],
  growth: ['usr_nisha'],
  video: [],
};

const weekdays = (start: string, end: string): ShiftSchedule => ({
  mon: { start, end },
  tue: { start, end },
  wed: { start, end },
  thu: { start, end },
  fri: { start, end },
  sat: null,
  sun: null,
});

export const SHIFTS: Array<{ id: string; name: string; schedule: ShiftSchedule; bufferMin: number; createdDaysAgo: number }> = [
  { id: 'shf_general', name: 'General · 10 to 7', schedule: weekdays('10:00', '19:00'), bufferMin: 15, createdDaysAgo: 700 },
  { id: 'shf_early', name: 'Early bird', schedule: weekdays('08:00', '17:00'), bufferMin: 10, createdDaysAgo: 400 },
  { id: 'shf_night', name: 'Night shift (US overlap)', schedule: weekdays('17:00', '23:30'), bufferMin: 20, createdDaysAgo: 260 },
  {
    id: 'shf_studio',
    name: 'Studio + half Saturday',
    schedule: { ...weekdays('10:00', '19:00'), sat: { start: '10:00', end: '14:00' } },
    bufferMin: 15,
    createdDaysAgo: 330,
  },
  {
    id: 'shf_weekend',
    name: 'Weekend support',
    schedule: { mon: null, tue: null, wed: null, thu: null, fri: null, sat: { start: '11:00', end: '17:00' }, sun: { start: '11:00', end: '17:00' } },
    bufferMin: 30,
    createdDaysAgo: 30,
  },
];

// ---------------------------------------------------------------------------
// Apps, per discipline
// ---------------------------------------------------------------------------

export interface AppDef {
  app: string;
  bundle: string | null;
  domain?: string;
  screen: ScreenKind;
}

const CHROME = { sourceApp: 'Google Chrome', sourceAppBundle: 'com.google.Chrome' };
export const BROWSER_SOURCE = CHROME;

export const APPS: Record<string, AppDef> = {
  figma: { app: 'Figma', bundle: 'com.figma.Desktop', screen: 'design' },
  photoshop: { app: 'Adobe Photoshop 2026', bundle: 'com.adobe.Photoshop', screen: 'design' },
  vscode: { app: 'Visual Studio Code', bundle: 'com.microsoft.VSCode', screen: 'code' },
  iterm: { app: 'iTerm2', bundle: 'com.googlecode.iterm2', screen: 'terminal' },
  postman: { app: 'Postman', bundle: 'com.postmanlabs.mac', screen: 'browser' },
  slack: { app: 'Slack', bundle: 'com.tinyspeck.slackmacgap', screen: 'chat' },
  lark: { app: 'Lark', bundle: 'com.larksuite.lark', screen: 'chat' },
  notion: { app: 'Notion', bundle: 'notion.id', screen: 'doc' },
  zoom: { app: 'zoom.us', bundle: 'us.zoom.xos', screen: 'call' },
  github: { app: 'github.com', bundle: null, domain: 'github.com', screen: 'browser' },
  stackoverflow: { app: 'stackoverflow.com', bundle: null, domain: 'stackoverflow.com', screen: 'browser' },
  dribbble: { app: 'dribbble.com', bundle: null, domain: 'dribbble.com', screen: 'browser' },
  miro: { app: 'miro.com', bundle: null, domain: 'miro.com', screen: 'design' },
  hubspot: { app: 'app.hubspot.com', bundle: null, domain: 'app.hubspot.com', screen: 'browser' },
  sheets: { app: 'docs.google.com', bundle: null, domain: 'docs.google.com', screen: 'sheet' },
  linkedin: { app: 'linkedin.com', bundle: null, domain: 'linkedin.com', screen: 'browser' },
  canva: { app: 'canva.com', bundle: null, domain: 'canva.com', screen: 'design' },
  gmail: { app: 'mail.google.com', bundle: null, domain: 'mail.google.com', screen: 'browser' },
};

export const APP_MIX: Record<Discipline, ReadonlyArray<readonly [string, number]>> = {
  design: [['figma', 46], ['lark', 10], ['slack', 8], ['photoshop', 8], ['dribbble', 6], ['notion', 6], ['miro', 5], ['zoom', 5]],
  eng: [['vscode', 46], ['iterm', 14], ['github', 12], ['slack', 8], ['lark', 7], ['postman', 5], ['stackoverflow', 4], ['zoom', 4]],
  growth: [['hubspot', 20], ['sheets', 18], ['linkedin', 14], ['lark', 14], ['zoom', 12], ['slack', 8], ['canva', 6], ['notion', 5]],
  ops: [['lark', 24], ['sheets', 20], ['slack', 14], ['zoom', 14], ['notion', 10], ['gmail', 8], ['hubspot', 5], ['figma', 5]],
};

// ---------------------------------------------------------------------------
// Lark tasks
// ---------------------------------------------------------------------------

export interface TaskDef {
  guid: string;
  summary: string;
  team: TeamKey | null;
}

export const TASKS: TaskDef[] = [
  { guid: 'tsk_d_rebrand', summary: 'Northwind rebrand — logo explorations', team: 'design' },
  { guid: 'tsk_d_checkout', summary: 'Checkout flow v3 — hi-fi screens', team: 'design' },
  { guid: 'tsk_d_tokens', summary: 'Design system: token audit & dark mode pass', team: 'design' },
  { guid: 'tsk_d_research', summary: 'Aurora Bank onboarding — usability test synthesis', team: 'design' },
  { guid: 'tsk_d_casestudy', summary: 'Marketing site: case study page for Tealeaf', team: 'design' },
  { guid: 'tsk_e_payroll', summary: 'TIMO-412 · Payroll CSV export respects month close', team: 'eng' },
  { guid: 'tsk_e_idle', summary: 'TIMO-418 · Idle detection after Windows sleep', team: 'eng' },
  { guid: 'tsk_e_uploads', summary: 'Migrate screenshot uploads to signed Cloudinary URLs', team: 'eng' },
  { guid: 'tsk_e_webhooks', summary: 'Aurora Bank API — webhook retries & dead-letter queue', team: 'eng' },
  { guid: 'tsk_e_oncall', summary: 'On-call: investigate slow team summary report', team: 'eng' },
  { guid: 'tsk_g_outbound', summary: 'Q4 outbound — fintech founders list (Mumbai + Bengaluru)', team: 'growth' },
  { guid: 'tsk_g_webinar', summary: 'Webinar deck: running an agency on async time', team: 'growth' },
  { guid: 'tsk_g_kestrel', summary: 'Partnership proposal — Kestrel Analytics', team: 'growth' },
  { guid: 'tsk_g_hubspot', summary: 'HubSpot cleanup — dedupe 2,300 contacts', team: 'growth' },
  { guid: 'tsk_x_sync', summary: 'Weekly studio sync & planning', team: null },
  { guid: 'tsk_x_hiring', summary: 'Hiring: portfolio reviews for senior product designer', team: null },
  {
    guid: 'tsk_x_qbr',
    summary:
      'Client escalation — Aurora Bank quarterly business review prep, including the revised retainer scope, the Q1 resourcing plan and the rollout timeline for the new onboarding experience',
    team: null,
  },
];

/** A task guid that no longer resolves — exercises the "Task unavailable" state. */
export const ARCHIVED_TASK_GUID = 'tsk_archived_77';

export const WORK_NOTES: Record<Discipline, string[]> = {
  design: [
    'Explored three directions for the hero lockup',
    'Empty states + error states for checkout',
    'Tidied auto-layout on the card components',
    'Prototype for Thursday’s usability sessions',
    'Handoff notes for engineering',
  ],
  eng: [
    'Fixed flaky test in payroll carry-over',
    'Code review for #1284 and #1291',
    'Reproduced the sleep/wake bug on a Surface',
    'Wrote the migration + backfill script',
    'Profiling the summary query — 4.1s → 380ms',
  ],
  growth: [
    'Personalised 40 intros from the fintech list',
    'Updated pipeline stages after the Kestrel call',
    'Drafted follow-ups for webinar sign-ups',
    'Cleaned duplicate companies in HubSpot',
  ],
  ops: [
    'Month-close checklist with finance',
    'Reviewed leave requests and holiday calendar',
    'Vendor contracts — renewals for Q4',
    'Offer letters for two new joiners',
  ],
};

export const MEETINGS: Record<Discipline, string[]> = {
  design: ['Design critique', 'Client review — Northwind', 'Handoff with engineering'],
  eng: ['Daily standup', 'Sprint planning', 'Incident review', 'Architecture sync'],
  growth: ['Pipeline review', 'Client call — Kestrel Analytics', 'Discovery call — Aurora Bank'],
  ops: ['Studio all-hands', 'Finance sync', '1:1s'],
};
