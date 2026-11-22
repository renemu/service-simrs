import cors from "cors";
import express from "express";
import { config } from "./config/env.js";
import { callYiiApi } from "./lib/yiiClient.js";
import { correlationIdMiddleware } from "./middleware/auth.js";
import dashboardRoutes from "./routes/dashboard.routes.js";
import labRoutes from "./routes/lab.routes.js";

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
    ],
  })
);
app.use(express.json({ limit: "1mb" }));
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
    version: "1.0.0",
    environment: config.nodeEnv,
    status: "online",
    yii2_upstream: yiiStatus,
    correlation_id: req.correlationId,
    server_time: new Date().toISOString(),
  });
});

// Supporting Services Routes (FR-10)
app.use("/node-api/lab", labRoutes);
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
  const status = err?.statusCode || 500;
  res.status(status).json({
    success: false,
    status,
    error: err?.errorLabel || "Internal Server Error",
    message:
      config.nodeEnv === "production" && status >= 500
        ? "An internal service error occurred."
        : err?.message || "An internal service error occurred.",
    correlation_id: req.correlationId,
  });
});

app.listen(config.port, () => {
  console.log(
    `[simrs-backend-node] Supporting Services listening on http://localhost:${config.port} (Yii2 upstream: ${config.yiiApiUrl})`
  );
});
