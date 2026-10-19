/**
 * Account-protection limits on top of Meta's documented ceiling.
 *
 * The built-in limiter enforces one thing: 750 private replies per hour, which
 * is Meta's documented cap with no headroom. That is the line past which the
 * API starts refusing — it is not a safe operating speed for an account that
 * has never sent an automated DM before. A new account that suddenly emits
 * hundreds of identical-looking DMs is the shape of behaviour platforms
 * restrict, and a restriction costs the account, not the campaign.
 *
 * Everything here is OFF by default, so an instance that sets nothing behaves
 * exactly as before. Each control is a separate env var because they protect
 * against different things and want different values per account age.
 */
import Redis from "ioredis";
import { prisma } from "@/lib/db/client";
import {
  MetaApiError,
  RateLimitError,
  TokenExpiredError,
} from "@/lib/meta/client";

let redis: Redis | null = null;
function getRedis(): Redis {
  if (!redis) {
    redis = new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: null });
  }
  return redis;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

// ---------------------------------------------------------------------------
// Daily cap, with an optional warm-up ramp
// ---------------------------------------------------------------------------

/**
 * The cap for today. `DM_DAILY_LIMIT_RAMP` is a comma-separated list read by
 * the account's age in days since its first delivered DM: "50,50,50,100,200"
 * means 50/day for three days, then 100, then 200, then the last value
 * forever. The ramp exists so nobody has to remember to raise a number by
 * hand on day four — a forgotten bump is either a throttled launch or, worse,
 * a jump to full speed that was meant to be gradual.
 *
 * 0 (the default) means no daily cap.
 */
export async function getDailyLimit(
  instagramAccountId: string
): Promise<number> {
  const ramp = (process.env.DM_DAILY_LIMIT_RAMP ?? "")
    .split(",")
    .map((v) => Number.parseInt(v.trim(), 10))
    .filter((v) => Number.isFinite(v) && v > 0);

  if (ramp.length === 0) return envInt("DM_DAILY_LIMIT", 0);

  const first = await prisma.dmLog.findFirst({
    where: { instagramAccountId, status: "SENT" },
    orderBy: { dmSentAt: "asc" },
    select: { dmSentAt: true },
  });
  // Nothing sent yet: day zero, the most cautious rung.
  if (!first?.dmSentAt) return ramp[0];

  const days = Math.floor(
    (Date.now() - first.dmSentAt.getTime()) / 86_400_000
  );
  return ramp[Math.min(days, ramp.length - 1)];
}

function dayKey(instagramAccountId: string): string {
  // UTC day. The exact boundary matters less than it being stable, and a
  // local-time boundary would move under a server timezone change.
  const today = new Date().toISOString().slice(0, 10);
  return `rate:dm:day:${instagramAccountId}:${today}`;
}

const RESERVE_DAILY_SCRIPT = `
local current = tonumber(redis.call("GET", KEYS[1]) or "0")
local max = tonumber(ARGV[1])
if current >= max then
  return {0, current}
end
local next_count = redis.call("INCR", KEYS[1])
if next_count == 1 then
  redis.call("EXPIRE", KEYS[1], tonumber(ARGV[2]))
end
return {1, next_count}
`;

export interface DailySlot {
  allowed: boolean;
  used: number;
  limit: number;
  /** ms until the cap resets, for requeueing rather than dropping the lead. */
  resetInMs: number;
}

export async function reserveDailySlot(
  instagramAccountId: string
): Promise<DailySlot> {
  const limit = await getDailyLimit(instagramAccountId);
  if (limit === 0) {
    return { allowed: true, used: 0, limit: 0, resetInMs: 0 };
  }

  const now = new Date();
  const midnight = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1
  );
  const resetInMs = midnight - now.getTime();

  const result = await getRedis().eval(
    RESERVE_DAILY_SCRIPT,
    1,
    dayKey(instagramAccountId),
    limit,
    // Two days of TTL so a key written just before midnight still expires.
    172_800
  );
  const values = Array.isArray(result) ? result : [];
  const allowed = Number(values[0]) === 1;
  return { allowed, used: Number(values[1]) || 0, limit, resetInMs };
}

/** Hand back a daily slot when the send it was reserved for never happened. */
export async function releaseDailySlot(
  instagramAccountId: string
): Promise<void> {
  const key = dayKey(instagramAccountId);
  const next = await getRedis().decr(key);
  if (next < 0) await getRedis().del(key);
}

// ---------------------------------------------------------------------------
// Pacing: never two sends back to back
// ---------------------------------------------------------------------------

const CLAIM_PACING_SCRIPT = `
local now = tonumber(ARGV[1])
local spacing = tonumber(ARGV[2])
local last = tonumber(redis.call("GET", KEYS[1]) or "0")
local next_at = math.max(now, last + spacing)
redis.call("SET", KEYS[1], next_at, "PX", 7200000)
return next_at - now
`;

