import './profile.css';
import { useQuery } from '@tanstack/react-query';
import { CalendarDays, Clock3, Building2, Shield, Users, User, Mail, SunMedium } from 'lucide-react';
import { useRouteContext } from '@tanstack/react-router';
import { zonedDateTimeParts } from '@grind/types';
import { api } from '../lib/api';
import type { SelfProfileResponse } from '@grind/types/profile';
import type { ShiftSchedule, Weekday } from '@grind/types/shifts';
import {
  Page,
  PageHeader,
  Card,
  Stat,
  StatRow,
  List,
  ListRow,
  Avatar,
  Identity,
  Tag,
  Banner,
  EmptyState,
  Skeleton,
} from '../ui';

const WEEKDAYS: ReadonlyArray<{ key: Weekday; label: string }> = [
  { key: 'mon', label: 'Mon' },
  { key: 'tue', label: 'Tue' },
  { key: 'wed', label: 'Wed' },
  { key: 'thu', label: 'Thu' },
  { key: 'fri', label: 'Fri' },
  { key: 'sat', label: 'Sat' },
  { key: 'sun', label: 'Sun' },
];

export function ProfileScreen() {
  const { me } = useRouteContext({ from: '/authed' });
  const tz = me.workspaceTimezone;
  const profileQ = useQuery({
    queryKey: ['profile', 'me'],
    queryFn: () => api<SelfProfileResponse>('/v1/profile/me'),
  });

  return (
    <Page className="prf-page">
      <PageHeader
        eyebrow={`${tz.replace(/_/g, ' ')} · ${friendlyRole(me.displayRole)}`}
        title="Profile"
        subtitle="Your reporting line, shift, workspace, and capture settings."
      />

      {profileQ.isError && (
        <Banner status="danger">Couldn’t load your profile: {(profileQ.error as Error).message}</Banner>
      )}

      {profileQ.isLoading ? (
        <ProfileSkeleton />
      ) : profileQ.data ? (
        <ProfileBody profile={profileQ.data} timezone={tz} />
      ) : (
        <Card>
          <EmptyState
            icon={<User size={20} strokeWidth={1.8} />}
            title="Profile unavailable"
            description="We couldn’t find your profile details right now."
          />
        </Card>
      )}
    </Page>
  );
}

