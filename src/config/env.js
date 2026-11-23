import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.resolve(__dirname, "../../.env");

if (fs.existsSync(envPath)) {
  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eqIdx = line.indexOf("=");
    if (eqIdx === -1) continue;
    const key = line.slice(0, eqIdx).trim();
    let val = line.slice(eqIdx + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) {
      process.env[key] = val;
    }
  }
}

const cleanUrl = (val) => (val ? String(val).trim().replace(/\/+$/, "") : "");

export const config = {
  port: Number(process.env.PORT || 3001),
  nodeEnv: process.env.NODE_ENV || "development",
  yiiApiUrl: (process.env.YII_API_URL || "http://localhost:8080").replace(/\/+$/, ""),
  yiiTimeoutMs: Number(process.env.YII_TIMEOUT_MS || 5000),
  jwtSecret: process.env.JWT_SECRET || "",
  corsAllowedOrigins: (
    process.env.CORS_ALLOWED_ORIGINS ||
    "http://localhost:3000,http://127.0.0.1:3000"
  )
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  externalModality: {
    // "dummy" uses built-in simulated external devices; "live" forwards HTTP calls to configured vendor URLs
    mode: (process.env.EXTERNAL_MODALITY_MODE || "dummy").toLowerCase(),
    timeoutMs: Number(process.env.EXTERNAL_MODALITY_TIMEOUT_MS || 5000),
    endpoints: {
      ct_scan: cleanUrl(process.env.EXTERNAL_CT_SCAN_URL),
      xray: cleanUrl(process.env.EXTERNAL_XRAY_URL),
      mri: cleanUrl(process.env.EXTERNAL_MRI_URL),
      usg: cleanUrl(process.env.EXTERNAL_USG_URL),
      ekg: cleanUrl(process.env.EXTERNAL_EKG_URL),
      lab_clinical: cleanUrl(process.env.EXTERNAL_LIS_URL),
    },
  },
  externalWebhook: {
    secret: (process.env.EXTERNAL_WEBHOOK_SECRET || "").trim(),
    maxSkewSec: Math.max(30, Number(process.env.EXTERNAL_WEBHOOK_MAX_SKEW_SEC || 300)),
  },
  internalService: {
    name: "simrs-backend-node",
    secret: (process.env.INTERNAL_SERVICE_SECRET || "").trim(),
  },
};
