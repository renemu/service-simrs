import crypto from "node:crypto";
import { config } from "../config/env.js";

/**
 * External Diagnostic & Mechanical Modality Gateway Registry.
 * Supports dummy/mock external systems by default (EXTERNAL_MODALITY_MODE=dummy)
 * and real HTTP vendor endpoints when configured (EXTERNAL_MODALITY_MODE=live).
 */
export const MODALITY_REGISTRY = {
  ct_scan: {
    modality: "ct_scan",
    code: "CT",
    name: "CT-Scan Scanner Gateway",
    category: "mechanical_imaging",
    protocol: "DICOM MWL / HL7 ORM / REST",
    external_system: "dummy-ct-scan-ris-pacs",
    device_name: "Siemens SOMATOM go.Top 128-Slice CT (Dummy)",
    ae_title: "SIMRS_CT_01",
    supports_contrast: true,
    default_body_part: "Kepala (Brain)",
    accession_prefix: "CT-ACC",
    description:
      "Integrasi eksternal perangkat CT-Scan (worklist dispatch, tracking akuisisi irisan, & sinkronisasi hasil radiologi/DICOM).",
  },
  xray: {
    modality: "xray",
    code: "DX",
    name: "X-Ray / Digital Radiography Gateway",
    category: "mechanical_imaging",
    protocol: "DICOM MWL / PACS REST",
    external_system: "dummy-xray-pacs",
    device_name: "Fujifilm FDR Smart X Digital X-Ray (Dummy)",
    ae_title: "SIMRS_DX_01",
    supports_contrast: false,
    default_body_part: "Thorax PA",
    accession_prefix: "XR-ACC",
    description:
      "Integrasi eksternal sistem X-Ray / Rontgen digital untuk pengiriman worklist dan pengambilan expertise radiografi.",
  },
  mri: {
    modality: "mri",
    code: "MR",
    name: "MRI Scanner Gateway",
    category: "mechanical_imaging",
    protocol: "DICOM MWL / RIS REST",
    external_system: "dummy-mri-ris",
    device_name: "GE SIGNA Explorer 1.5T MRI (Dummy)",
    ae_title: "SIMRS_MR_01",
    supports_contrast: true,
    default_body_part: "Brain / Kepala",
    accession_prefix: "MR-ACC",
    description:
      "Integrasi eksternal perangkat MRI 1.5 Tesla (non-kontras / kontras gadolinium) dengan laporan sekuens T1/T2/FLAIR.",
  },
  usg: {
    modality: "usg",
    code: "US",
    name: "Ultrasonography (USG) Gateway",
    category: "mechanical_imaging",
    protocol: "DICOM SR / REST",
    external_system: "dummy-usg-gateway",
    device_name: "Mindray DC-80 Ultrasound System (Dummy)",
    ae_title: "SIMRS_US_01",
    supports_contrast: false,
    default_body_part: "Abdomen Lengkap",
    accession_prefix: "US-ACC",
    description:
      "Integrasi eksternal perangkat USG (Abdomen, Obstetri, Doppler) untuk sinkronisasi biometri & kesan ultrasonografi.",
  },
  ekg: {
    modality: "ekg",
    code: "ECG",
    name: "Electrocardiograph (EKG) Gateway",
    category: "mechanical_diagnostic",
    protocol: "HL7 v2 ORU / REST",
    external_system: "dummy-ekg-gateway",
    device_name: "Philips PageWriter TC50 12-Lead EKG (Dummy)",
    ae_title: "SIMRS_ECG_01",
    supports_contrast: false,
    default_body_part: "Kardiologi 12-Lead",
    accession_prefix: "EKG-ACC",
    description:
      "Integrasi eksternal mesin EKG 12-lead untuk transmisi gelombang & interpretasi ritme jantung otomatis.",
  },
  lab_clinical: {
    modality: "lab_clinical",
    code: "LIS",
    name: "Clinical Pathology LIS Gateway",
    category: "clinical_laboratory",
    protocol: "HL7 v2 ORM/ORU / REST",
    external_system: "dummy-clinical-lis",
    device_name: "Sysmex XN-1000 / Cobas Clinical Analyzer (Dummy)",
    ae_title: "SIMRS_LIS_01",
    supports_contrast: false,
    default_body_part: "Sampel Klinis",
    accession_prefix: "LIS-ACC",
    description:
      "Integrasi eksternal Laboratory Information System (LIS) untuk hematologi, kimia klinik, dan urinalisis.",
  },
};

