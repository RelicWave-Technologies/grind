import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Clipboard, KeyRound, Plus, Trash2 } from 'lucide-react';
import type {
  ApiTokenDto,
  ApiTokenScope,
  CreateApiTokenResponse,
} from '@grind/types';
import { API_TOKEN_SCOPES } from '@grind/types';
import { api } from '../lib/api';
import {
  Page,
  PageHeader,
  Card,
  Field,
  Input,
  Checkbox,
  Button,
  IconButton,
  Banner,
  EmptyState,
  Table,
  THead,
  Tbody,
  Tr,
  Th,
  Td,
  Tag,
  Toolbar,
  SkeletonTable,
} from '../ui';
import './integrations.css';

const SCOPE_LABELS: Record<ApiTokenScope, string> = {
  'read:people': 'People',
  'read:device-health': 'Device health',
  'read:time-summary': 'Time summary',
  'read:manual-time': 'Manual time',
};

const SCOPE_STATUS: Record<ApiTokenScope, 'neutral' | 'info' | 'success' | 'warn'> = {
  'read:people': 'neutral',
  'read:device-health': 'info',
  'read:time-summary': 'success',
  'read:manual-time': 'warn',
};

function formatDateParts(value: string | null): { date: string; time: string } | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return {
    date: new Intl.DateTimeFormat('en-IN', {
      day: '2-digit',
      month: 'short',
      year: '2-digit',
    }).format(date),
    time: new Intl.DateTimeFormat('en-IN', {
      hour: '2-digit',
      minute: '2-digit',
    }).format(date),
  };
}

function DateStamp({ value, prefix }: { value: string | null; prefix?: string }) {
  const parts = formatDateParts(value);
  if (!parts) return <span className="int-date-empty">Never</span>;
  return (
    <span className="int-date-stamp">
      {prefix && <small>{prefix}</small>}
      <span>{parts.date}</span>
      <small>{parts.time}</small>
    </span>
  );
}