function ProfileBody({ profile, timezone }: { profile: SelfProfileResponse; timezone: string }) {
  const roleLabel = friendlyRole(profile.user.displayRole);
  const todayKey = weekdayKey(new Date(), timezone);
  const todayWindow = profile.shift ? formatScheduleRange(profile.shift.schedule[todayKey]) : 'Day off';
  const workingDays = profile.shift ? countWorkingDays(profile.shift.schedule) : 0;
  const captureCount = [profile.policy.captureApps, profile.policy.captureTitles, profile.policy.captureUrls]
    .filter(Boolean).length;

  return (
    <>
      <Card variant="flush" className="prf-summary ui-rise-1">
        <StatRow>
          <Stat
            label="Team"
            value={profile.team?.name ?? '—'}
            hint={profile.team ? `${profile.team.memberCount} members` : 'workspace-level'}
          />
          <Stat
            label="Manager"
            value={profile.manager ? shortName(profile.manager.name) : '—'}
            hint={profile.manager?.email ?? roleLine(profile.user.displayRole)}
          />
          <Stat
            label="Shift"
            value={profile.shift?.name ?? '—'}
            hint={profile.shift ? todayWindow : 'no shift assigned'}
          />
          <Stat
            label="Capture"
            value={captureCount}
            unit="/3"
            hint={`${profile.policy.retentionDaysScreenshots}d screenshot retention`}
          />
        </StatRow>
      </Card>

      <div className="prf-main-grid ui-rise-2">
        <Card title="Profile">
          <div className="prf-profile-head">
            <Identity
              avatar={<Avatar name={profile.user.name} src={profile.user.avatarUrl ?? undefined} size={40} />}
              name={profile.user.name}
              subtitle={profile.user.email}
            />
          </div>
          <List>
            <ListRow
              leading={<LeadingIcon icon={<Users size={16} strokeWidth={1.8} />} />}
              title={profile.team?.name ?? 'Workspace-level'}
              subtitle="Team"
              meta={profile.team ? `${profile.team.memberCount} members` : 'No team assigned'}
            />
            <ListRow
              leading={profile.manager ? <Avatar name={profile.manager.name} src={profile.manager.avatarUrl ?? undefined} size={32} /> : <LeadingIcon icon={<User size={16} strokeWidth={1.8} />} />}
              title={profile.manager?.name ?? 'No direct manager'}
              subtitle={profile.manager ? `Manager · ${profile.manager.email}` : 'Manager'}
              meta={profile.manager ? undefined : roleLine(profile.user.displayRole)}
            />
            <ListRow
              leading={<LeadingIcon icon={<Building2 size={16} strokeWidth={1.8} />} />}
              title={roleLabel}
              subtitle="Access level"
              trailing={<Tag mono>{profile.workspace.name}</Tag>}
            />
          </List>
        </Card>

        <Card title="Current shift">
          {profile.shift ? (
            <List>
              <ListRow
                leading={<LeadingIcon icon={<SunMedium size={16} strokeWidth={1.8} />} />}
                title={profile.shift.name}
                subtitle="Shift"
                meta={`${profile.shift.memberCount} members`}
              />
              <ListRow
                leading={<LeadingIcon icon={<Clock3 size={16} strokeWidth={1.8} />} />}
                title={todayWindow}
                subtitle="Today"
                trailing={<Tag status={todayWindow === 'Day off' ? 'neutral' : 'success'}>{todayWindow === 'Day off' ? 'Off' : 'Scheduled'}</Tag>}
              />
              <ListRow
                leading={<LeadingIcon icon={<CalendarDays size={16} strokeWidth={1.8} />} />}
                title={`${workingDays} working days`}
                subtitle="Weekly pattern"
                meta={`${profile.shift.bufferMin} min grace`}
              />
              <ListRow
                leading={<LeadingIcon icon={<CalendarDays size={16} strokeWidth={1.8} />} />}
                title={profile.shift.assignedAt ? formatLongDate(profile.shift.assignedAt) : '—'}
                subtitle="Assigned on"
              />
            </List>
          ) : (
            <EmptyState
              icon={<CalendarDays size={22} strokeWidth={1.8} />}
              title="No shift assigned"
              description="You’re currently working without a scheduled shift."
            />
          )}
        </Card>
      </div>

      <Card title="Weekly schedule" className="prf-week-card ui-rise-3">
        {profile.shift ? (
          <div className="prf-week">
            {WEEKDAYS.map((day) => {
              const slot = profile.shift?.schedule[day.key];
              const isToday = day.key === todayKey;
              return (
                <div
                  key={day.key}
                  className={`prf-week__day${isToday ? ' is-today' : ''}`}
                >
                  <span className="prf-week__label ui-t-eyebrow">{day.label}</span>
                  <span className="prf-week__value ui-mono">{formatScheduleRange(slot)}</span>
                  {isToday && <Tag mono>Today</Tag>}
                </div>
              );
            })}
          </div>
        ) : (
          <EmptyState
            icon={<SunMedium size={22} strokeWidth={1.8} />}
            title="No schedule to show"
            description="Once a shift is assigned, the week will appear here."
          />
        )}
      </Card>

      <div className="prf-secondary-grid ui-rise-3">
        <Card title="Account & workspace">
          <List>
            <ListRow
              leading={<LeadingIcon icon={<Mail size={16} strokeWidth={1.8} />} />}
              title={profile.user.email}
              subtitle="Work email"
            />
            <ListRow
              leading={<LeadingIcon icon={<Building2 size={16} strokeWidth={1.8} />} />}
              title={profile.workspace.name}
              subtitle="Workspace"
              meta={formatLongDate(profile.workspace.createdAt)}
            />
            <ListRow
              leading={<LeadingIcon icon={<Clock3 size={16} strokeWidth={1.8} />} />}
              title={timezone.replace(/_/g, ' ')}
              subtitle="Timezone"
              meta={formatLongDate(profile.user.createdAt)}
            />
          </List>
        </Card>

        <Card title="Privacy & capture">
          <List>
            <ListRow
              leading={<LeadingIcon icon={<Shield size={16} strokeWidth={1.8} />} />}
              title="Foreground apps"
              subtitle="Which application is active"
              trailing={<Tag status={profile.policy.captureApps ? 'success' : 'neutral'}>{profile.policy.captureApps ? 'On' : 'Off'}</Tag>}
            />
            <ListRow
              leading={<LeadingIcon icon={<Shield size={16} strokeWidth={1.8} />} />}
              title="Window titles"
              subtitle="Document and tab names"
              trailing={<Tag status={profile.policy.captureTitles ? 'warn' : 'neutral'}>{profile.policy.captureTitles ? 'On' : 'Off'}</Tag>}
            />
            <ListRow
              leading={<LeadingIcon icon={<Shield size={16} strokeWidth={1.8} />} />}
              title="Browser URLs"
              subtitle="The strictest capture setting"
              trailing={<Tag status={profile.policy.captureUrls ? 'danger' : 'neutral'}>{profile.policy.captureUrls ? 'On' : 'Off'}</Tag>}
            />
            <ListRow
              leading={<LeadingIcon icon={<CalendarDays size={16} strokeWidth={1.8} />} />}
              title={`${profile.policy.retentionDaysScreenshots} days`}
              subtitle="Screenshot retention"
              trailing={<Tag mono>Nightly purge</Tag>}
            />
          </List>
        </Card>
      </div>
    </>
  );
}

