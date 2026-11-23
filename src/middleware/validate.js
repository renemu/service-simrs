import { isSupportedModality, normalizeModality, SUPPORTED_MODALITIES } from "../lib/modalityGateway.js";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isValidCalendarDate(dateStr) {
  if (!DATE_RE.test(dateStr)) return false;
  const [year, month, day] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(year, month - 1, day));
  return (
    dt.getUTCFullYear() === year &&
    dt.getUTCMonth() === month - 1 &&
    dt.getUTCDate() === day
  );
}

function sendValidationError(req, res, message, errors) {
  return res.status(422).json({
    success: false,
    status: 422,
    error: "Unprocessable Entity",
    message,
    errors,
    correlation_id: req.correlationId,
  });
}

/**
 * Validates optional dashboard query parameters: from, to (YYYY-MM-DD, from <= to) and department_id.
 */
export function validateDateRange(req, res, next) {
  const { from, to, department_id } = req.query;
  const errors = {};

  if (from !== undefined && String(from).trim() !== "") {
    if (!isValidCalendarDate(String(from).trim())) {
      errors.from = ["from must be a valid date in YYYY-MM-DD format."];
    }
  }

  if (to !== undefined && String(to).trim() !== "") {
    if (!isValidCalendarDate(String(to).trim())) {
      errors.to = ["to must be a valid date in YYYY-MM-DD format."];
    }
  }

  if (
    !errors.from &&
    !errors.to &&
    from &&
    to &&
    String(from).trim() > String(to).trim()
  ) {
    errors.from = ["from date cannot be after to date."];
  }

  if (department_id !== undefined && String(department_id).trim() !== "") {
    const deptId = Number(department_id);
    if (!Number.isInteger(deptId) || deptId <= 0) {
      errors.department_id = ["department_id must be a positive integer."];
    }
  }

  if (Object.keys(errors).length > 0) {
    return sendValidationError(req, res, "Invalid date filter parameters.", errors);
  }

  return next();
}

/**
 * Validates query parameters on GET /node-api/lab/orders.
 */
export function validateLabOrdersQuery(req, res, next) {
  const { page, per_page, modality_type } = req.query;
  const errors = {};

  if (page !== undefined && String(page).trim() !== "") {
    const p = Number(page);
    if (!Number.isInteger(p) || p <= 0) {
      errors.page = ["page must be a positive integer."];
    }
  }

  if (per_page !== undefined && String(per_page).trim() !== "") {
    const pp = Number(per_page);
    if (!Number.isInteger(pp) || pp <= 0 || pp > 100) {
      errors.per_page = ["per_page must be an integer between 1 and 100."];
    }
  }

  if (modality_type !== undefined && String(modality_type).trim() !== "") {
    if (!isSupportedModality(modality_type) && String(modality_type).trim().toLowerCase() !== "other") {
      errors.modality_type = [
        `modality_type must be one of: ${SUPPORTED_MODALITIES.join(", ")}, other.`,
      ];
    }
  }

  if (Object.keys(errors).length > 0) {
    return sendValidationError(req, res, "Invalid query parameters.", errors);
  }

  return next();
}

/**
 * Validates numeric :id route parameter on lab order endpoints.
 */
export function validateLabOrderIdParam(req, res, next) {
  const orderId = Number(req.params.id);
  if (!Number.isInteger(orderId) || orderId <= 0) {
    return sendValidationError(req, res, "Valid numeric lab order ID is required.", {
      id: ["Valid numeric lab order ID is required."],
    });
  }

  req.validatedOrderId = orderId;
  return next();
}

/**
 * Validates :modality route parameter on /node-api/modalities/:modality/* endpoints.
 */
export function validateModalityParam(req, res, next) {
  const raw = req.params.modality;
  const normalized = normalizeModality(raw);
  if (!isSupportedModality(normalized)) {
    return sendValidationError(req, res, `Unsupported external modality "${raw}".`, {
      modality: [`modality must be one of: ${SUPPORTED_MODALITIES.join(", ")}.`],
    });
  }

  req.validatedModality = normalized;
  return next();
}

/**
 * Validates body for POST /node-api/modalities/:modality/dispatch.
 */
export function validateModalityDispatchBody(req, res, next) {
  const body = req.body || {};
  const orderId = Number(body.lab_order_id);
  const errors = {};

  if (!Number.isInteger(orderId) || orderId <= 0) {
    errors.lab_order_id = ["Valid numeric lab_order_id is required."];
  }

  if (body.slice_thickness_mm !== undefined && body.slice_thickness_mm !== null && body.slice_thickness_mm !== "") {
    const slice = Number(body.slice_thickness_mm);
    if (Number.isNaN(slice) || slice <= 0 || slice > 20) {
      errors.slice_thickness_mm = ["slice_thickness_mm must be a number between 0.1 and 20."];
    }
  }

  if (Object.keys(errors).length > 0) {
    return sendValidationError(req, res, "Validation failed.", errors);
  }

  req.validatedDispatch = {
    orderId,
    body_part: body.body_part ? String(body.body_part).trim() : undefined,
    contrast_used: body.contrast_used !== undefined ? Boolean(body.contrast_used) : undefined,
    protocol: body.protocol ? String(body.protocol).trim() : undefined,
    slice_thickness_mm:
      body.slice_thickness_mm !== undefined && body.slice_thickness_mm !== ""
        ? Number(body.slice_thickness_mm)
        : undefined,
    clinical_indication: body.clinical_indication ? String(body.clinical_indication).trim() : undefined,
  };
  return next();
}

