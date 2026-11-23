import express from "express";
import { callYiiApi } from "../lib/yiiClient.js";
import { requireAuth } from "../middleware/auth.js";
import { validateDateRange } from "../middleware/validate.js";

const router = express.Router();

/**
 * GET /node-api/dashboard/summary
 * Query: from, to, department_id
 */
router.get("/summary", requireAuth, validateDateRange, async (req, res, next) => {
  try {
    const { from, to, department_id } = req.query;
    const yiiRes = await callYiiApi("/api/dashboard/metrics", {
      method: "GET",
      token: req.authToken,
      params: { from, to, department_id },
      correlationId: req.correlationId,
    });

    if (!yiiRes.ok) {
      return res.status(yiiRes.status).json({
        ...yiiRes.data,
        correlation_id: req.correlationId,
      });
    }

    return res.json({
      success: true,
      source: "node-dashboard-service",
      correlation_id: req.correlationId,
      generated_at: new Date().toISOString(),
      data: yiiRes.data?.data,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /node-api/dashboard/visits-by-department
 */
router.get("/visits-by-department", requireAuth, validateDateRange, async (req, res, next) => {
  try {
    const { from, to } = req.query;
    const yiiRes = await callYiiApi("/api/dashboard/metrics", {
      method: "GET",
      token: req.authToken,
      params: { from, to },
      correlationId: req.correlationId,
    });

    if (!yiiRes.ok) {
      return res.status(yiiRes.status).json({
        ...yiiRes.data,
        correlation_id: req.correlationId,
      });
    }

    return res.json({
      success: true,
      source: "node-dashboard-service",
      correlation_id: req.correlationId,
      data: yiiRes.data?.data?.visits_by_department || [],
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /node-api/dashboard/medicine-usage
 */
router.get("/medicine-usage", requireAuth, validateDateRange, async (req, res, next) => {
  try {
    const { from, to } = req.query;
    const yiiRes = await callYiiApi("/api/dashboard/metrics", {
      method: "GET",
      token: req.authToken,
      params: { from, to },
      correlationId: req.correlationId,
    });

    if (!yiiRes.ok) {
      return res.status(yiiRes.status).json({
        ...yiiRes.data,
        correlation_id: req.correlationId,
      });
    }

    return res.json({
      success: true,
      source: "node-dashboard-service",
      correlation_id: req.correlationId,
      data: yiiRes.data?.data?.medicine_usage || { total_dispensed_units: 0, top_medicines: [] },
    });
  } catch (err) {
    next(err);
  }
});

export default router;