export const SUPPORTED_MODALITIES = Object.keys(MODALITY_REGISTRY);

// In-memory store for simulated external studies (authoritative state is always persisted to Yii2 PostgreSQL)
const externalStudyByOrderId = new Map();
const externalStudyByRef = new Map();

export function normalizeModality(modality) {
  const key = String(modality || "")
    .trim()
    .toLowerCase()
    .replace(/-/g, "_");
  if (key === "ct" || key === "ctscan") return "ct_scan";
  if (key === "x_ray" || key === "rontgen" || key === "dx") return "xray";
  if (key === "mr") return "mri";
  if (key === "ultrasound" || key === "us") return "usg";
  if (key === "ecg") return "ekg";
  if (key === "lis" || key === "lab") return "lab_clinical";
  return key;
}

export function isSupportedModality(modality) {
  return Boolean(MODALITY_REGISTRY[normalizeModality(modality)]);
}

export function getModalitySpec(modality) {
  const normalized = normalizeModality(modality);
  return MODALITY_REGISTRY[normalized] || null;
}

function getTargetEndpoint(modality) {
  return config.externalModality.endpoints[modality] || "";
}

function isLiveModeFor(modality) {
  return config.externalModality.mode === "live" && Boolean(getTargetEndpoint(modality));
}

export function listModalities() {
  return SUPPORTED_MODALITIES.map((key) => {
    const spec = MODALITY_REGISTRY[key];
    const targetUrl = getTargetEndpoint(key);
    const live = isLiveModeFor(key);
    return {
      ...spec,
      mode: live ? "live" : "dummy",
      configured_url: targetUrl || null,
      status: "online",
      simulated: !live,
    };
  });
}

function createGatewayError(statusCode, errorLabel, message, details = null) {
  const err = new Error(message);
  err.statusCode = statusCode;
  err.errorLabel = errorLabel;
  err.details = details;
  return err;
}

function handleSimulatedFailure(simulateFailure, spec) {
  const sim = String(simulateFailure || "").trim().toLowerCase();
  if (!sim) return;

  if (sim === "timeout") {
    throw createGatewayError(
      504,
      "Gateway Timeout",
      `External ${spec.name} (${spec.external_system}) timed out after ${config.externalModality.timeoutMs}ms. Order marked for reconciliation.`,
      { failure_type: "timeout", external_system: spec.external_system, modality: spec.modality }
    );
  }
  if (sim === "device_offline" || sim === "offline") {
    throw createGatewayError(
      503,
      "Service Unavailable",
      `External ${spec.name} (${spec.device_name}) is currently offline or calibrating. Reconciliation required.`,
      { failure_type: "device_offline", external_system: spec.external_system, modality: spec.modality }
    );
  }
  if (sim === "error") {
    throw createGatewayError(
      502,
      "Bad Gateway",
      `External ${spec.name} (${spec.external_system}) returned HTTP 500 error. Reconciliation required.`,
      { failure_type: "downstream_error", external_system: spec.external_system, modality: spec.modality }
    );
  }
}

async function fetchExternalJson(url, options, timeoutMs, spec) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { raw: text };
    }
    if (!res.ok) {
      throw createGatewayError(
        res.status >= 500 ? 502 : res.status,
        "Bad Gateway",
        data?.message || `External ${spec.name} rejected request with HTTP ${res.status}.`,
        { upstream_status: res.status, upstream_payload: data }
      );
    }
    return data;
  } catch (err) {
    if (err?.statusCode) throw err;
    if (err?.name === "AbortError") {
      throw createGatewayError(
        504,
        "Gateway Timeout",
        `External ${spec.name} timed out after ${timeoutMs}ms.`
      );
    }
    throw createGatewayError(
      502,
      "Bad Gateway",
      `Failed to connect to external ${spec.name}: ${err?.message || "network error"}.`
    );
  } finally {
    clearTimeout(timer);
  }
}

