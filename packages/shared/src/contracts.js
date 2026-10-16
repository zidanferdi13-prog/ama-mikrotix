// Kontrak data §4.3. Field yang tidak berlaku pada suatu kind bukan error.

export const COLLECTION_STATUS = ['ok', 'partial', 'error'];

export const METRIC_STATUS = {
  ok: 'ok',
  invalid: 'invalid',
  unsupported: 'unsupported',
};

// `unsupported` dibedakan dari format rusak.
export const ERROR_CODE = {
  missing: 'missing',
  not_numeric: 'not_numeric',
  not_finite: 'not_finite',
  not_positive: 'not_positive',
  out_of_range: 'out_of_range',
  no_reply: 'no_reply',
  not_measured: 'not_measured',
  dependency: 'dependency',
  unsupported: 'unsupported',
  collection_failed: 'collection_failed',
};

export const METRICS = {
  ping: ['reachable', 'latency_ms'],
  system: [
    'uptime_seconds',
    'load_1',
    'load_5',
    'load_15',
    'memory_total_bytes',
    'memory_available_bytes',
    'memory_used_bytes',
    'memory_used_percent',
  ],
};

export function ok(value) {
  return { status: METRIC_STATUS.ok, code: null, value };
}

export function invalid(code, value = null) {
  return { status: METRIC_STATUS.invalid, code, value };
}

export function unsupported(code = ERROR_CODE.unsupported, value = null) {
  return { status: METRIC_STATUS.unsupported, code, value };
}

export function utcNow() {
  return new Date().toISOString();
}

export function toUtcString(date) {
  return new Date(date).toISOString();
}

// Sampel ping: nilai yang tidak berlaku tetap null, bukan 0.
export function makePingSample({ deviceId, observedAt, collectionStatus, metricStatus, reachable, latencyMs }) {
  return {
    device_id: deviceId,
    kind: 'ping',
    observed_at: observedAt,
    received_at: utcNow(),
    collection_status: collectionStatus,
    metric_status: metricStatus,
    reachable,
    latency_ms: latencyMs,
  };
}

export function makeSystemSample({ deviceId, observedAt, collectionStatus, metricStatus, values }) {
  return {
    device_id: deviceId,
    kind: 'system',
    observed_at: observedAt,
    received_at: utcNow(),
    collection_status: collectionStatus,
    metric_status: metricStatus,
    uptime_seconds: values.uptime_seconds,
    load_1: values.load_1,
    load_5: values.load_5,
    load_15: values.load_15,
    memory_total_bytes: values.memory_total_bytes,
    memory_available_bytes: values.memory_available_bytes,
    memory_used_bytes: values.memory_used_bytes,
    memory_used_percent: values.memory_used_percent,
  };
}