function formatTooltipDate(value: string | null): string {
  if (!value) return 'Never';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Never';
  return new Intl.DateTimeFormat('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

export function IntegrationsScreen() {
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<ApiTokenScope[]>([...API_TOKEN_SCOPES]);
  const [createdToken, setCreatedToken] = useState<CreateApiTokenResponse | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirmRevokeId, setConfirmRevokeId] = useState<string | null>(null);

  const tokensQ = useQuery({
    queryKey: ['admin', 'api-tokens'],
    queryFn: () => api<{ tokens: ApiTokenDto[] }>('/v1/admin/api-tokens'),
  });

  const activeTokens = useMemo(
    () => tokensQ.data?.tokens.filter((token) => !token.revokedAt).length ?? 0,
    [tokensQ.data?.tokens],
  );

  const createToken = useMutation({
    mutationFn: () =>
      api<CreateApiTokenResponse>('/v1/admin/api-tokens', {
        method: 'POST',
        json: { name: name.trim(), scopes },
      }),
    onSuccess: (res) => {
      setCreatedToken(res);
      setName('');
      setScopes([...API_TOKEN_SCOPES]);
      setCopied(false);
      qc.invalidateQueries({ queryKey: ['admin', 'api-tokens'] });
    },
  });

  const revokeToken = useMutation({
    mutationFn: (tokenId: string) =>
      api<{ ok: true }>(`/v1/admin/api-tokens/${tokenId}/revoke`, { method: 'POST' }),
    onSuccess: () => {
      setConfirmRevokeId(null);
      qc.invalidateQueries({ queryKey: ['admin', 'api-tokens'] });
    },
  });

  const canCreate = name.trim().length > 0 && scopes.length > 0 && !createToken.isPending;

  function toggleScope(scope: ApiTokenScope) {
    setScopes((current) =>
      current.includes(scope)
        ? current.filter((item) => item !== scope)
        : [...current, scope],
    );
  }

  async function copyCreatedToken() {
    if (!createdToken) return;
    await navigator.clipboard.writeText(createdToken.token);
    setCopied(true);
  }

  return (
    <Page>
      <PageHeader
        eyebrow="Admin · Integrations"
        title="API tokens"
        subtitle="Create scoped, read-only tokens for local MCP clients."
        actions={
          <Toolbar>
            <Tag status="neutral" dot>{activeTokens} active</Tag>
          </Toolbar>
        }
      />

      <Card
        variant="flush"
        className="int-token-table-card rise rise-1"
        title="Tokens"
        action={tokensQ.data?.tokens.length ? <Tag status="neutral">{tokensQ.data.tokens.length} total</Tag> : null}
      >
        <div className="int-create-strip">
          <div className="int-create-name">
            <span className="int-token-icon" aria-hidden>
              <KeyRound size={16} strokeWidth={1.9} />
            </span>
            <Field label="New token" hint="Secret is shown once." className="int-name-field">
              <Input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Local MCP"
                maxLength={80}
              />
            </Field>
          </div>

          <div className="int-scope-field">
            <span className="ui-t-eyebrow">Scopes</span>
            <div className="int-scope-list">
              {API_TOKEN_SCOPES.map((scope) => (
                <label key={scope} className="int-scope">
                  <Checkbox
                    checked={scopes.includes(scope)}
                    onChange={() => toggleScope(scope)}
                  />
                  <Tag status={SCOPE_STATUS[scope]}>{SCOPE_LABELS[scope]}</Tag>
                </label>
              ))}
            </div>
          </div>

          <Button
            variant="primary"
            icon={<Plus size={16} strokeWidth={2.2} />}
            loading={createToken.isPending}
            disabled={!canCreate}
            onClick={() => createToken.mutate()}
          >
            Create
          </Button>
        </div>

        {createToken.isError && (
          <div className="int-inline-banner">
            <Banner status="danger">
              {(createToken.error as Error).message}
            </Banner>
          </div>
        )}

        {createdToken && (
          <div className="int-token-once" role="status" aria-live="polite">
            <div className="int-token-once-copy">
              <span className="ui-t-eyebrow">Copy once</span>
              <div className="int-token-box" aria-label="New API token">{createdToken.token}</div>
            </div>
            <Button
              variant={copied ? 'soft' : 'secondary'}
              icon={copied ? <Check size={16} strokeWidth={2.4} /> : <Clipboard size={16} strokeWidth={2.1} />}
              onClick={copyCreatedToken}
            >
              {copied ? 'Copied' : 'Copy'}
            </Button>
          </div>
        )}

        {tokensQ.isLoading ? (
          <SkeletonTable rows={5} />
        ) : tokensQ.isError ? (
          <EmptyState
            tone="danger"
            title="Couldn’t load tokens"
            description={(tokensQ.error as Error).message}
          />
        ) : tokensQ.data?.tokens.length ? (
          <div className="int-table-wrap">
            <Table className="int-table">
              <colgroup>
                <col className="int-col-name" />
                <col className="int-col-prefix" />
                <col className="int-col-scopes" />
                <col className="int-col-created" />
                <col className="int-col-used" />
                <col className="int-col-action" />
              </colgroup>
              <THead>
                <Tr>
                  <Th>Name</Th>
                  <Th>Prefix</Th>
                  <Th>Scopes</Th>
                  <Th>Created</Th>
                  <Th>Last used</Th>
                  <Th align="right">Action</Th>
                </Tr>
              </THead>
              <Tbody>
                {tokensQ.data.tokens.map((token) => {
                  const revoked = !!token.revokedAt;
                  const confirming = confirmRevokeId === token.id;
                  return (
                    <Tr key={token.id} rail={revoked ? 'danger' : 'success'}>
                      <Td>
                        <div className="int-token-name">
                          <span className="int-token-icon" aria-hidden>
                            <KeyRound size={16} strokeWidth={1.9} />
                          </span>
                          <span>
                            <strong>{token.name}</strong>
                            <small>{token.createdBy.name}</small>
                          </span>
                        </div>
                      </Td>
                      <Td mono className="int-prefix-cell">{token.tokenPrefix}</Td>
                      <Td>
                        <div className="int-tags">
                          {token.scopes.map((scope) => (
                            <Tag key={scope} status={SCOPE_STATUS[scope]}>{SCOPE_LABELS[scope]}</Tag>
                          ))}
                        </div>
                      </Td>
                      <Td className="int-date-cell" title={formatTooltipDate(token.createdAt)}>
                        <DateStamp value={token.createdAt} />
                      </Td>
                      <Td className="int-date-cell" title={formatTooltipDate(revoked ? token.revokedAt : token.lastUsedAt)}>
                        <DateStamp value={revoked ? token.revokedAt : token.lastUsedAt} prefix={revoked ? 'Revoked' : undefined} />
                      </Td>
                      <Td align="right" className="int-action-cell">
                        {revoked ? (
                          <Tag status="neutral">Revoked</Tag>
                        ) : confirming ? (
                          <div className="int-confirm">
                            <Button
                              variant="danger"
                              size="sm"
                              loading={revokeToken.isPending}
                              onClick={() => revokeToken.mutate(token.id)}
                            >
                              Confirm
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              disabled={revokeToken.isPending}
                              onClick={() => setConfirmRevokeId(null)}
                            >
                              Cancel
                            </Button>
                          </div>
                        ) : (
                          <IconButton
                            aria-label={`Revoke ${token.name}`}
                            variant="ghost"
                            icon={<Trash2 size={16} strokeWidth={1.9} />}
                            onClick={() => setConfirmRevokeId(token.id)}
                          />
                        )}
                      </Td>
                    </Tr>
                  );
                })}
              </Tbody>
            </Table>
          </div>
        ) : (
          <EmptyState
            title="No API tokens yet"
            description="Create a scoped token from the row above before connecting a local MCP client."
          />
        )}
      </Card>
    </Page>
  );
}