function LeadingIcon({ icon }: { icon: React.ReactNode }) {
  return <span className="prf-leading">{icon}</span>;
}

function ProfileSkeleton() {
  return (
    <>
      <Card className="prf-hero ui-rise-1">
        <div className="prf-hero__main">
          <div className="prf-skeleton-id">
            <Skeleton w={40} h={40} radius={999} />
            <div className="prf-skeleton-copy">
              <Skeleton w={180} h={16} />
              <Skeleton w={240} h={12} />
            </div>
          </div>
          <div className="prf-hero__tags">
            <Skeleton w={72} h={28} radius={999} />
            <Skeleton w={92} h={28} radius={999} />
          </div>
        </div>
        <div className="prf-hero__meta">
          {[0, 1, 2].map((i) => (
            <div key={i} className="prf-meta">
              <Skeleton w={90} h={10} />
              <Skeleton w={140} h={16} />
            </div>
          ))}
        </div>
      </Card>

      <div className="prf-layout ui-rise-2">
        {[0, 1].map((col) => (
          <div key={col} className="prf-stack">
            {[0, 1].map((card) => (
              <Card key={card}>
                <div className="prf-skeleton-card">
                  <Skeleton w={140} h={16} />
                  {[0, 1, 2].map((row) => (
                    <div key={row} className="prf-skeleton-row">
                      <Skeleton w={180} h={14} />
                      <Skeleton w={96} h={14} />
                    </div>
                  ))}
                </div>
              </Card>
            ))}
          </div>
        ))}
      </div>
    </>
  );
}

function friendlyRole(role: SelfProfileResponse['user']['displayRole']) {
  if (role === 'ADMIN') return 'Admin';
  if (role === 'MANAGER') return 'Manager';
  return 'Member';
}

function roleLine(role: SelfProfileResponse['user']['displayRole']) {
  if (role === 'ADMIN') return 'Workspace access';
  if (role === 'MANAGER') return 'Team scope';
  return 'Self scope';
}

function weekdayKey(date: Date, timeZone: string): Weekday {
  const local = zonedDateTimeParts(date, timeZone);
  const weekday = new Date(Date.UTC(local.year, local.month - 1, local.day)).getUTCDay();
  return ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][weekday] as Weekday;
}

function formatScheduleRange(slot: ShiftSchedule[Weekday] | undefined) {
  if (!slot) return 'Day off';
  return `${formatShiftClock(slot.start)} – ${formatShiftClock(slot.end)}`;
}

function countWorkingDays(schedule: ShiftSchedule) {
  return WEEKDAYS.filter((day) => schedule[day.key] !== null).length;
}

function shortName(name: string) {
  const [first] = name.trim().split(/\s+/u);
  return first || name;
}

function formatShiftClock(hhmm: string) {
  const [hourRaw, minuteRaw] = hhmm.split(':').map((part) => Number.parseInt(part, 10));
  const hour24 = hourRaw ?? 0;
  const minute = minuteRaw ?? 0;
  const suffix = hour24 >= 12 ? 'PM' : 'AM';
  const hour12 = hour24 % 12 || 12;
  return `${hour12}:${String(minute).padStart(2, '0')} ${suffix}`;
}

function formatLongDate(iso: string) {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(new Date(iso));
}