/**
 * Claim this account's next send moment and report how long to wait for it.
 *
 * A reel that lands well produces a burst of comments within minutes, and
 * answering all of them in the same second is the clearest automated
 * signature an account can emit. Each caller claims the next slot atomically,
 * so concurrent workers queue up behind each other instead of all firing at
 * once. The jitter keeps the gaps from being a machine-perfect constant.
 *
 * Returns 0 when pacing is off or the slot is already due.
 */
export async function claimPacingDelayMs(
  instagramAccountId: string
): Promise<number> {
  const baseSeconds = envInt("DM_MIN_SPACING_SECONDS", 0);
  if (baseSeconds === 0) return 0;

  const jitterSeconds = envInt("DM_SPACING_JITTER_SECONDS", 0);
  const spacingMs =
    baseSeconds * 1000 + Math.floor(Math.random() * (jitterSeconds * 1000 + 1));

  const waitMs = await getRedis().eval(
    CLAIM_PACING_SCRIPT,
    1,
    `rate:dm:pace:${instagramAccountId}`,
    Date.now(),
    spacingMs
  );
  return Math.max(0, Number(waitMs) || 0);
}

// ---------------------------------------------------------------------------
// One DM per person per campaign
// ---------------------------------------------------------------------------

/**
 * Whether this campaign already delivered a DM to this person.
 *
 * The built-in dedup is keyed on the comment, which stops two campaigns
 * answering the same comment but not the same person commenting twice. From
 * the recipient's side a second identical DM is the moment a helpful reply
 * becomes spam, and reporting it is one tap away.
 */
export async function alreadyDmedPerson(
  automationId: string,
  commenterId: string | null | undefined
): Promise<boolean> {
  if (!commenterId) return false;
  if (process.env.DM_ONE_PER_PERSON !== "true") return false;
  const prior = await prisma.dmLog.findFirst({
    where: { automationId, commenterId, status: "SENT" },
    select: { id: true },
  });
  return Boolean(prior);
}

// ---------------------------------------------------------------------------
// Restriction detection and the stop switch
// ---------------------------------------------------------------------------

/**
 * Whether an error looks like the platform acting against the ACCOUNT, rather
 * than refusing one particular message.
 *
 * Deliberately excludes code 551 (that one recipient cannot be messaged) and
 * token expiry, which are routine. Codes 4/17/32 are app and account level
 * throttling, 368 is the policy block, and 10/200 are permission refusals that
 * also show up when an account is actioned.
 */
export function isAccountRestrictionError(error: unknown): boolean {
  if (error instanceof TokenExpiredError) return false;
  if (error instanceof RateLimitError) return true;
  return (
    error instanceof MetaApiError && [4, 17, 32, 368, 10, 200].includes(error.code)
  );
}

/**
 * Pause every campaign on the account and record why.
 *
 * Deliberately blunt: when the platform pushes back, the right move is to stop
 * sending and let a human look, not to keep trying more slowly. Idempotent, so
 * a burst of failing sends pauses once and logs once.
 */
export async function pauseAccountAndAlert(
  instagramAccountId: string,
  reason: string
): Promise<boolean> {
  if (process.env.DM_AUTOPAUSE_ON_RESTRICTION !== "true") return false;

  const stillActive = await prisma.automation.count({
    where: { instagramAccountId, isActive: true },
  });
  if (stillActive === 0) return false;

  const { count } = await prisma.automation.updateMany({
    where: { instagramAccountId, isActive: true },
    data: { isActive: false },
  });

  const account = await prisma.instagramAccount.findUnique({
    where: { id: instagramAccountId },
    select: { username: true, workspaceId: true },
  });

  await prisma.operationalEvent.create({
    data: {
      workspaceId: account?.workspaceId ?? null,
      source: "WORKER",
      level: "ERROR",
      message: `Autopaused ${count} campaign(s) on @${account?.username ?? instagramAccountId}: ${reason}`,
      payload: { instagramAccountId, pausedCount: count, reason },
    },
  });

  console.error(
    `[send-guard] PAUSED ${count} campaign(s) on ${instagramAccountId}: ${reason}`
  );

  await sendAlertEmail(
    `OpenReply pausó ${count} campaña(s) de @${account?.username ?? instagramAccountId}`,
    `Instagram devolvió un error que parece una restricción de cuenta, así que se han pausado todas las campañas de esa cuenta.\n\nMotivo: ${reason}\n\nRevisa los registros de DM antes de reactivar nada.`
  );
  return true;
}

/**
 * Best-effort alert over the SMTP transport the magic-link login already uses.
 * Never throws: failing to warn must not also fail the pause.
 */
async function sendAlertEmail(subject: string, body: string): Promise<void> {
  const to = process.env.SAFETY_ALERT_EMAIL;
  const server = process.env.EMAIL_SERVER;
  const from = process.env.EMAIL_FROM;
  if (!to || !server || !from) return;
  try {
    const nodemailer = await import("nodemailer");
    await nodemailer
      .createTransport(server)
      .sendMail({ to, from, subject, text: body });
  } catch (error) {
    console.error("[send-guard] alert email failed", error);
  }
}
