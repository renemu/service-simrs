import express from "express";
import { callYiiApi } from "../lib/yiiClient.js";
import { requireAuth } from "../middleware/auth.js";
import { validateReportQuery } from "../middleware/validate.js";

const router = express.Router();

function extractReportParams(query) {
  const {
    period_mode,
    date,
    month,
    year,
    from,
    to,
    report_type,
    department_id,
    doctor_id,
    visit_status,
    payment_status,
    payment_method,
    modality_type,
    gender,
    page,
    per_page,
  } = query;

  return {
    period_mode,
    date,
    month,
    year,
    from,
    to,
    report_type,
    department_id,
    doctor_id,
    visit_status,
    payment_status,
    payment_method,
    modality_type,
    gender,
    page,
    per_page,
  };
}

/**
 * GET /node-api/reports/summary
 * Standard SIMRS Report Aggregations (Overall, RL 5.2 Visits, RL 5.4 Morbidity,
 * Procedures, Pharmacy, Laboratory/Modality, Finance) with Day/Month/Range/Year filters.
 */
router.get("/summary", requireAuth, validateReportQuery, async (req, res, next) => {
  try {
    const yiiRes = await callYiiApi("/api/reports/summary", {
      method: "GET",
      token: req.authToken,
      params: extractReportParams(req.query),
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
      source: "node-report-service",
      correlation_id: req.correlationId,
      generated_at: new Date().toISOString(),
      data: yiiRes.data?.data,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /node-api/reports/details
 * Paginated drill-down rows for the selected SIMRS report type and filters.
 */
router.get("/details", requireAuth, validateReportQuery, async (req, res, next) => {
  try {
    const yiiRes = await callYiiApi("/api/reports/details", {
      method: "GET",
      token: req.authToken,
      params: extractReportParams(req.query),
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
      source: "node-report-service",
      correlation_id: req.correlationId,
      generated_at: new Date().toISOString(),
      data: yiiRes.data?.data || [],
      meta: yiiRes.data?.meta || null,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
