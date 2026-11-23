import crypto from "node:crypto";
import { config } from "../config/env.js";

function base64UrlDecode(str) {
  const normalized = str.replace(/-/g, "+").replace(/_/g, "/");
  const pad = normalized.length % 4 ? "=".repeat(4 - (normalized.length % 4)) : "";
  return Buffer.from(normalized + pad, "base64");
}

function verifyHs256Jwt(token, secret) {
  if (!secret) {
    throw new Error("JWT_SECRET is not configured on backend-node.");
  }
  const parts = token.split(".");
  if (parts.length !== 3) return null;

  const [headB64, bodyB64, sigB64] = parts;
  let header;
  let payload;
  try {
    header = JSON.parse(base64UrlDecode(headB64).toString("utf8"));
    payload = JSON.parse(base64UrlDecode(bodyB64).toString("utf8"));
  } catch {
    return null;
  }

  if (!header || header.alg !== "HS256" || !payload || typeof payload !== "object") {
    return null;
  }

  const expected = crypto
    .createHmac("sha256", secret)
    .update(`${headB64}.${bodyB64}`)
    .digest();
  const actual = base64UrlDecode(sigB64);

  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
    return null;
  }

  if (payload.exp && Math.floor(Date.now() / 1000) >= Number(payload.exp)) {
    return null;
  }

  return payload;
}

/**
 * Computes HMAC-SHA256 signature header value (`sha256=<hex>`) over `${timestamp}.${rawBody}`.
 */
export function computeHmacSignature(secret, timestamp, rawBody) {
  const hex = crypto
    .createHmac("sha256", secret)
    .update(`${timestamp}.${rawBody}`)
    .digest("hex");
  return `sha256=${hex}`;
}

/**
 * Attaches X-Correlation-Id to every request & response for cross-service traceability (BR-13).
 */
export function correlationIdMiddleware(req, res, next) {
  const incoming = req.header("X-Correlation-Id");
  const correlationId =
    incoming && incoming.trim() !== "" ? incoming.trim() : crypto.randomUUID();
  req.correlationId = correlationId;
  res.setHeader("X-Correlation-Id", correlationId);
  next();
}

/**
 * Verifies Bearer JWT locally and preserves the raw token for authoritative forwarding to Yii2.
 */
export function requireAuth(req, res, next) {
  const authHeader = req.header("Authorization") || "";
  if (!authHeader.startsWith("Bearer ")) {
    return res.status(401).json({
      success: false,
      status: 401,
      error: "Unauthorized",
      message: "Missing or invalid Authorization Bearer token.",
      correlation_id: req.correlationId,
    });
  }

  const token = authHeader.slice(7).trim();
  const payload = verifyHs256Jwt(token, config.jwtSecret);
  if (!payload) {
    return res.status(401).json({
      success: false,
      status: 401,
      error: "Unauthorized",
      message: "Invalid or expired JWT token.",
      correlation_id: req.correlationId,
    });
  }

  req.authToken = token;
  req.userClaims = payload;
  next();
}

/**
 * Verifies inbound external RIS/PACS/modality webhook HMAC-SHA256 signatures without requiring a user JWT.
 * Required headers:
 *   - X-External-Timestamp: Unix epoch seconds (must be within ±EXTERNAL_WEBHOOK_MAX_SKEW_SEC)
 *   - X-External-Signature: sha256=<hmac_hex_over_"${timestamp}.${rawBody}">
 */
export function requireWebhookSignature(req, res, next) {
  const secret = config.externalWebhook.secret;
  if (!secret) {
    return res.status(503).json({
      success: false,
      status: 503,
      error: "Service Unavailable",
      message: "Inbound external webhook authentication is not configured (EXTERNAL_WEBHOOK_SECRET missing).",
      correlation_id: req.correlationId,
    });
  }

  const timestampRaw = String(req.header("X-External-Timestamp") || "").trim();
  const signatureHeader = String(req.header("X-External-Signature") || "").trim();

  if (!timestampRaw || !signatureHeader) {
    return res.status(401).json({
      success: false,
      status: 401,
      error: "Unauthorized",
      message: "Missing X-External-Timestamp or X-External-Signature header.",
      correlation_id: req.correlationId,
    });
  }

  if (!/^\d+$/.test(timestampRaw)) {
    return res.status(401).json({
      success: false,
      status: 401,
      error: "Unauthorized",
      message: "Invalid X-External-Timestamp format. Expected Unix epoch seconds.",
      correlation_id: req.correlationId,
    });
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const tsNum = Number(timestampRaw);
  if (Math.abs(nowSec - tsNum) > config.externalWebhook.maxSkewSec) {
    return res.status(401).json({
      success: false,
      status: 401,
      error: "Unauthorized",
      message: `Webhook timestamp expired or outside allowed replay window (±${config.externalWebhook.maxSkewSec}s).`,
      correlation_id: req.correlationId,
    });
  }

  if (!signatureHeader.startsWith("sha256=")) {
    return res.status(401).json({
      success: false,
      status: 401,
      error: "Unauthorized",
      message: "Invalid X-External-Signature format. Expected sha256=<hex>.",
      correlation_id: req.correlationId,
    });
  }

  const rawBody = typeof req.rawBody === "string" ? req.rawBody : JSON.stringify(req.body || {});
  const expectedHeader = computeHmacSignature(secret, timestampRaw, rawBody);

  const expectedBuf = Buffer.from(expectedHeader, "utf8");
  const actualBuf = Buffer.from(signatureHeader, "utf8");
  if (expectedBuf.length !== actualBuf.length || !crypto.timingSafeEqual(expectedBuf, actualBuf)) {
    return res.status(401).json({
      success: false,
      status: 401,
      error: "Unauthorized",
      message: "Invalid X-External-Signature.",
      correlation_id: req.correlationId,
    });
  }

  req.webhookAuth = {
    verified: true,
    timestamp: tsNum,
    event_id:
      String(req.header("X-External-Event-Id") || req.header("Idempotency-Key") || "").trim() ||
      null,
  };
  return next();
}
