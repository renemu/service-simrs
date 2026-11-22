import express from "express";
import { callYiiApi } from "../lib/yiiClient.js";
import { requireAuth } from "../middleware/auth.js";

const router = express.Router();
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function validateDateRange(req, res) {
  const { from, to } = req.query;
  const errors = {};
  if (from && !DATE_RE.test(String(from))) {
    errors.from = ["from must be in YYYY-MM-DD format."];
  }
  if (to && !DATE_RE.test(String(to))) {
    errors.to = ["to must be in YYYY-MM-DD format."];
  }
  if (from && to && String(from) > String(to)) {
    errors.from = ["from date cannot be after to date."];
  }
  if (Object.keys(errors).length > 0) {
    res.status(422).json({
      success: false,
      status: 422,
      error: "Unprocessable Entity",
      message: "Invalid date filter parameters.",
      errors,
      correlation_id: req.correlationId,
    });
    return false;
  }
  return true;
}

/**
 * GET /node-api/dashboard/summary
 * Query: from, to, department_id
 */
router.get("/summary", requireAuth, async (req, res, next) => {
  try {
    if (!validateDateRange(req, res)) return;

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
router.get("/visits-by-department", requireAuth, async (req, res, next) => {
  try {
    if (!validateDateRange(req, res)) return;
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
router.get("/medicine-usage", requireAuth, async (req, res, next) => {
  try {
    if (!validateDateRange(req, res)) return;
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
