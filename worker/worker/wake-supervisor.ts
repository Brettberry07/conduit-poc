import { cycle, recoverJournals, type Call } from "./runner";
export const IDLE_FALLBACK_MS = 6 * 60 * 60 * 1000;
export class WakeGate {
  private generation = 1;
  private consumed = 0;
  private due = 0;
  private notify?: () => void;
  hint() {
    this.generation++;
    this.notify?.();
  }
  async sleep(
    wait: (ms: number) => Promise<void>,
    now: () => number,
    stopping: () => boolean,
  ) {
    while (
      !stopping() &&
      this.generation === this.consumed &&
      now() < this.due
    ) {
      await Promise.race([
        wait(Math.min(1000, this.due - now())),
        new Promise<void>((r) => {
          this.notify = r;
        }),
      ]);
      this.notify = undefined;
    }
  }
  begin() {
    return this.generation;
  }
  finish(epoch: number, now: number) {
    this.consumed = epoch;
    this.due = now + IDLE_FALLBACK_MS;
  }
}
export async function superviseWake(o: {
  call: Call;
  stateDir: string;
  limit: number;
  wait: (ms: number) => Promise<void>;
  stopping: () => boolean;
  reconcile: () => Promise<void>;
  gate: WakeGate;
  now?: () => number;
}) {
  if (!Number.isInteger(o.limit) || o.limit < 1 || o.limit > 4)
    throw Error("Invalid concurrency");
  const now = o.now ?? Date.now;
  const recovered = await recoverJournals(o.stateDir);
  let fatal: unknown;
  const stopping = () => o.stopping() || fatal !== undefined;
  // Recovery barrier: no fresh claims until every pre-existing journal is settled.
  await Promise.all(
    Array.from({ length: o.limit }, async () => {
      while (!stopping()) {
        const path = recovered.shift();
        if (!path) return;
        try {
          await cycle(
            o.call,
            o.stateDir,
            o.wait,
            stopping,
            path,
            undefined,
            false,
          );
        } catch (e) {
          fatal = e;
        }
      }
    }),
  );
  if (fatal !== undefined) throw fatal;
  const active = new Set<Promise<void>>();
  try {
    while (!stopping()) {
      const epoch = o.gate.begin();
      // A failed reconciliation or cycle stops fresh work; no hot retry or journal discard.
      try {
        await o.reconcile();
      } catch (e) {
        fatal = e;
        throw e;
      }
      const capacity = o.limit - active.size;
      for (let n = 0; n < capacity && !stopping(); n++) {
        let worked = false;
        let claimed = false;
        const task = cycle(
          o.call,
          o.stateDir,
          o.wait,
          stopping,
          null,
          () => {
            claimed = true;
          },
          false,
        )
          .then((result) => {
            worked = result;
          })
          .catch((e) => {
            fatal = e;
          })
          .finally(() => {
            active.delete(task);
            if (worked || claimed || fatal !== undefined) o.gate.hint();
          });
        active.add(task);
      }
      o.gate.finish(epoch, now());
      // Bounded scan rate even under a hint storm. Active cycles renew independently.
      if (!stopping()) await o.wait(5_000);
      await o.gate.sleep(o.wait, now, stopping);
    }
  } finally {
    await Promise.all(active);
  }
  if (fatal !== undefined) throw fatal;
}
