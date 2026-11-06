import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AccessRequestRecipientsResponse } from '@grind/types';
import { api } from '../lib/api';
import { accessRequestRecipientsQuery, ticketRecipientsQuery } from '../lib/queries';
import { Banner, Card, List, ListRow, Skeleton, Tag, Toggle } from '../ui';

/**
 * Policy card: which admins get the Lark card when a new person asks for
 * access. Everyone on = every admin (the default, and it picks up new admins);
 * switching someone off keeps the rest. The last one on can't be switched off,
 * since nobody chosen means everyone.
 */
export function AccessRecipientsCard() {
  return (
    <RecipientsCard
      title="Who approves new people on Lark"
      path="/v1/admin/access-requests/recipients"
      query={accessRequestRecipientsQuery<AccessRequestRecipientsResponse>()}
      what="access requests"
    />
  );
}

/** Policy card: which admins get the pinned Lark card for every support ticket. */
export function TicketRecipientsCard() {
  return (
    <RecipientsCard
      title="Who gets support tickets on Lark"
      path="/v1/tickets/recipients"
      query={ticketRecipientsQuery<AccessRequestRecipientsResponse>()}
      what="support tickets"
    />
  );
}

function RecipientsCard({
  title,
  path,
  query,
  what,
}: {
  title: string;
  path: string;
  query: ReturnType<typeof accessRequestRecipientsQuery<AccessRequestRecipientsResponse>>;
  what: string;
}) {
  const qc = useQueryClient();
  const q = useQuery(query);
  const m = useMutation({
    mutationFn: (userIds: string[]) => api<AccessRequestRecipientsResponse>(path, { method: 'PUT', json: { userIds } }),
    onSuccess: (next) => qc.setQueryData(query.queryKey, next),
  });

  const data = m.isPending && m.variables && q.data ? optimistic(q.data, m.variables) : q.data;
  const on = data ? new Set(data.admins.filter((a) => data.allAdmins || a.chosen).map((a) => a.id)) : new Set<string>();

  function flip(id: string, next: boolean) {
    if (!data) return;
    const chosen = new Set(on);
    if (next) chosen.add(id);
    else chosen.delete(id);
    // Everyone on is stored as "all admins", so admins added later get it too.
    m.mutate(chosen.size === data.admins.length ? [] : [...chosen]);
  }

  return (
    <Card
      title={title}
      className="pol-card-compact"
      action={<Tag mono>{!data ? 'Lark' : data.allAdmins ? 'All admins' : `${on.size} of ${data.admins.length}`}</Tag>}
    >
      <List>
        {!data
          ? [0, 1, 2].map((i) => <ListRow key={i} title={<Skeleton w={160} h={14} />} subtitle={<Skeleton w={220} h={12} />} />)
          : data.admins.map((a) => {
              const checked = on.has(a.id);
              const last = checked && on.size === 1;
              return (
                <ListRow
                  key={a.id}
                  title={a.name}
                  subtitle={a.hasLark ? a.email : `${a.email} · not signed in with Lark, can't receive cards`}
                  trailing={
                    <Toggle
                      checked={checked}
                      disabled={last || m.isPending}
                      aria-label={`Send ${what} to ${a.name}`}
                      title={last ? 'At least one admin gets the card' : undefined}
                      onChange={(v) => flip(a.id, v)}
                    />
                  }
                />
              );
            })}
      </List>
      {q.isError && <Banner status="danger">Couldn’t load admins: {(q.error as Error).message}</Banner>}
      {m.isError && <Banner status="danger">Couldn’t save: {(m.error as Error).message}</Banner>}
    </Card>
  );
}

function optimistic(prev: AccessRequestRecipientsResponse, userIds: string[]): AccessRequestRecipientsResponse {
  const chosen = new Set(userIds);
  return { allAdmins: chosen.size === 0, admins: prev.admins.map((a) => ({ ...a, chosen: chosen.has(a.id) })) };
}