function compactDate() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
}

function generateStudyUid(modalityCode, orderId) {
  const rand = crypto.randomInt(10000, 99999);
  const modNum =
    { CT: 11, DX: 12, MR: 13, US: 14, ECG: 15, LIS: 16 }[modalityCode] || 19;
  return `1.2.840.113619.2.55.3.${modNum}.${Date.now()}.${orderId}.${rand}`;
}

function generateAccessionNumber(spec, orderId) {
  const suffix = crypto.randomBytes(2).toString("hex").toUpperCase();
  return `${spec.accession_prefix}-${compactDate()}-${String(orderId).padStart(4, "0")}-${suffix}`;
}

function buildCtScanProtocol(bodyPart, contrastUsed, customProtocol) {
  const region = bodyPart || "Kepala (Brain)";
  if (customProtocol) return customProtocol;
  return contrastUsed
    ? `Helical CT ${region} + IV Contrast (Arterial & Venous Phase)`
    : `Helical CT ${region} Non-Contrast Standard Axial/MPR`;
}

/**
 * Checks connectivity/health of a specific external modality gateway.
 */
export async function checkModalityHealth(modality, { simulateFailure = "", correlationId = null } = {}) {
  const spec = getModalitySpec(modality);
  if (!spec) {
    throw createGatewayError(422, "Unprocessable Entity", `Unsupported modality "${modality}".`);
  }

  handleSimulatedFailure(simulateFailure, spec);

  if (isLiveModeFor(spec.modality)) {
    const url = `${getTargetEndpoint(spec.modality)}/health`;
    const upstream = await fetchExternalJson(
      url,
      {
        method: "GET",
        headers: {
          Accept: "application/json",
          ...(correlationId ? { "X-Correlation-Id": correlationId } : {}),
        },
      },
      config.externalModality.timeoutMs,
      spec
    );
    return {
      ...spec,
      mode: "live",
      simulated: false,
      status: "online",
      upstream,
      checked_at: new Date().toISOString(),
    };
  }

  return {
    ...spec,
    mode: "dummy",
    simulated: true,
    status: "online",
    latency_ms: crypto.randomInt(12, 48),
    queue_depth: externalStudyByOrderId.size,
    checked_at: new Date().toISOString(),
  };
}

/**
 * Dispatches a SIMRS LabOrder to an external diagnostic modality (CT-Scan, X-Ray, MRI, USG, EKG, LIS).
 */
