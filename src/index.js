import cors from "cors";
import express from "express";
import { config } from "./config/env.js";
import { listModalities } from "./lib/modalityGateway.js";
import { callYiiApi } from "./lib/yiiClient.js";
import { correlationIdMiddleware } from "./middleware/auth.js";
import dashboardRoutes from "./routes/dashboard.routes.js";
import labRoutes from "./routes/lab.routes.js";
import modalityRoutes from "./routes/modality.routes.js";
import webhookRoutes from "./routes/webhook.routes.js";

const app = express();

app.use(
  cors({
    origin(origin, callback) {
      if (!origin || config.corsAllowedOrigins.includes("*") || config.corsAllowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      return callback(new Error("Origin not allowed by CORS"));
    },
    credentials: true,
    allowedHeaders: [
      "Origin",
      "X-Requested-With",
      "Content-Type",
      "Accept",
      "Authorization",
      "Idempotency-Key",
      "X-Correlation-Id",
      "X-External-Signature",
      "X-External-Timestamp",
      "X-External-Event-Id",
    ],
  })
);
app.use(
  express.json({
    limit: "1mb",
    verify(req, _res, buf) {
      // Preserve exact raw UTF-8 payload bytes for HMAC-SHA256 webhook signature verification
      req.rawBody = buf.toString("utf8");
    },
  })
);
app.use(correlationIdMiddleware);

// Root & Health check
app.get(["/", "/health"], async (req, res) => {
  let yiiStatus = "unreachable";
  try {
    const check = await callYiiApi("/", {
      method: "GET",
      correlationId: req.correlationId,
      timeoutMs: 2500,
    });
    yiiStatus = check.ok ? "online" : `http_${check.status}`;
  } catch {
    yiiStatus = "unreachable";
  }

  return res.json({
    success: true,
    service: "simrs-backend-node",
    version: "1.2.0",
    environment: config.nodeEnv,
    status: "online",
    yii2_upstream: yiiStatus,
    external_modality_gateway: {
      mode: config.externalModality.mode,
      inbound_webhook_enabled: Boolean(config.externalWebhook.secret && config.internalService.secret),
      supported_modalities: listModalities().map((m) => ({
        modality: m.modality,
        code: m.code,
        mode: m.mode,
        status: m.status,
      })),
    },
    correlation_id: req.correlationId,
    server_time: new Date().toISOString(),
  });
});

// Supporting Services Routes (FR-06.05, FR-08, FR-10)
app.use("/node-api/lab", labRoutes);
app.use("/node-api/modalities", modalityRoutes);
app.use("/node-api/webhooks", webhookRoutes);
app.use("/node-api/dashboard", dashboardRoutes);

// 404 Handler
app.use((req, res) => {
  res.status(404).json({
    success: false,
    status: 404,
    error: "Not Found",
    message: `Route ${req.method} ${req.originalUrl} not found.`,
    correlation_id: req.correlationId,
  });
});

// Global Error Handler
app.use((err, req, res, _next) => {
  if (err instanceof SyntaxError && err.status === 400 && "body" in err) {
    return res.status(400).json({
      success: false,
      status: 400,
      error: "Bad Request",
      message: "Invalid JSON payload.",
      correlation_id: req.correlationId,
    });
  }

  if (err?.message === "Origin not allowed by CORS") {
    return res.status(403).json({
      success: false,
      status: 403,
      error: "Forbidden",
      message: err.message,
      correlation_id: req.correlationId,
    });
  }

  const status = err?.statusCode || err?.status || 500;
  return res.status(status).json({
    success: false,
    status,
    error: err?.errorLabel || (status < 500 ? "Request Error" : "Internal Server Error"),
    message:
      config.nodeEnv === "production" && status >= 500
        ? "An internal service error occurred."
        : err?.message || "An internal service error occurred.",
    correlation_id: req.correlationId,
  });
});

app.listen(config.port, () => {
  console.log(
    `[simrs-backend-node] Supporting Services & External Modality Gateway (${config.externalModality.mode}) listening on http://localhost:${config.port} (Yii2 upstream: ${config.yiiApiUrl})`
  );
});
