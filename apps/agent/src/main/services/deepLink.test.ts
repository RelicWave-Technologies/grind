import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  completeLarkLogin: vi.fn(),
  cancelLarkLogin: vi.fn(),
  activate: vi.fn(async () => true),
  broadcast: vi.fn(),
}));

vi.mock('electron', () => ({ app: { setAsDefaultProtocolClient: vi.fn() } }));
vi.mock('./auth', () => ({ completeLarkLogin: mocks.completeLarkLogin, cancelLarkLogin: mocks.cancelLarkLogin }));
vi.mock('./signIn', () => ({ activateSignedInSession: mocks.activate }));
vi.mock('../broadcast', () => ({ broadcast: mocks.broadcast }));
vi.mock('../logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

const { flushQueuedDeepLink, handleDeepLink } = await import('./deepLink');
const { ApiNetworkError } = await import('./network');
const { CALLBACK_SCHEME } = await import('../env');

function nodeFailure(code: string): TypeError {
  return new TypeError('fetch failed', { cause: Object.assign(new Error(code), { code }) });
}

beforeEach(() => {
  vi.clearAllMocks();
  flushQueuedDeepLink();
});

describe('Lark sign-in callback', () => {
  it('finishes a successful exchange through the shared sign-in path', async () => {
    mocks.completeLarkLogin.mockResolvedValueOnce(true);

    await handleDeepLink(`${CALLBACK_SCHEME}://auth?code=abc`);

    expect(mocks.activate).toHaveBeenCalledWith('lark_callback');
    expect(mocks.broadcast).not.toHaveBeenCalledWith('auth:lark:push', expect.anything());
  });

  it('names TLS interception instead of a generic failure', async () => {
    mocks.completeLarkLogin.mockRejectedValueOnce(new ApiNetworkError('/v1/auth/lark/exchange', nodeFailure('UNABLE_TO_GET_ISSUER_CERT_LOCALLY')));

    await handleDeepLink(`${CALLBACK_SCHEME}://auth?code=abc`);

    expect(mocks.broadcast).toHaveBeenCalledWith('auth:lark:push', expect.objectContaining({
      kind: 'error',
      reason: 'network_intercepted',
    }));
    expect(mocks.activate).not.toHaveBeenCalled();
  });

  it('reports an unreachable server as such', async () => {
    mocks.completeLarkLogin.mockRejectedValueOnce(new ApiNetworkError('/v1/auth/lark/exchange', nodeFailure('ECONNRESET')));

    await handleDeepLink(`${CALLBACK_SCHEME}://auth?code=abc`);

    expect(mocks.broadcast).toHaveBeenCalledWith('auth:lark:push', expect.objectContaining({ reason: 'network_unreachable' }));
  });

  it('keeps auth_failed for a server that answered with a refusal', async () => {
    mocks.completeLarkLogin.mockRejectedValueOnce(new Error('/v1/auth/lark/exchange 400: invalid_code'));

    await handleDeepLink(`${CALLBACK_SCHEME}://auth?code=abc`);

    expect(mocks.broadcast).toHaveBeenCalledWith('auth:lark:push', { kind: 'error', reason: 'auth_failed' });
  });
});