export async function dispatchOrderToModality(modality, order, options = {}) {
  const spec = getModalitySpec(modality);
  if (!spec) {
    throw createGatewayError(422, "Unprocessable Entity", `Unsupported modality "${modality}".`);
  }

  const {
    bodyPart = order.body_part || spec.default_body_part,
    contrastUsed = Boolean(order.contrast_used),
    protocol = null,
    sliceThicknessMm = spec.modality === "ct_scan" ? 1.25 : null,
    clinicalIndication = order.notes || null,
    correlationId = order.correlation_id || crypto.randomUUID(),
    idempotencyKey = null,
    simulateFailure = "",
  } = options;

  handleSimulatedFailure(simulateFailure, spec);

  const worklistPayload = {
    order_id: order.id,
    order_number: order.order_number,
    modality: spec.modality,
    dicom_modality: spec.code,
    ae_title: spec.ae_title,
    patient: order.patient || { id: order.patient_id },
    visit: order.visit || { id: order.visit_id },
    test_name: order.test_name,
    body_part: bodyPart,
    contrast_used: Boolean(contrastUsed),
    protocol:
      spec.modality === "ct_scan"
        ? buildCtScanProtocol(bodyPart, Boolean(contrastUsed), protocol)
        : protocol || `${spec.name} Standard Protocol`,
    ...(sliceThicknessMm ? { slice_thickness_mm: Number(sliceThicknessMm) } : {}),
    clinical_indication: clinicalIndication,
    correlation_id: correlationId,
  };

  if (isLiveModeFor(spec.modality)) {
    const url = `${getTargetEndpoint(spec.modality)}/worklist/dispatch`;
    const upstream = await fetchExternalJson(
      url,
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "X-Correlation-Id": correlationId,
          ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
        },
        body: JSON.stringify(worklistPayload),
      },
      config.externalModality.timeoutMs,
      spec
    );

    return {
      order_id: order.id,
      order_number: order.order_number,
      modality_type: spec.modality,
      dicom_modality: spec.code,
      external_system: upstream.external_system || spec.external_system,
      external_reference_id: upstream.external_reference_id || upstream.accession_number,
      study_instance_uid: upstream.study_instance_uid || null,
      device_name: upstream.device_name || spec.device_name,
      mode: "live",
      simulated: false,
      status: "dispatched",
      worklist_status: upstream.worklist_status || "scheduled",
      body_part: bodyPart,
      contrast_used: Boolean(contrastUsed),
      protocol: worklistPayload.protocol,
      correlation_id: correlationId,
      dispatched_at: upstream.dispatched_at || new Date().toISOString(),
    };
  }

  // Dummy external modality simulator response
  const externalRef = generateAccessionNumber(spec, order.id);
  const studyUid = generateStudyUid(spec.code, order.id);
  const now = new Date().toISOString();

  const record = {
    order_id: order.id,
    order_number: order.order_number,
    modality_type: spec.modality,
    dicom_modality: spec.code,
    external_system: spec.external_system,
    external_reference_id: externalRef,
    accession_number: externalRef,
    study_instance_uid: studyUid,
    device_name: spec.device_name,
    ae_title: spec.ae_title,
    protocol: worklistPayload.protocol,
    body_part: bodyPart,
    contrast_used: Boolean(contrastUsed),
    slice_thickness_mm: spec.modality === "ct_scan" ? Number(sliceThicknessMm || 1.25) : null,
    clinical_indication: clinicalIndication,
    mode: "dummy",
    simulated: true,
    status: "dispatched",
    worklist_status: "ready_for_result_sync",
    correlation_id: correlationId,
    dispatched_at: now,
    updated_at: now,
  };

  externalStudyByOrderId.set(String(order.id), record);
  externalStudyByRef.set(externalRef, record);
  return record;
}

/**
 * Returns tracked external study status by order or external reference ID.
 */
export function getTrackedStudyForOrder(orderId) {
  return externalStudyByOrderId.get(String(orderId)) || null;
}

export function getTrackedStudyByRef(externalRef) {
  return externalStudyByRef.get(String(externalRef)) || null;
}

/**
 * Generates realistic modality-specific diagnostic results for Dummy mode.
 * Gives special, clinically detailed DICOM/radiology structure for CT-Scan.
 */
