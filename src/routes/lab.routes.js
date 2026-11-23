import express from "express";
import {
  dispatchOrderToModality,
  fetchExternalModalityResult,
  getModalitySpec,
  getTrackedStudyForOrder,
  isSupportedModality,
  normalizeModality,
} from "../lib/modalityGateway.js";
import { callYiiApi } from "../lib/yiiClient.js";
import { requireAuth } from "../middleware/auth.js";
import {
  validateLabOrderIdParam,
  validateLabOrdersQuery,
  validateLabResultCallback,
} from "../middleware/validate.js";

const router = express.Router();

/**
 * Helper: resolves modality for an order (explicit override -> order.modality_type -> lab_clinical).
 */
function resolveOrderModality(order, overrideModality) {
  if (overrideModality) {
    const normalized = normalizeModality(overrideModality);
    if (isSupportedModality(normalized)) return normalized;
  }
  const orderMod = normalizeModality(order?.modality_type);
  if (isSupportedModality(orderMod)) return orderMod;
  return "lab_clinical";
}

/**
 * Helper: shared dispatch handler that sends a lab/imaging order to the external modality gateway
 * and persists authoritative dispatch/failure status to Yii2 (`PATCH /api/lab-orders/:id/integration`).
 */
async function executeLabOrderDispatch(req, res, { forcedModality = null } = {}) {
  const orderId = req.validatedOrderId;
  const body = req.body || {};

  // 1. Verify order exists & caller has RBAC permission in Yii2
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

  const order = orderRes.data?.data;
  if (order?.status === "cancelled") {
    return res.status(409).json({
      success: false,
      status: 409,
      error: "Conflict",
      message: "Cannot dispatch a cancelled laboratory order.",
      correlation_id: req.correlationId,
    });
  }

  const modality = forcedModality || resolveOrderModality(order, body.modality_type);
  const spec = getModalitySpec(modality);

  // If using the dedicated CT-Scan route, reject mismatched non-CT orders unless explicitly allowed
  if (
    forcedModality === "ct_scan" &&
    order.modality_type &&
    order.modality_type !== "ct_scan" &&
    order.modality_type !== "other"
  ) {
    return res.status(422).json({
      success: false,
      status: 422,
      error: "Unprocessable Entity",
      message: `Order ${order.order_number} has modality "${order.modality_type}", not "ct_scan". Use /node-api/lab/orders/${orderId}/dispatch instead.`,
      correlation_id: req.correlationId,
    });
  }

  try {
    const dispatchRecord = await dispatchOrderToModality(modality, order, {
      bodyPart: body.body_part ?? order.body_part ?? spec.default_body_part,
      contrastUsed: body.contrast_used !== undefined ? Boolean(body.contrast_used) : Boolean(order.contrast_used),
      protocol: body.protocol || null,
      sliceThicknessMm: body.slice_thickness_mm ? Number(body.slice_thickness_mm) : undefined,
      clinicalIndication: body.clinical_indication || order.notes || null,
      correlationId: req.correlationId,
      idempotencyKey: req.header("Idempotency-Key") || undefined,
      simulateFailure: req.query.simulate_failure,
    });

    // Persist authoritative integration state to Yii2 PostgreSQL
    const yiiSync = await callYiiApi(`/api/lab-orders/${orderId}/integration`, {
      method: "PATCH",
      token: req.authToken,
      body: {
        modality_type: modality,
        body_part: dispatchRecord.body_part,
        contrast_used: dispatchRecord.contrast_used,
        integration_status: "dispatched",
        external_system: dispatchRecord.external_system,
        external_reference_id: dispatchRecord.external_reference_id,
        correlation_id: req.correlationId,
        dispatched_at: dispatchRecord.dispatched_at,
      },
      correlationId: req.correlationId,
    });

    if (!yiiSync.ok) {
      return res.status(yiiSync.status).json({
        ...yiiSync.data,
        correlation_id: req.correlationId,
      });
    }

    return res.status(200).json({
      success: true,
      message: `Order ${order.order_number} dispatched to ${spec.name} (${dispatchRecord.mode} gateway).`,
      source: "node-lab-integration-service",
      correlation_id: req.correlationId,
      data: {
        ...dispatchRecord,
        external_ref: dispatchRecord.external_reference_id,
        order: yiiSync.data?.data,
      },
    });
  } catch (gwErr) {
    // BR-13: Persist failure state for reconciliation and return truthful 502/503/504
    const failedSync = await callYiiApi(`/api/lab-orders/${orderId}/integration`, {
      method: "PATCH",
      token: req.authToken,
      body: {
        modality_type: modality,
        integration_status: "failed",
        external_system: spec.external_system,
        correlation_id: req.correlationId,
        integration_error: gwErr.message,
      },
      correlationId: req.correlationId,
    }).catch(() => null);

    const status = gwErr.statusCode || 502;
    return res.status(status).json({
      success: false,
      status,
      error: gwErr.errorLabel || "Bad Gateway",
      message: gwErr.message,
      correlation_id: req.correlationId,
      data: {
        order_id: orderId,
        modality_type: modality,
        external_system: spec.external_system,
        status: status === 504 ? "failed_timeout" : "failed_downstream",
        integration_status: "failed",
        correlation_id: req.correlationId,
        attempted_at: new Date().toISOString(),
        order: failedSync?.data?.data || null,
      },
    });
  }
}

