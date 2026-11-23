import { config } from "../config/env.js";
import { computeHmacSignature } from "../middleware/auth.js";

/**
 * Builds candidate upstream base URLs so local development works seamlessly whether
 * Yii2 (`./yii serve` / `php -S`) binds on localhost, IPv4 127.0.0.1, or IPv6 [::1].
 */
function buildCandidateBaseUrls(primaryBaseUrl) {
  const candidates = [primaryBaseUrl];
  try {
    const parsed = new URL(primaryBaseUrl);
    if (["localhost", "127.0.0.1", "[::1]", "::1"].includes(parsed.hostname)) {
      const altHosts = ["localhost", "127.0.0.1", "[::1]"];
      for (const host of altHosts) {
        const alt = `${parsed.protocol}//${host}${parsed.port ? `:${parsed.port}` : ""}`;
        if (!candidates.includes(alt)) {
          candidates.push(alt);
        }
      }
    }
  } catch {
    // Keep primary URL only
  }
  return candidates;
}

async function fetchWithTimeout(url, fetchOptions, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...fetchOptions, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * HTTP client for communicating with the authoritative Yii2 core backend.
 * Enforces explicit timeout, X-Correlation-Id propagation, and truthful error propagation (BR-13).
 */
export async function callYiiApi(endpoint, options = {}) {
  const {
    method = "GET",
    token = null,
    serviceAuth = false,
    body = undefined,
    params = null,
    correlationId = null,
    idempotencyKey = null,
    timeoutMs = config.yiiTimeoutMs,
  } = options;

  let pathAndQuery = endpoint.startsWith("/") ? endpoint : `/${endpoint}`;
  if (params && typeof params === "object") {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== "") {
        qs.append(k, String(v));
      }
    }
    const queryStr = qs.toString();
    if (queryStr) {
      pathAndQuery += `${pathAndQuery.includes("?") ? "&" : "?"}${queryStr}`;
    }
  }

  const serializedBody = body !== undefined ? JSON.stringify(body) : undefined;

  const headers = {
    Accept: "application/json",
  };
  if (serializedBody !== undefined) {
    headers["Content-Type"] = "application/json";
  }
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  if (serviceAuth) {
    const svcSecret = config.internalService.secret;
    if (!svcSecret) {
      const cfgErr = new Error(
        "INTERNAL_SERVICE_SECRET is not configured on backend-node for machine-to-machine forwarding."
      );
      cfgErr.statusCode = 503;
      cfgErr.errorLabel = "Service Unavailable";
      throw cfgErr;
    }
    const timestamp = String(Math.floor(Date.now() / 1000));
    headers["X-Service-Name"] = config.internalService.name;
    headers["X-Service-Timestamp"] = timestamp;
    headers["X-Service-Signature"] = computeHmacSignature(
      svcSecret,
      timestamp,
      serializedBody ?? ""
    );
  }
  if (correlationId) {
    headers["X-Correlation-Id"] = correlationId;
  }
  if (idempotencyKey) {
    headers["Idempotency-Key"] = idempotencyKey;
  }

  const fetchOptions = {
    method,
    headers,
    body: serializedBody,
  };

  const baseCandidates = buildCandidateBaseUrls(config.yiiApiUrl);
  let response = null;
  let lastError = null;

  for (const baseUrl of baseCandidates) {
    const url = `${baseUrl}${pathAndQuery}`;
    try {
      response = await fetchWithTimeout(url, fetchOptions, timeoutMs);
      lastError = null;
      break;
    } catch (err) {
      lastError = err;
      if (err?.name === "AbortError") {
        // Explicit timeout should not blindly retry across hosts
        break;
      }
    }
  }

  if (lastError) {
    if (lastError?.name === "AbortError") {
      const timeoutError = new Error(
        `Downstream Yii2 API timed out after ${timeoutMs}ms (${method} ${endpoint}).`
      );
      timeoutError.statusCode = 504;
      timeoutError.errorLabel = "Gateway Timeout";
      throw timeoutError;
    }
    const causeMsg = lastError?.cause?.code || lastError?.code || lastError?.message || "";
    const networkError = new Error(
      `Failed to connect to downstream Yii2 API (${config.yiiApiUrl})${causeMsg ? ` [${causeMsg}]` : ""}.`
    );
    networkError.statusCode = 502;
    networkError.errorLabel = "Bad Gateway";
    throw networkError;
  }

  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { success: response.ok, message: text };
  }

  return {
    ok: response.ok,
    status: response.status,
    data,
  };
}
