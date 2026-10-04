import { Rng, seedFor } from '../prng';
import type { FnSpec } from '../fixture';
import { plain } from './seq';

/**
 * Specs whose real TypeScript is asynchronous (promises, awaited handlers).
 *
 * The recorder calls `spec.call(input)` synchronously, so these specs run
 * every scenario ahead of time (top-level await in the generator module),
 * keyed by the input object, and `call` looks the result up. For that to line
 * up with what the recorder asks for, the inputs are generated here from the
 * same seed the recorder derives (`seedFor(module/fn) ^ PARITY_SALT`) and handed
 * out in order: all the hand-picked ones, then `--count` random ones.
 */
const args = process.argv.slice(2);
const countFlag = args.indexOf('--count');
const COUNT = countFlag === -1 ? 500 : Number(args[countFlag + 1]);
const SALT = Number(process.env.PARITY_SALT ?? 0);

export interface AsyncDef<I> {
  module: string;
  fn: string;
  edge: () => I[];
  random: (rng: Rng) => I;
  /** Runs one scenario against the real TypeScript and returns what to record. */
  run: (input: I) => Promise<unknown>;
}

export async function asyncSpec<I extends object>(def: AsyncDef<I>): Promise<FnSpec<I>> {
  const rng = new Rng((seedFor(`${def.module}/${def.fn}`) ^ SALT) >>> 0);
  const edges = def.edge();
  const randoms: I[] = [];
  for (let i = 0; i < COUNT; i++) randoms.push(def.random(rng));
  const results = new Map<I, unknown>();
  for (const input of [...edges, ...randoms]) results.set(input, plain(await def.run(input)));
  let next = 0;
  return {
    module: def.module,
    fn: def.fn,
    edge: () => {
      next = 0;
      return edges;
    },
    random: () => {
      const input = randoms[next++];
      if (input === undefined) throw new Error(`${def.module}/${def.fn}: more random cases requested than the ${COUNT} precomputed`);
      return input;
    },
    call: (input) => {
      if (!results.has(input)) throw new Error(`${def.module}/${def.fn}: no precomputed result for this input`);
      return results.get(input);
    },
  };
}
