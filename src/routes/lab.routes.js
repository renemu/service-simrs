import express from "express";
import { callYiiApi } from "../lib/yiiClient.js";
import { requireAuth } from "../middleware/auth.js";

const router = express.Router();

// In-memory reconciliation log for external lab dispatch simulation (assessment demo boundary)
const dispatchAuditLog = new Map();

/**
 * GET /node-api/lab/orders
 * Lists lab orders via authoritative Yii2 API and attaches Node.js integration status metadata.
 */
router.get("/orders", requireAuth, async (req, res, next) => {
  try {
    const { status, search, page, per_page } = req.query;
    const result = await callYiiApi("/api/lab-orders", {
      method: "GET",
      token: req.authToken,
      params: { status, search, page, per_page },
      correlationId: req.correlationId,
    });

    if (!result.ok) {
      return res.status(result.status).json({
        ...result.data,
        correlation_id: req.correlationId,
      });
    }

    const enriched = (result.data?.data || []).map((order) => ({
      ...order,
      external_dispatch: dispatchAuditLog.get(String(order.id)) || null,
    }));

    return res.json({
      success: true,
      source: "node-lab-integration-service",
      correlation_id: req.correlationId,
      data: enriched,
      meta: result.data?.meta,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /node-api/lab/orders/:id/dispatch
 * Simulates dispatching a lab order to an external LIS/analyzer with timeout & failure handling (FR-06.05, BR-13).
 * Query: ?simulate_failure=timeout|error (for testing integration failure handling)
 */
router.post("/orders/:id/dispatch", requireAuth, async (req, res, next) => {
  try {
    const orderId = Number(req.params.id);
    if (!Number.isInteger(orderId) || orderId <= 0) {
      return res.status(422).json({
        success: false,
        status: 422,
        error: "Unprocessable Entity",
        message: "Valid numeric lab order ID is required.",
        correlation_id: req.correlationId,
      });
    }

    // Verify order exists & caller has permission in Yii2 first
    const orderRes = await callYiiApi(`/api/lab-orders/${orderId}`, {
      method: "GET",
      token: req.authToken,
      correlationId: req.correlationId,
    });
    if (!orderRes.ok) {
      return res.status(orderRes.status).json({
        ...orderRes.data,
        correlation_id: req.correlationId,
      });
    }

    // Optional failure simulation to verify BR-13 (never report success when downstream fails)
    const sim = String(req.query.simulate_failure || "").toLowerCase();
    if (sim === "timeout") {
      const record = {
        order_id: orderId,
        status: "failed_timeout",
        correlation_id: req.correlationId,
        attempted_at: new Date().toISOString(),
      };
      dispatchAuditLog.set(String(orderId), record);
      return res.status(504).json({
        success: false,
        status: 504,
        error: "Gateway Timeout",
        message: "Simulated external laboratory vendor timeout. Order kept for reconciliation.",
        correlation_id: req.correlationId,
        data: record,
      });
    }
    if (sim === "error") {
      const record = {
        order_id: orderId,
        status: "failed_downstream",
        correlation_id: req.correlationId,
        attempted_at: new Date().toISOString(),
      };
      dispatchAuditLog.set(String(orderId), record);
      return res.status(502).json({
        success: false,
        status: 502,
        error: "Bad Gateway",
        message: "Simulated external laboratory vendor 500 error. Reconciliation required.",
        correlation_id: req.correlationId,
        data: record,
      });
    }

    const record = {
      order_id: orderId,
      order_number: orderRes.data?.data?.order_number,
      external_ref: `EXT-LIS-${Date.now()}`,
      status: "dispatched",
      correlation_id: req.correlationId,
      dispatched_at: new Date().toISOString(),
    };
    dispatchAuditLog.set(String(orderId), record);

    return res.status(200).json({
      success: true,
      message: "Lab order dispatched to external laboratory integration gateway.",
      correlation_id: req.correlationId,
      data: record,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /node-api/lab/results/callback
 * Receives external laboratory result payload, validates schema, and forwards authoritative write to Yii2.
 * Body: { lab_order_id, result_summary, reference_notes?, result_details? }
 */
router.post("/results/callback", requireAuth, async (req, res, next) => {
  try {
    const { lab_order_id, result_summary, reference_notes, result_details } = req.body || {};
    const orderId = Number(lab_order_id);

    const errors = {};
    if (!Number.isInteger(orderId) || orderId <= 0) {
      errors.lab_order_id = ["Valid lab_order_id is required."];
    }
    if (typeof result_summary !== "string" || result_summary.trim() === "") {
      errors.result_summary = ["result_summary is required."];
    }
    if (Object.keys(errors).length > 0) {
      return res.status(422).json({
        success: false,
        status: 422,
        error: "Unprocessable Entity",
        message: "Validation failed.",
        errors,
        correlation_id: req.correlationId,
      });
    }

    const yiiRes = await callYiiApi(`/api/lab-orders/${orderId}/result`, {
      method: "POST",
      token: req.authToken,
      body: {
        result_summary: result_summary.trim(),
        reference_notes: reference_notes ? String(reference_notes).trim() : null,
        result_details: result_details ?? null,
      },
      correlationId: req.correlationId,
      idempotencyKey: req.header("Idempotency-Key") || undefined,
    });

    if (!yiiRes.ok) {
      return res.status(yiiRes.status).json({
        ...yiiRes.data,
        correlation_id: req.correlationId,
      });
    }

    return res.status(200).json({
      success: true,
      message: "Laboratory result callback validated and persisted to Yii2 core backend.",
      source: "node-lab-integration-service",
      correlation_id: req.correlationId,
      data: yiiRes.data?.data,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
