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
 * Validates pagination query parameters on GET /node-api/lab/orders.
 */
export function validateLabOrdersQuery(req, res, next) {
  const { page, per_page } = req.query;
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
 * Validates external laboratory result callback payload before forwarding to Yii2.
 */
export function validateLabResultCallback(req, res, next) {
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
    return sendValidationError(req, res, "Validation failed.", errors);
  }

  req.validatedLabResult = {
    orderId,
    result_summary: result_summary.trim(),
    reference_notes: reference_notes ? String(reference_notes).trim() : null,
    result_details: result_details ?? null,
  };
  return next();
}
