export interface HealthReport {
  ok: boolean;
  service: string;
  uptimeSec: number;
  sinceProgressSec: number | null;
  progress: number;
  reason?: string;
}

export interface HeartbeatOptions {
  /** Echoed in the body so a probe can reject an impostor on the same port. */
  service: string;
  /** Unhealthy after this long with no useful work. Omit to only report uptime. */
  stallAfterSec?: number;
  graceSec?: number;
}

/**
 * Tracks whether an agent is doing real work, not merely running. A payment
 * agent that has settled nothing in an hour is broken even though every
 * process is alive and every port answers.
 */
export class Heartbeat {
  private readonly startedAt = Date.now();
  private lastProgressAt: number | null = null;
  private count = 0;

  constructor(private readonly opts: HeartbeatOptions) {}

  progress(n = 1): void {
    this.count += n;
    this.lastProgressAt = Date.now();
  }

  report(): HealthReport {
    const now = Date.now();
    const uptimeSec = Math.floor((now - this.startedAt) / 1000);
    const sinceProgressSec =
      this.lastProgressAt === null ? null : Math.floor((now - this.lastProgressAt) / 1000);

    let ok = true;
    let reason: string | undefined;

    if (this.opts.stallAfterSec !== undefined) {
      const grace = this.opts.graceSec ?? this.opts.stallAfterSec;
      const idleFor = sinceProgressSec ?? uptimeSec;
      const stalled =
        this.lastProgressAt === null ? uptimeSec > grace : idleFor > this.opts.stallAfterSec;
      if (stalled) {
        ok = false;
        reason = `no progress in ${idleFor}s`;
      }
    }

    return { ok, service: this.opts.service, uptimeSec, sinceProgressSec, progress: this.count, reason };
  }
}

export interface ProbeOptions {
  url: string;
  expectService: string;
  timeoutMs?: number;
}

/**
 * Strict health probe. A 200 proves something is listening, not that it is
 * yours, so this also requires JSON naming the expected service. An unrelated
 * dev server answering the same port with HTML once hid a two day outage.
 */
export async function probe(opts: ProbeOptions): Promise<{ healthy: boolean; reason: string }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 8000);
  try {
    const res = await fetch(opts.url, { signal: ctrl.signal });
    if (res.status !== 200) return { healthy: false, reason: `status ${res.status}` };

    const text = await res.text();
    if (/^\s*<(!doctype|html)/i.test(text)) {
      return { healthy: false, reason: "HTML body: another service owns this port" };
    }

    let body: Partial<HealthReport>;
    try {
      body = JSON.parse(text) as Partial<HealthReport>;
    } catch {
      return { healthy: false, reason: "body is not JSON" };
    }

    if (body.service !== opts.expectService) {
      return { healthy: false, reason: `wrong service: got ${String(body.service)}` };
    }
    if (body.ok !== true) {
      return { healthy: false, reason: body.reason ?? "service reports not ok" };
    }
    return { healthy: true, reason: "ok" };
  } catch (e) {
    return { healthy: false, reason: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(timer);
  }
}

export interface ConcurrentLoopOptions {
  intervalSec: number;
  concurrency: number;
  task: () => Promise<void>;
}

/**
 * Tick loop that keeps N operations in flight.
 *
 * A single `if (busy) return` guard instead silently drops every tick landing
 * during an operation. When an operation outlasts the interval, throughput
 * pins at one per round trip and shortening the interval changes nothing.
 */
export function startConcurrentLoop(opts: ConcurrentLoopOptions): () => void {
  let active = 0;
  const tick = async () => {
    if (active >= opts.concurrency) return;
    active += 1;
    try {
      await opts.task();
    } finally {
      active -= 1;
    }
  };
  const handle = setInterval(() => void tick(), opts.intervalSec * 1000);
  return () => clearInterval(handle);
}
