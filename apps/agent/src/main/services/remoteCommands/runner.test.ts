import { describe, expect, it, vi } from 'vitest';
import type { AgentCommandWire } from '@grind/types';
import { RemoteCommandRunner, type CommandOutcome, type RemoteCommandMemory } from './runner';

class MemMemory implements RemoteCommandMemory {
  started = new Set<string>();
  notes = new Map<string, string>();
  markStarted(id: string) {
    if (this.started.has(id)) return false;
    this.started.add(id);
    return true;
  }
  load(id: string) {
    return this.notes.get(id) ?? null;
  }
  save(id: string, value: string) {
    this.notes.set(id, value);
  }
}

const RESYNC: AgentCommandWire = { id: 'cmd_1', type: 'RESYNC', params: { from: '2026-10-05', to: '2026-10-05' } };

function setup(over: {
  execute?: (command: AgentCommandWire) => Promise<CommandOutcome>;
  post?: (id: string, outcome: CommandOutcome) => Promise<void>;
  memory?: RemoteCommandMemory | null;
} = {}) {
  const memory = over.memory === undefined ? new MemMemory() : over.memory;
  const execute = vi.fn(over.execute ?? (async () => ({ status: 'DONE' as const, result: { requeued: 2 } })));
  const post = vi.fn(over.post ?? (async () => undefined));
  const log = { info: vi.fn(), warn: vi.fn() };
  const runner = new RemoteCommandRunner({ memory: () => memory, execute, post, log });
  return { runner, memory, execute, post, log };
}

describe('RemoteCommandRunner', () => {
  it('runs a command once, posts its outcome, and logs one line', async () => {
    const { runner, execute, post, log } = setup();

    await runner.handle([RESYNC]);

    expect(execute).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith('cmd_1', { status: 'DONE', result: { requeued: 2 } });
    expect(log.info).toHaveBeenCalledTimes(1);
    expect(log.info).toHaveBeenCalledWith('remote command finished', expect.objectContaining({ id: 'cmd_1', status: 'DONE' }));
  });

  it('never runs a re-delivered command twice; it re-posts the stored outcome', async () => {
    const { runner, execute, post } = setup();
    await runner.handle([RESYNC]);
    await runner.handle([RESYNC]);

    expect(execute).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledTimes(2);
    expect(post.mock.calls[1]).toEqual(['cmd_1', { status: 'DONE', result: { requeued: 2 } }]);
  });

  it('remembers across restarts through its memory', async () => {
    const memory = new MemMemory();
    await setup({ memory }).runner.handle([RESYNC]);
    const second = setup({ memory });

    await second.runner.handle([RESYNC]);

    expect(second.execute).not.toHaveBeenCalled();
    expect(second.post).toHaveBeenCalledWith('cmd_1', { status: 'DONE', result: { requeued: 2 } });
  });

  it('survives a failed post and retries it on the next hand-over, even with no commands', async () => {
    let fail = true;
    const { runner, execute, post, memory, log } = setup({
      post: async () => {
        if (fail) throw new Error('offline');
      },
    });

    await expect(runner.handle([RESYNC])).resolves.toBeUndefined();
    expect(log.warn).toHaveBeenCalledWith('remote command result not delivered; will retry', expect.objectContaining({ id: 'cmd_1' }));
    expect(JSON.parse((memory as MemMemory).notes.get('cmd_1')!)).toMatchObject({ status: 'DONE', posted: false });

    fail = false;
    await runner.handle(undefined);

    expect(execute).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledTimes(2);
    expect(JSON.parse((memory as MemMemory).notes.get('cmd_1')!)).toMatchObject({ status: 'DONE', posted: true });
    // Nothing owed any more.
    await runner.handle(undefined);
    expect(post).toHaveBeenCalledTimes(2);
  });

  it('reports a thrown command as FAILED instead of throwing', async () => {
    const { runner, post } = setup({ execute: async () => { throw new Error('signed_out'); } });

    await expect(runner.handle([RESYNC])).resolves.toBeUndefined();

    expect(post).toHaveBeenCalledWith('cmd_1', { status: 'FAILED', error: 'signed_out' });
  });

  it('reports a command cut short by a restart as FAILED without running it again', async () => {
    const memory = new MemMemory();
    memory.markStarted('cmd_1'); // started, never finished
    const { runner, execute, post } = setup({ memory });

    await runner.handle([RESYNC]);

    expect(execute).not.toHaveBeenCalled();
    expect(post).toHaveBeenCalledWith('cmd_1', expect.objectContaining({ status: 'FAILED', error: expect.stringContaining('interrupted') }));
  });

  it('runs one command at a time, in arrival order, including ones handed over mid-run', async () => {
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { runner } = setup({
      execute: async (command) => {
        order.push(`start:${command.id}`);
        if (command.id === 'cmd_1') await gate;
        order.push(`end:${command.id}`);
        return { status: 'DONE' };
      },
    });

    const first = runner.handle([RESYNC]);
    const second = runner.handle([{ ...RESYNC, id: 'cmd_2' }]);
    expect(second).toBe(first);
    release();
    await first;

    expect(order).toEqual(['start:cmd_1', 'end:cmd_1', 'start:cmd_2', 'end:cmd_2']);
  });

  it('ignores malformed input and does nothing while signed out', async () => {
    const signedOut = setup({ memory: null });
    await signedOut.runner.handle([RESYNC]);
    expect(signedOut.execute).not.toHaveBeenCalled();

    const { runner, execute } = setup();
    await runner.handle('nonsense');
    await runner.handle([{ id: '', type: 'RESYNC', params: {} }, { nope: true }, null]);
    expect(execute).not.toHaveBeenCalled();
  });

  it('contains a memory that throws', async () => {
    const memory = new MemMemory();
    memory.load = () => { throw new Error('sqlite_busy'); };
    const { runner, log } = setup({ memory });

    await expect(runner.handle([RESYNC])).resolves.toBeUndefined();
    expect(log.warn).toHaveBeenCalledWith('remote command runner failed', expect.objectContaining({ err: 'sqlite_busy' }));
  });
});