function buildDummyModalityResult(spec, order, trackedStudy, overrides = {}) {
  const bodyPart = overrides.bodyPart || trackedStudy?.body_part || order.body_part || spec.default_body_part;
  const contrastUsed =
    overrides.contrastUsed !== undefined
      ? Boolean(overrides.contrastUsed)
      : Boolean(trackedStudy?.contrast_used ?? order.contrast_used);
  const accessionNumber =
    trackedStudy?.external_reference_id ||
    order.external_reference_id ||
    generateAccessionNumber(spec, order.id);
  const studyUid = trackedStudy?.study_instance_uid || generateStudyUid(spec.code, order.id);
  const completedAt = new Date().toISOString();

  if (spec.modality === "ct_scan") {
    const regionLower = String(bodyPart).toLowerCase();
    const isThorax = regionLower.includes("thorax") || regionLower.includes("dada") || regionLower.includes("paru");
    const isAbdomen = regionLower.includes("abdomen") || regionLower.includes("perut");

    let findings;
    let impression;
    let dlp;
    let slices;

    if (isThorax) {
      findings =
        "Parenkim paru kanan dan kiri tidak tampak infiltrat, konsolidasi, maupun massa. Corakan bronkovaskular dalam batas normal. Tidak tampak efusi pleura maupun pneumothorax. Mediastinum dan besar jantung (CTR < 50%) normal.";
      impression = `CT-Scan Thorax ${contrastUsed ? "dengan kontras IV" : "non-kontras"} tidak menunjukkan kelainan aktif pada parenkim paru maupun mediastinum.`;
      dlp = contrastUsed ? 412.6 : 298.4;
      slices = 280;
    } else if (isAbdomen) {
      findings =
        "Hepar ukuran dan densitas parenkim homogen, tidak tampak lesi fokal. Kandung empedu dinding tipis tanpa batu. Pankreas, limpa, dan kedua ginjal dalam batas normal. Tidak tampak cairan bebas intraabdomen.";
      impression = `CT-Scan Abdomen ${contrastUsed ? "dengan kontras IV" : "non-kontras"} dalam batas normal, tidak tampak massa atau batu saluran kemih.`;
      dlp = contrastUsed ? 520.3 : 385.1;
      slices = 320;
    } else {
      findings =
        "Diferensiasi substansia grisea dan alba baik. Tidak tampak lesi hiperdens (perdarahan intrakranial) maupun hipodens (infark akut). Sistem ventrikel dan sisterna simetris, tidak tampak midline shift. Tulang kalvaria dan sinus paranasal intak.";
      impression = `CT-Scan ${bodyPart} ${contrastUsed ? "dengan kontras IV" : "non-kontras"} tidak tampak perdarahan intrakranial, infark akut, maupun space occupying lesion (SOL).`;
      dlp = contrastUsed ? 845.2 : 692.8;
      slices = 192;
    }

    const summary = overrides.resultSummary || `[CT-Scan ${bodyPart}] ${impression}`;
    return {
      result_summary: summary,
      reference_notes:
        overrides.referenceNotes ||
        `Dummy External CT-Scan Gateway (${spec.device_name}) • Accession: ${accessionNumber} • DLP: ${dlp} mGy·cm`,
      result_source: "external_gateway",
      external_system: spec.external_system,
      external_reference_id: accessionNumber,
      external_study_uid: studyUid,
      modality_device: spec.device_name,
      external_completed_at: completedAt,
      result_details: {
        gateway_mode: "dummy",
        modality: "ct_scan",
        dicom_modality: "CT",
        accession_number: accessionNumber,
        study_instance_uid: studyUid,
        device_name: spec.device_name,
        ae_title: spec.ae_title,
        body_part: bodyPart,
        contrast_used: contrastUsed,
        contrast_agent: contrastUsed ? "Iohexol 350 mgI/mL (80 mL IV)" : null,
        protocol: trackedStudy?.protocol || buildCtScanProtocol(bodyPart, contrastUsed),
        acquisition_parameters: {
          tube_voltage_kv: 120,
          tube_current_mas: 210,
          slice_thickness_mm: trackedStudy?.slice_thickness_mm || 1.25,
          total_slices: slices,
          series_count: contrastUsed ? 4 : 3,
          radiation_dose_dlp_mgy_cm: dlp,
          ctdi_vol_mgy: Number((dlp / 24).toFixed(2)),
        },
        findings,
        impression,
        radiologist_verified_by: "dr. Suryo Wibowo, Sp.Rad (Dummy External RIS)",
        dicom_viewer_preview_url: `/mock-pacs/viewer?studyUid=${encodeURIComponent(studyUid)}`,
        completed_at: completedAt,
      },
    };
  }

  if (spec.modality === "xray") {
    const impression = `Foto X-Ray ${bodyPart}: Cor dan pulmo dalam batas normal, tidak tampak infiltrat maupun fraktur tulang yang tervisualisasi.`;
    return {
      result_summary: overrides.resultSummary || `[X-Ray ${bodyPart}] ${impression}`,
      reference_notes:
        overrides.referenceNotes ||
        `Dummy External X-Ray PACS (${spec.device_name}) • Accession: ${accessionNumber}`,
      result_source: "external_gateway",
      external_system: spec.external_system,
      external_reference_id: accessionNumber,
      external_study_uid: studyUid,
      modality_device: spec.device_name,
      external_completed_at: completedAt,
      result_details: {
        gateway_mode: "dummy",
        modality: "xray",
        dicom_modality: "DX",
        accession_number: accessionNumber,
        study_instance_uid: studyUid,
        body_part: bodyPart,
        projection: "PA / Lateral",
        exposure_kvp: 110,
        exposure_mas: 4.5,
        findings: "Cor ukuran normal (CTR < 50%), sinus kostofrenikus lancip, diafragma licin, kedua lapang paru bersih.",
        impression,
        completed_at: completedAt,
      },
    };
  }

  if (spec.modality === "mri") {
    const impression = `MRI ${bodyPart} 1.5T ${contrastUsed ? "dengan kontras" : "non-kontras"}: Tidak tampak lesi massa, edema, atau restriksi difusi akut pada sekuens T1W/T2W/FLAIR/DWI.`;
    return {
      result_summary: overrides.resultSummary || `[MRI ${bodyPart}] ${impression}`,
      reference_notes:
        overrides.referenceNotes ||
        `Dummy External MRI RIS (${spec.device_name}) • Accession: ${accessionNumber}`,
      result_source: "external_gateway",
      external_system: spec.external_system,
      external_reference_id: accessionNumber,
      external_study_uid: studyUid,
      modality_device: spec.device_name,
      external_completed_at: completedAt,
      result_details: {
        gateway_mode: "dummy",
        modality: "mri",
        dicom_modality: "MR",
        accession_number: accessionNumber,
        study_instance_uid: studyUid,
        body_part: bodyPart,
        contrast_used: contrastUsed,
        field_strength_tesla: 1.5,
        sequences: ["T1W Sagittal", "T2W Axial", "FLAIR Coronal", "DWI/ADC"],
        impression,
        completed_at: completedAt,
      },
    };
  }

  if (spec.modality === "usg") {
    const impression = `USG ${bodyPart}: Organ intraabdomen dalam batas normal, ekostruktur homogen, tidak tampak batu maupun cairan bebas.`;
    return {
      result_summary: overrides.resultSummary || `[USG ${bodyPart}] ${impression}`,
      reference_notes:
        overrides.referenceNotes ||
        `Dummy External USG Gateway (${spec.device_name}) • Accession: ${accessionNumber}`,
      result_source: "external_gateway",
      external_system: spec.external_system,
      external_reference_id: accessionNumber,
      external_study_uid: studyUid,
      modality_device: spec.device_name,
      external_completed_at: completedAt,
      result_details: {
        gateway_mode: "dummy",
        modality: "usg",
        dicom_modality: "US",
        accession_number: accessionNumber,
        study_instance_uid: studyUid,
        body_part: bodyPart,
        transducer: "Convex 3.5 MHz",
        impression,
        completed_at: completedAt,
      },
    };
  }

  if (spec.modality === "ekg") {
    const impression = "Irama sinus normal, HR 76 bpm, aksis normoaksis, tidak tampak elevasi/depresi segmen ST.";
    return {
      result_summary: overrides.resultSummary || `[EKG 12-Lead] ${impression}`,
      reference_notes:
        overrides.referenceNotes ||
        `Dummy External EKG Gateway (${spec.device_name}) • Ref: ${accessionNumber}`,
      result_source: "external_gateway",
      external_system: spec.external_system,
      external_reference_id: accessionNumber,
      external_study_uid: studyUid,
      modality_device: spec.device_name,
      external_completed_at: completedAt,
      result_details: {
        gateway_mode: "dummy",
        modality: "ekg",
        dicom_modality: "ECG",
        accession_number: accessionNumber,
        heart_rate_bpm: 76,
        pr_interval_ms: 158,
        qrs_duration_ms: 88,
        qtc_ms: 412,
        rhythm: "Normal Sinus Rhythm",
        impression,
        completed_at: completedAt,
      },
    };
  }

  // Default: lab_clinical (LIS)
  return {
    result_summary:
      overrides.resultSummary ||
      "Hb 13.9 g/dL, Leukosit 7.100 /uL, Trombosit 268.000 /uL, Hematokrit 41.5% (Normal)",
    reference_notes:
      overrides.referenceNotes ||
      `Dummy External Clinical LIS (${spec.device_name}) • Ref: ${accessionNumber}`,
    result_source: "external_gateway",
    external_system: spec.external_system,
    external_reference_id: accessionNumber,
    external_study_uid: studyUid,
    modality_device: spec.device_name,
    external_completed_at: completedAt,
    result_details: {
      gateway_mode: "dummy",
      modality: "lab_clinical",
      accession_number: accessionNumber,
      parameters: [
        { name: "Hemoglobin", value: 13.9, unit: "g/dL", reference: "12.0 - 16.0", flag: "N" },
        { name: "Leukosit", value: 7100, unit: "/uL", reference: "4.000 - 10.000", flag: "N" },
        { name: "Trombosit", value: 268000, unit: "/uL", reference: "150.000 - 400.000", flag: "N" },
      ],
      completed_at: completedAt,
    },
  };
}

