import { Heartbeat } from "celo-agent-kit";

// Liveness is measured in settlements rather than uptime, so a desk that has
// stopped selling reports unhealthy even while the process is fine.
const STALL_AFTER_SEC = Number(process.env.HEALTH_STALL_AFTER_SEC ?? "900");

export const heartbeat = new Heartbeat({
  service: "bureau",
  stallAfterSec: process.env.SELF_BUY_ENABLED === "1" ? STALL_AFTER_SEC : undefined,
  graceSec: Number(process.env.HEALTH_GRACE_SEC ?? "300"),
});
