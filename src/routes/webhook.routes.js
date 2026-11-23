import crypto from "node:crypto";
import express from "express";
import { config } from "../config/env.js";
import { fetchExternalModalityResult, getModalitySpec } from "../lib/modalityGateway.js";
import { callYiiApi } from "../lib/yiiClient.js";
import { computeHmacSignature, requireAuth, requireWebhookSignature } from "../middleware/auth.js";
import {
  validateInboundWebhookResult,
  validateModalityParam,
  validateModalitySyncBody,
} from "../middleware/validate.js";

const router = express.Router();

// In-memory idempotency cache for webhook event IDs (Yii2 also enforces authoritative replay check in DB)
const processedWebhookEvents = new Map();

/**
 * POST /node-api/webhooks/modalities/:modality/result
 * Asynchronous inbound webhook receiver for external RIS/PACS/CT-Scan/X-Ray/MRI/USG/LIS systems.
 * Does NOT require a user session JWT; authenticated strictly via HMAC-SHA256 (X-External-Signature + X-External-Timestamp).
 * Forwards authoritative write to Yii2 via HMAC-signed machine-to-machine channel (`POST /api/internal/lab-orders/webhook-result`).
 */
router.post(
  "/modalities/:modality/result",
  validateModalityParam,
  requireWebhookSignature,
  validateInboundWebhookResult,
  async (req, res, next) => {
    try {
      const modality = req.validatedModality;
      const spec = getModalitySpec(modality);
      const payload = req.validatedWebhookResult;
      const eventKey = req.webhookAuth?.event_id
        ? `${modality}:${req.webhookAuth.event_id}`
        : null;

      if (eventKey && processedWebhookEvents.has(eventKey)) {
        const cached = processedWebhookEvents.get(eventKey);
        return res.status(200).json({
          success: true,
          idempotent_replay: true,
          webhook_verified: true,
          source: "node-inbound-modality-webhook",
          correlation_id: req.correlationId,
          message: "Inbound webhook event already processed (idempotent replay).",
          data: cached,
        });
      }

      const yiiRes = await callYiiApi("/api/internal/lab-orders/webhook-result", {
        method: "POST",
        serviceAuth: true,
        body: {
          lab_order_id: payload.lab_order_id,
          external_reference_id: payload.external_reference_id,
          order_number: payload.order_number,
          modality_type: modality,
          result_summary: payload.result_summary,
          reference_notes: payload.reference_notes,
          result_details: payload.result_details,
          external_study_uid: payload.external_study_uid,
          modality_device: payload.modality_device || spec?.device_name || null,
          external_completed_at: payload.external_completed_at,
          external_system: payload.external_system || spec?.external_system || null,
          correlation_id: req.correlationId,
        },
        correlationId: req.correlationId,
        idempotencyKey: req.webhookAuth?.event_id || undefined,
      });

      if (!yiiRes.ok) {
        return res.status(yiiRes.status).json({
          ...yiiRes.data,
          correlation_id: req.correlationId,
        });
      }

      if (eventKey) {
        processedWebhookEvents.set(eventKey, yiiRes.data?.data || null);
      }

      return res.status(200).json({
        success: true,
        idempotent_replay: Boolean(yiiRes.data?.idempotent_replay),
        webhook_verified: true,
        source: "node-inbound-modality-webhook",
        correlation_id: req.correlationId,
        message:
          yiiRes.data?.message ||
          `Inbound ${spec?.name || modality} webhook verified via HMAC and persisted to Yii2.`,
        data: yiiRes.data?.data,
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * POST /node-api/webhooks/modalities/:modality/simulate-push
 * Helper endpoint (requires staff Bearer JWT) to simulate an external RIS/PACS device
 * signing a CT-Scan/modality result with HMAC-SHA256 and pushing it asynchronously to the inbound webhook.
 */
router.post(
  "/modalities/:modality/simulate-push",
  requireAuth,
  validateModalityParam,
  validateModalitySyncBody,
  async (req, res, next) => {
    try {
      const secret = config.externalWebhook.secret;
      if (!secret) {
        return res.status(503).json({
          success: false,
          status: 503,
          error: "Service Unavailable",
          message: "EXTERNAL_WEBHOOK_SECRET is not configured on backend-node.",
          correlation_id: req.correlationId,
        });
      }

      const modality = req.validatedModality;
      const { orderId, result_summary, reference_notes, body_part, contrast_used } =
        req.validatedModalitySync;

      // Verify order via caller JWT first
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
      const generated = await fetchExternalModalityResult(modality, order, {
        correlationId: req.correlationId,
        resultSummary: result_summary,
        referenceNotes: reference_notes,
        bodyPart: body_part,
        contrastUsed: contrast_used,
      });

      const webhookBody = {
        lab_order_id: order.id,
        external_reference_id: order.external_reference_id || generated.external_reference_id,
        order_number: order.order_number,
        result_summary: generated.result_summary,
        reference_notes: generated.reference_notes,
        result_details: generated.result_details,
        external_study_uid: generated.external_study_uid,
        modality_device: generated.modality_device,
        external_completed_at: generated.external_completed_at,
        external_system: generated.external_system,
      };

      const rawBody = JSON.stringify(webhookBody);
      const timestamp = String(Math.floor(Date.now() / 1000));
      const signature = computeHmacSignature(secret, timestamp, rawBody);
      const eventId = req.header("Idempotency-Key") || `evt-${modality}-${order.id}-${crypto.randomBytes(4).toString("hex")}`;

      // Deliver over local HTTP to exercise the full rawBody + HMAC verification + Yii2 M2M path
      const webhookUrl = `http://127.0.0.1:${config.port}/node-api/webhooks/modalities/${modality}/result`;
      const pushRes = await fetch(webhookUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "X-External-Timestamp": timestamp,
          "X-External-Signature": signature,
          "X-External-Event-Id": eventId,
          "X-Correlation-Id": req.correlationId,
        },
        body: rawBody,
      });

      const pushData = await pushRes.json().catch(() => null);
      return res.status(pushRes.status).json({
        ...pushData,
        simulated_external_push: {
          target: `/node-api/webhooks/modalities/${modality}/result`,
          event_id: eventId,
          timestamp: Number(timestamp),
          signature_alg: "HMAC-SHA256",
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
