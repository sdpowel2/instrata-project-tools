/**
 * Outbound rate control for Procore calls (spec §7):
 *  - a small per-user concurrency cap so get_project_activity's fan-out can't spike
 *  - honor 429 Retry-After, else exponential backoff with jitter (max 3 retries)
 *  - one retry on 5xx
 */

/** Simple FIFO semaphore. acquire() resolves when a slot is free; call release to free it. */
export class Semaphore {
  private active = 0;
  private readonly queue: Array<() => void> = [];

  constructor(private readonly max: number) {}

  acquire(): Promise<() => void> {
    return new Promise((resolve) => {
      const attempt = () => {
        if (this.active < this.max) {
          this.active++;
          let released = false;
          resolve(() => {
            if (released) return;
            released = true;
            this.active--;
            this.queue.shift()?.();
          });
        } else {
          this.queue.push(attempt);
        }
      };
      attempt();
    });
  }
}

// One semaphore per user id so the cap is genuinely per-user.
const limiters = new Map<string, Semaphore>();

export function limiterFor(userId: string, max: number): Semaphore {
  let s = limiters.get(userId);
  if (!s) {
    s = new Semaphore(max);
    limiters.set(userId, s);
  }
  return s;
}

const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 500;

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function retryAfterMs(res: Response): number | undefined {
  const h = res.headers.get('retry-after');
  if (!h) return undefined;
  const secs = Number(h);
  return Number.isNaN(secs) ? undefined : secs * 1000;
}

function backoffMs(attempt: number): number {
  const jitter = Math.floor(Math.random() * 250);
  return BASE_BACKOFF_MS * 2 ** attempt + jitter;
}

/** fetch() with Procore-aware retry on 429 and 5xx. */
export async function procoreFetch(url: string, init: RequestInit): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, init);
    if (res.status === 429 && attempt < MAX_RETRIES) {
      await delay(retryAfterMs(res) ?? backoffMs(attempt));
      continue;
    }
    if (res.status >= 500 && res.status < 600 && attempt < MAX_RETRIES) {
      await delay(backoffMs(attempt));
      continue;
    }
    return res;
  }
}
