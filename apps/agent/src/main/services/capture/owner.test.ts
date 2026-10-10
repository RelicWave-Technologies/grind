import { describe, expect, it, vi } from 'vitest';

vi.mock('../timer', () => ({ getTimerService: () => ({ currentOwner: () => null }) }));

const { oncePerOwner, sameOwner } = await import('./owner');

describe('oncePerOwner', () => {
  it('claims once per owner change, not on every call', () => {
    const claim = vi.fn();
    const claimOnce = oncePerOwner(claim);
    const alice = { userId: 'alice', workspaceId: 'w' };
    const bob = { userId: 'bob', workspaceId: 'w' };

    claimOnce(alice);
    claimOnce({ ...alice });
    claimOnce(bob);
    claimOnce(bob);
    claimOnce(alice);

    expect(claim.mock.calls.map(([o]) => o.userId)).toEqual(['alice', 'bob', 'alice']);
  });

  it('tries again next time when a claim throws', () => {
    const claim = vi.fn().mockImplementationOnce(() => {
      throw new Error('db locked');
    });
    const claimOnce = oncePerOwner(claim);
    const alice = { userId: 'alice', workspaceId: 'w' };

    expect(() => claimOnce(alice)).toThrow('db locked');
    claimOnce(alice);
    claimOnce(alice);
    expect(claim).toHaveBeenCalledTimes(2);
  });
});

describe('sameOwner', () => {
  it('needs both sides present and equal', () => {
    expect(sameOwner({ userId: 'a', workspaceId: 'w' }, { userId: 'a', workspaceId: 'w' })).toBe(true);
    expect(sameOwner({ userId: 'a', workspaceId: 'w' }, { userId: 'a', workspaceId: 'x' })).toBe(false);
    expect(sameOwner(null, null)).toBe(false);
  });
});