/**
 * Helper: pulls external result from the modality gateway (dummy/live) and persists authoritatively to Yii2.
 */
async function executeExternalResultSync(req, res, { forcedModality = null } = {}) {
  const orderId = req.validatedOrderId;
  const body = req.body || {};

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

  const order = orderRes.data?.data;
  if (order?.status === "cancelled") {
    return res.status(409).json({
      success: false,
      status: 409,
      error: "Conflict",
      message: "Cannot sync external result for a cancelled laboratory order.",
      correlation_id: req.correlationId,
    });
  }

  const modality = forcedModality || resolveOrderModality(order, body.modality_type);
  const spec = getModalitySpec(modality);

  if (
    forcedModality === "ct_scan" &&
    order.modality_type &&
    order.modality_type !== "ct_scan" &&
    order.modality_type !== "other"
  ) {
    return res.status(422).json({
      success: false,
      status: 422,
      error: "Unprocessable Entity",
      message: `Order ${order.order_number} has modality "${order.modality_type}", not "ct_scan".`,
      correlation_id: req.correlationId,
    });
  }

  try {
    const externalResult = await fetchExternalModalityResult(modality, order, {
      simulateFailure: req.query.simulate_failure,
      correlationId: req.correlationId,
      resultSummary: body.result_summary || null,
      referenceNotes: body.reference_notes || null,
      bodyPart: body.body_part || null,
      contrastUsed: body.contrast_used !== undefined ? Boolean(body.contrast_used) : undefined,
    });

    const yiiRes = await callYiiApi(`/api/lab-orders/${orderId}/result`, {
      method: "POST",
      token: req.authToken,
      body: {
        ...externalResult,
        correlation_id: req.correlationId,
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
      message: `Hasil eksternal ${spec.name} untuk order ${order.order_number} berhasil disinkronkan ke SIMRS.`,
      source: "node-lab-integration-service",
      correlation_id: req.correlationId,
      data: yiiRes.data?.data,
    });
  } catch (gwErr) {
    await callYiiApi(`/api/lab-orders/${orderId}/integration`, {
      method: "PATCH",
      token: req.authToken,
      body: {
        modality_type: modality,
        integration_status: "failed",
        external_system: spec.external_system,
        correlation_id: req.correlationId,
        integration_error: gwErr.message,
      },
      correlationId: req.correlationId,
    }).catch(() => null);

    const status = gwErr.statusCode || 502;
    return res.status(status).json({
      success: false,
      status,
      error: gwErr.errorLabel || "Bad Gateway",
      message: gwErr.message,
      correlation_id: req.correlationId,
    });
  }
}

/**
 * GET /node-api/lab/orders
 * Lists lab & diagnostic orders via authoritative Yii2 API and attaches Node.js gateway telemetry.
 */
router.get("/orders", requireAuth, validateLabOrdersQuery, async (req, res, next) => {
  try {
    const { status, modality_type, integration_status, search, page, per_page } = req.query;
    const result = await callYiiApi("/api/lab-orders", {
      method: "GET",
      token: req.authToken,
      params: { status, modality_type, integration_status, search, page, per_page },
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
      external_dispatch: getTrackedStudyForOrder(order.id) || (order.external_reference_id
        ? {
            order_id: order.id,
            modality_type: order.modality_type,
            external_system: order.external_system,
            external_reference_id: order.external_reference_id,
            status: order.integration_status,
            dispatched_at: order.dispatched_at,
            last_synced_at: order.last_synced_at,
          }
        : null),
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
 * Dispatches any lab/diagnostic order to its matching external modality gateway (CT-Scan, X-Ray, MRI, USG, EKG, LIS).
 * Query: ?simulate_failure=timeout|error|device_offline
 */
router.post("/orders/:id/dispatch", requireAuth, validateLabOrderIdParam, async (req, res, next) => {
  try {
    return await executeLabOrderDispatch(req, res);
  } catch (err) {
    next(err);
  }
});

/**
 * POST /node-api/lab/orders/:id/ct-scan/dispatch
 * Dedicated CT-Scan external integration dispatch in the Laboratory module (FR-06.05).
 * Body: { body_part?, contrast_used?, protocol?, slice_thickness_mm?, clinical_indication? }
 * Query: ?simulate_failure=timeout|error|device_offline
 */
router.post("/orders/:id/ct-scan/dispatch", requireAuth, validateLabOrderIdParam, async (req, res, next) => {
  try {
    return await executeLabOrderDispatch(req, res, { forcedModality: "ct_scan" });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /node-api/lab/orders/:id/external-status
 * Queries external modality gateway tracking status for a lab/CT-Scan order.
 */
router.get("/orders/:id/external-status", requireAuth, validateLabOrderIdParam, async (req, res, next) => {
  try {
    const orderId = req.validatedOrderId;
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

    const order = orderRes.data?.data;
    const modality = resolveOrderModality(order);
    const spec = getModalitySpec(modality);
    const tracked = getTrackedStudyForOrder(orderId);

    return res.json({
      success: true,
      source: "node-lab-integration-service",
      correlation_id: req.correlationId,
      data: {
        order_id: order.id,
        order_number: order.order_number,
        modality_type: order.modality_type,
        order_status: order.status,
        integration_status: order.integration_status,
        external_system: order.external_system || spec?.external_system || null,
        external_reference_id: order.external_reference_id || tracked?.external_reference_id || null,
        dispatched_at: order.dispatched_at,
        last_synced_at: order.last_synced_at,
        integration_error: order.integration_error,
        gateway_telemetry: tracked,
      },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /node-api/lab/orders/:id/ct-scan/sync-result
 * Dedicated CT-Scan external result sync for the Laboratory module.
 * Fetches completed CT-Scan report (DICOM metadata, radiation dose, findings, impression) from the
 * external CT-Scan gateway (dummy/live) and persists authoritatively to Yii2.
 */
router.post("/orders/:id/ct-scan/sync-result", requireAuth, validateLabOrderIdParam, async (req, res, next) => {
  try {
    return await executeExternalResultSync(req, res, { forcedModality: "ct_scan" });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /node-api/lab/orders/:id/sync-external-result
 * Generic external modality result sync (CT-Scan, X-Ray, MRI, USG, EKG, LIS) -> authoritative Yii2 write.
 */
router.post("/orders/:id/sync-external-result", requireAuth, validateLabOrderIdParam, async (req, res, next) => {
  try {
    return await executeExternalResultSync(req, res);
  } catch (err) {
    next(err);
  }
});

/**
 * POST /node-api/lab/results/callback
 * Receives external laboratory or imaging/CT-Scan result webhook payload, validates schema,
 * and forwards authoritative write to Yii2.
 */
router.post("/results/callback", requireAuth, validateLabResultCallback, async (req, res, next) => {
  try {
    const {
      orderId,
      result_summary,
      reference_notes,
      result_details,
      result_source,
      external_study_uid,
      modality_device,
      external_completed_at,
      external_reference_id,
      external_system,
    } = req.validatedLabResult;

    const yiiRes = await callYiiApi(`/api/lab-orders/${orderId}/result`, {
      method: "POST",
      token: req.authToken,
      body: {
        result_summary,
        reference_notes,
        result_details,
        result_source,
        external_study_uid,
        modality_device,
        external_completed_at,
        external_reference_id,
        external_system,
        correlation_id: req.correlationId,
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
      message: "External laboratory/modality result callback validated and persisted to Yii2 core backend.",
      source: "node-lab-integration-service",
      correlation_id: req.correlationId,
      data: yiiRes.data?.data,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
