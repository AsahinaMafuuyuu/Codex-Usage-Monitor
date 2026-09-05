import {
  createHmac,
  randomBytes as cryptoRandomBytes,
  timingSafeEqual,
} from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assertContainedPath } from "./runtime-layout.js";

export const BROWSER_AUTH_PROTOCOL_VERSION = 1;
export const BROWSER_AUTH_CHALLENGE_TTL_MS = 60_000;
export const BROWSER_AUTH_COOKIE_MAX_AGE_SECONDS = 180 * 24 * 60 * 60;
const SECRET_BYTES = 32;
const MAX_CHALLENGES = 128;

export function ensureBrowserAuthSecret({
  stateRoot,
  mutableRoot,
  randomBytes = cryptoRandomBytes,
} = {}) {
  if (!stateRoot || !mutableRoot) throw new Error("browser auth 缺少 runtime state root");
  mkdirSync(stateRoot, { recursive: true });
  const path = assertContainedPath(mutableRoot, join(stateRoot, "browser-auth.key"), "browser auth secret");
  try {
    const descriptor = openSync(path, "wx", 0o600);
    try {
      writeFileSync(descriptor, randomBytes(SECRET_BYTES));
    } finally {
      closeSync(descriptor);
    }
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  const secret = readFileSync(path);
  if (secret.length !== SECRET_BYTES) {
    throw new Error("browser auth secret 格式损坏；拒绝静默覆盖");
  }
  return secret;
}

export function createBrowserAuth({
  secret,
  now = () => Date.now(),
  randomBytes = cryptoRandomBytes,
  challengeTtlMs = BROWSER_AUTH_CHALLENGE_TTL_MS,
  cookieMaxAgeSeconds = BROWSER_AUTH_COOKIE_MAX_AGE_SECONDS,
} = {}) {
  assertSecret(secret);
  const challenges = new Map();

  const createBootstrapChallenge = (origin) => {
    const issuedAt = Number(now());
    pruneChallenges(challenges, issuedAt);
    while (challenges.size >= MAX_CHALLENGES) {
      challenges.delete(challenges.keys().next().value);
    }
    const challenge = randomBytes(24).toString("base64url");
    const expiresAt = issuedAt + challengeTtlMs;
    challenges.set(challenge, { origin, expiresAt });
    return {
      protocolVersion: BROWSER_AUTH_PROTOCOL_VERSION,
      challenge,
      expiresAt,
    };
  };

  const consumeBootstrapProof = ({ origin, challenge, proof, expiresAt, protocolVersion }) => {
    const record = challenges.get(challenge);
    if (!record) return false;
    challenges.delete(challenge);
    const currentTime = Number(now());
    if (
      protocolVersion !== BROWSER_AUTH_PROTOCOL_VERSION
      || record.origin !== origin
      || record.expiresAt !== expiresAt
      || currentTime > record.expiresAt
    ) return false;
    const expected = createBootstrapProof({
      secret,
      origin,
      challenge,
      expiresAt,
      protocolVersion,
    });
    return safeEqualText(expected, proof);
  };

  const issueCookie = (origin) => {
    const issuedAt = Number(now());
    const payload = {
      v: BROWSER_AUTH_PROTOCOL_VERSION,
      iat: issuedAt,
      exp: issuedAt + cookieMaxAgeSeconds * 1000,
      nonce: randomBytes(16).toString("base64url"),
      origin,
    };
    const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
    return `${encoded}.${sign(secret, `cookie\n${encoded}`)}`;
  };

  const verifyCookie = (cookieValue, origin) => {
    if (typeof cookieValue !== "string" || cookieValue.length > 4096) return false;
    const dot = cookieValue.indexOf(".");
    if (dot < 1 || dot !== cookieValue.lastIndexOf(".")) return false;
    const encoded = cookieValue.slice(0, dot);
    const mac = cookieValue.slice(dot + 1);
    if (!safeEqualText(sign(secret, `cookie\n${encoded}`), mac)) return false;
    let payload;
    try {
      payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    } catch {
      return false;
    }
    const currentTime = Number(now());
    return payload?.v === BROWSER_AUTH_PROTOCOL_VERSION
      && payload?.origin === origin
      && Number.isFinite(payload?.iat)
      && Number.isFinite(payload?.exp)
      && payload.exp >= currentTime
      && payload.iat <= currentTime + 5_000
      && typeof payload?.nonce === "string"
      && payload.nonce.length >= 16;
  };

  return Object.freeze({
    createBootstrapChallenge,
    consumeBootstrapProof,
    issueCookie,
    verifyCookie,
  });
}

export function createBootstrapProof({
  secret,
  origin,
  challenge,
  expiresAt,
  protocolVersion = BROWSER_AUTH_PROTOCOL_VERSION,
}) {
  assertSecret(secret);
  return sign(secret, `${protocolVersion}\n${origin}\n${challenge}\n${expiresAt}`);
}

function sign(secret, text) {
  return createHmac("sha256", secret).update(text, "utf8").digest("base64url");
}

function safeEqualText(expected, actual) {
  if (typeof actual !== "string") return false;
  const left = Buffer.from(expected, "utf8");
  const right = Buffer.from(actual, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

function assertSecret(secret) {
  if (!Buffer.isBuffer(secret) || secret.length !== SECRET_BYTES) {
    throw new Error("browser auth secret 必须是 32 bytes Buffer");
  }
}

function pruneChallenges(challenges, now) {
  for (const [challenge, record] of challenges) {
    if (record.expiresAt < now) challenges.delete(challenge);
  }
}
