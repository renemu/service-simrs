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
