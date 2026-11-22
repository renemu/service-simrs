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
};
