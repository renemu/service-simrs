import express from "express";
import {
  checkModalityHealth,
  dispatchOrderToModality,
  fetchExternalModalityResult,
  getModalitySpec,
  getTrackedStudyByRef,
  listModalities,
} from "../lib/modalityGateway.js";
import { callYiiApi } from "../lib/yiiClient.js";
import { requireAuth } from "../middleware/auth.js";
import {
  validateModalityDispatchBody,
  validateModalityParam,
  validateModalitySyncBody,
} from "../middleware/validate.js";

const router = express.Router();

/**
 * Helper: persists external integration status back to authoritative Yii2 backend.
 */
async function syncIntegrationStateToYii(orderId, payload, req) {
  return callYiiApi(`/api/lab-orders/${orderId}/integration`, {
    method: "PATCH",
    token: req.authToken,
    body: payload,
    correlationId: req.correlationId,
  });
}

/**
 * GET /node-api/modalities
 * Lists all configured external mechanical/imaging modality gateways (CT-Scan, X-Ray, MRI, USG, EKG, LIS).
 */
router.get("/", requireAuth, (_req, res) => {
  return res.json({
    success: true,
    source: "node-external-modality-gateway",
    data: listModalities(),
  });
});

/**
 * GET /node-api/modalities/:modality/health
 * Checks health/connectivity of an external modality device gateway (supports ?simulate_failure=timeout|error|device_offline).
 */
router.get("/:modality/health", requireAuth, validateModalityParam, async (req, res, next) => {
  try {
    const health = await checkModalityHealth(req.validatedModality, {
      simulateFailure: req.query.simulate_failure,
      correlationId: req.correlationId,
    });
    return res.json({
      success: true,
      source: "node-external-modality-gateway",
      correlation_id: req.correlationId,
      data: health,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /node-api/modalities/:modality/dispatch
 * Dispatches a SIMRS LabOrder to the target external modality gateway (CT-Scan, X-Ray, MRI, USG, EKG, LIS)
 * and persists integration status authoritatively in Yii2.
 */
router.post(
  "/:modality/dispatch",
  requireAuth,
  validateModalityParam,
  validateModalityDispatchBody,
  async (req, res, next) => {
    try {
      const modality = req.validatedModality;
      const spec = getModalitySpec(modality);
      const { orderId, body_part, contrast_used, protocol, slice_thickness_mm, clinical_indication } =
        req.validatedDispatch;

      // 1. Authoritative check in Yii2 (verifies order exists, RBAC permission, and active session_version)
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
          message: "Cannot dispatch a cancelled laboratory/diagnostic order.",
          correlation_id: req.correlationId,
        });
      }

      // 2. Dispatch to external modality gateway (dummy or live)
      try {
        const dispatchRecord = await dispatchOrderToModality(modality, order, {
          bodyPart: body_part ?? order.body_part ?? spec.default_body_part,
          contrastUsed: contrast_used ?? order.contrast_used ?? false,
          protocol,
          sliceThicknessMm: slice_thickness_mm,
          clinicalIndication: clinical_indication ?? order.notes,
          correlationId: req.correlationId,
          idempotencyKey: req.header("Idempotency-Key") || undefined,
          simulateFailure: req.query.simulate_failure,
        });

        // 3. Persist authoritative dispatch metadata to Yii2 PostgreSQL
        const yiiSync = await syncIntegrationStateToYii(
          orderId,
          {
            modality_type: modality,
            body_part: dispatchRecord.body_part,
            contrast_used: dispatchRecord.contrast_used,
            integration_status: "dispatched",
            external_system: dispatchRecord.external_system,
            external_reference_id: dispatchRecord.external_reference_id,
            correlation_id: req.correlationId,
            dispatched_at: dispatchRecord.dispatched_at,
          },
          req
        );

        if (!yiiSync.ok) {
          return res.status(yiiSync.status).json({
            ...yiiSync.data,
            correlation_id: req.correlationId,
          });
        }

        return res.status(200).json({
          success: true,
          message: `Order ${order.order_number} dispatched to ${spec.name} (${dispatchRecord.mode} mode).`,
          source: "node-external-modality-gateway",
          correlation_id: req.correlationId,
          data: {
            gateway_dispatch: dispatchRecord,
            order: yiiSync.data?.data,
          },
        });
      } catch (gwErr) {
        // BR-13: Record downstream failure in Yii2 for reconciliation and NEVER return fake success
        const failedSync = await syncIntegrationStateToYii(
          orderId,
          {
            modality_type: modality,
            integration_status: "failed",
            external_system: spec.external_system,
            correlation_id: req.correlationId,
            integration_error: gwErr.message,
          },
          req
        ).catch(() => null);

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
            integration_status: "failed",
            reconciliation_recorded: Boolean(failedSync?.ok),
            order: failedSync?.data?.data || null,
          },
        });
      }
    } catch (err) {
      next(err);
    }
  }
);

/**
 * GET /node-api/modalities/:modality/studies/:externalRef
 * Inspects external modality study status by external reference / accession number.
 */
router.get("/:modality/studies/:externalRef", requireAuth, validateModalityParam, (req, res) => {
  const ref = String(req.params.externalRef || "").trim();
  const study = getTrackedStudyByRef(ref);
  if (!study || study.modality_type !== req.validatedModality) {
    return res.status(404).json({
      success: false,
      status: 404,
      error: "Not Found",
      message: `External ${req.validatedModality} study with reference "${ref}" not found in gateway cache.`,
      correlation_id: req.correlationId,
    });
  }

  return res.json({
    success: true,
    source: "node-external-modality-gateway",
    correlation_id: req.correlationId,
    data: study,
  });
});

/**
 * POST /node-api/modalities/:modality/results/sync
 * Pulls diagnostic result from the external modality gateway (dummy or live)
 * and persists authoritatively into Yii2 `lab_results` + marks `integration_status = synced`.
 */
router.post(
  "/:modality/results/sync",
  requireAuth,
  validateModalityParam,
  validateModalitySyncBody,
  async (req, res, next) => {
    try {
      const modality = req.validatedModality;
      const spec = getModalitySpec(modality);
      const { orderId, result_summary, reference_notes, body_part, contrast_used } =
        req.validatedModalitySync;

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
          message: "Cannot sync external result for a cancelled order.",
          correlation_id: req.correlationId,
        });
      }

      try {
        const externalResult = await fetchExternalModalityResult(modality, order, {
          simulateFailure: req.query.simulate_failure,
          correlationId: req.correlationId,
          resultSummary: result_summary,
          referenceNotes: reference_notes,
          bodyPart: body_part,
          contrastUsed: contrast_used,
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
          message: `${spec.name} result synchronized and persisted to Yii2 core backend.`,
          source: "node-external-modality-gateway",
          correlation_id: req.correlationId,
          data: yiiRes.data?.data,
        });
      } catch (gwErr) {
        await syncIntegrationStateToYii(
          orderId,
          {
            modality_type: modality,
            integration_status: "failed",
            external_system: spec.external_system,
            correlation_id: req.correlationId,
            integration_error: gwErr.message,
          },
          req
        ).catch(() => null);

        const status = gwErr.statusCode || 502;
        return res.status(status).json({
          success: false,
          status,
          error: gwErr.errorLabel || "Bad Gateway",
          message: gwErr.message,
          correlation_id: req.correlationId,
        });
      }
    } catch (err) {
      next(err);
    }
  }
);

export default router;