/**
 * Fetches or simulates completed diagnostic result from an external modality gateway.
 */
export async function fetchExternalModalityResult(modality, order, options = {}) {
  const spec = getModalitySpec(modality);
  if (!spec) {
    throw createGatewayError(422, "Unprocessable Entity", `Unsupported modality "${modality}".`);
  }

  const {
    simulateFailure = "",
    correlationId = order.correlation_id || crypto.randomUUID(),
    resultSummary = null,
    referenceNotes = null,
    bodyPart = null,
    contrastUsed = undefined,
  } = options;

  handleSimulatedFailure(simulateFailure, spec);

  const trackedStudy = externalStudyByOrderId.get(String(order.id)) || null;
  const externalRef = trackedStudy?.external_reference_id || order.external_reference_id;

  if (isLiveModeFor(spec.modality)) {
    const url = `${getTargetEndpoint(spec.modality)}/studies/${encodeURIComponent(
      externalRef || order.order_number
    )}/result`;
    const upstream = await fetchExternalJson(
      url,
      {
        method: "GET",
        headers: {
          Accept: "application/json",
          "X-Correlation-Id": correlationId,
        },
      },
      config.externalModality.timeoutMs,
      spec
    );
    return {
      result_summary: upstream.result_summary || upstream.impression,
      reference_notes: upstream.reference_notes || null,
      result_source: "external_gateway",
      external_system: upstream.external_system || spec.external_system,
      external_reference_id: upstream.external_reference_id || externalRef,
      external_study_uid: upstream.external_study_uid || upstream.study_instance_uid || null,
      modality_device: upstream.modality_device || spec.device_name,
      external_completed_at: upstream.external_completed_at || new Date().toISOString(),
      result_details: upstream.result_details || upstream,
    };
  }

  const dummyResult = buildDummyModalityResult(spec, order, trackedStudy, {
    resultSummary,
    referenceNotes,
    bodyPart,
    contrastUsed,
  });

  // Update in-memory dummy tracker
  const updatedStudy = {
    ...(trackedStudy || {}),
    order_id: order.id,
    order_number: order.order_number,
    modality_type: spec.modality,
    dicom_modality: spec.code,
    external_system: dummyResult.external_system,
    external_reference_id: dummyResult.external_reference_id,
    accession_number: dummyResult.external_reference_id,
    study_instance_uid: dummyResult.external_study_uid,
    device_name: dummyResult.modality_device,
    mode: "dummy",
    simulated: true,
    status: "synced",
    worklist_status: "completed",
    correlation_id: correlationId,
    completed_at: dummyResult.external_completed_at,
    updated_at: new Date().toISOString(),
  };
  externalStudyByOrderId.set(String(order.id), updatedStudy);
  externalStudyByRef.set(dummyResult.external_reference_id, updatedStudy);

  return dummyResult;
}