/**
 * Validates body for POST /node-api/modalities/:modality/results/sync.
 */
export function validateModalitySyncBody(req, res, next) {
  const body = req.body || {};
  const orderId = Number(body.lab_order_id);
  const errors = {};

  if (!Number.isInteger(orderId) || orderId <= 0) {
    errors.lab_order_id = ["Valid numeric lab_order_id is required."];
  }

  if (Object.keys(errors).length > 0) {
    return sendValidationError(req, res, "Validation failed.", errors);
  }

  req.validatedModalitySync = {
    orderId,
    result_summary: body.result_summary ? String(body.result_summary).trim() : null,
    reference_notes: body.reference_notes ? String(body.reference_notes).trim() : null,
    body_part: body.body_part ? String(body.body_part).trim() : null,
    contrast_used: body.contrast_used !== undefined ? Boolean(body.contrast_used) : undefined,
  };
  return next();
}

/**
 * Validates external laboratory/modality result callback payload before forwarding to Yii2.
 */
export function validateLabResultCallback(req, res, next) {
  const {
    lab_order_id,
    result_summary,
    reference_notes,
    result_details,
    external_study_uid,
    modality_device,
    external_completed_at,
    external_reference_id,
    external_system,
  } = req.body || {};
  const orderId = Number(lab_order_id);
  const errors = {};

  if (!Number.isInteger(orderId) || orderId <= 0) {
    errors.lab_order_id = ["Valid lab_order_id is required."];
  }
  if (typeof result_summary !== "string" || result_summary.trim() === "") {
    errors.result_summary = ["result_summary is required."];
  }

  if (Object.keys(errors).length > 0) {
    return sendValidationError(req, res, "Validation failed.", errors);
  }

  req.validatedLabResult = {
    orderId,
    result_summary: result_summary.trim(),
    reference_notes: reference_notes ? String(reference_notes).trim() : null,
    result_details: result_details ?? null,
    result_source: "external_gateway",
    external_study_uid: external_study_uid ? String(external_study_uid).trim() : null,
    modality_device: modality_device ? String(modality_device).trim() : null,
    external_completed_at: external_completed_at ? String(external_completed_at).trim() : null,
    external_reference_id: external_reference_id ? String(external_reference_id).trim() : null,
    external_system: external_system ? String(external_system).trim() : null,
  };
  return next();
}

/**
 * Validates asynchronous inbound webhook payloads from external RIS/PACS/modality systems.
 * Allows resolving the SIMRS order by lab_order_id, external_reference_id (Accession Number), or order_number.
 */
export function validateInboundWebhookResult(req, res, next) {
  const body = req.body || {};
  const errors = {};

  const hasOrderId =
    body.lab_order_id !== undefined &&
    body.lab_order_id !== null &&
    String(body.lab_order_id).trim() !== "";
  const orderId = hasOrderId ? Number(body.lab_order_id) : null;
  const externalRef =
    typeof body.external_reference_id === "string" && body.external_reference_id.trim() !== ""
      ? body.external_reference_id.trim()
      : typeof body.accession_number === "string" && body.accession_number.trim() !== ""
      ? body.accession_number.trim()
      : null;
  const orderNumber =
    typeof body.order_number === "string" && body.order_number.trim() !== ""
      ? body.order_number.trim()
      : null;

  if (hasOrderId && (!Number.isInteger(orderId) || orderId <= 0)) {
    errors.lab_order_id = ["lab_order_id must be a positive integer."];
  }
  if (!hasOrderId && !externalRef && !orderNumber) {
    errors.order_identifier = [
      "At least one of lab_order_id, external_reference_id (accession_number), or order_number is required.",
    ];
  }
  if (typeof body.result_summary !== "string" || body.result_summary.trim() === "") {
    errors.result_summary = ["result_summary is required."];
  }

  if (Object.keys(errors).length > 0) {
    return sendValidationError(req, res, "Invalid inbound webhook payload.", errors);
  }

  req.validatedWebhookResult = {
    lab_order_id: orderId,
    external_reference_id: externalRef,
    order_number: orderNumber,
    result_summary: body.result_summary.trim(),
    reference_notes: body.reference_notes ? String(body.reference_notes).trim() : null,
    result_details: body.result_details ?? null,
    external_study_uid:
      (body.external_study_uid || body.study_instance_uid)
        ? String(body.external_study_uid || body.study_instance_uid).trim()
        : null,
    modality_device:
      (body.modality_device || body.device_name)
        ? String(body.modality_device || body.device_name).trim()
        : null,
    external_completed_at:
      (body.external_completed_at || body.completed_at)
        ? String(body.external_completed_at || body.completed_at).trim()
        : new Date().toISOString(),
    external_system: body.external_system ? String(body.external_system).trim() : null,
  };
  return next();
}
