import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  parseUptime,
  parseLoadavg,
  parseMeminfo,
  normalizeSystemSample,
} from '../src/parser.js';
import { METRIC_STATUS, ERROR_CODE } from '../src/contracts.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixtureDir = join(here, '..', '..', '..', 'fixtures', 'APOfficeLT1');
const fixture = (name) => readFileSync(join(fixtureDir, name), 'utf8');

const OBSERVED_AT = '2026-10-15T08:32:11.000Z';
const RECEIVED_AT = '2026-10-15T08:32:12.000Z';

test('fixture APOfficeLT1 menghasilkan angka sampel yang benar', () => {
  const sample = normalizeSystemSample({
    deviceId: 1,
    observedAt: OBSERVED_AT,
    receivedAt: RECEIVED_AT,
    outputs: {
      uptime: fixture('uptime.txt'),
      loadavg: fixture('loadavg.txt'),
      meminfo: fixture('meminfo.txt'),
    },
  });

  assert.equal(sample.collection_status, 'ok');
  assert.equal(sample.uptime_seconds, 266591.49);
  assert.equal(sample.load_1, 0.1);
  assert.equal(sample.load_5, 0.11);
  assert.equal(sample.load_15, 0.09);

  assert.equal(sample.memory_total_bytes, 125580 * 1024);
  assert.equal(sample.memory_available_bytes, 67068 * 1024);
  assert.equal(sample.memory_used_bytes, 59916288);
  assert.equal(Math.round(sample.memory_used_percent * 10) / 10, 46.6);

  // Bukan MemTotal - MemFree.
  assert.notEqual(sample.memory_used_bytes, (125580 - 44500) * 1024);
});

test('timestamp disimpan apa adanya, UTC', () => {
  const sample = normalizeSystemSample({
    deviceId: 1,
    observedAt: OBSERVED_AT,
    receivedAt: RECEIVED_AT,
    outputs: { uptime: fixture('uptime.txt'), loadavg: fixture('loadavg.txt'), meminfo: fixture('meminfo.txt') },
  });
  assert.equal(sample.observed_at, OBSERVED_AT);
  assert.equal(sample.received_at, RECEIVED_AT);
});

test('MemAvailable=0 valid dan berarti RAM terpakai 100%', () => {
  const mem = parseMeminfo('MemTotal: 100000 kB\nMemFree: 0 kB\nMemAvailable: 0 kB\n');
  assert.equal(mem.memory_available_bytes.status, METRIC_STATUS.ok);
  assert.equal(mem.memory_available_bytes.value, 0);
  assert.equal(mem.memory_used_bytes.value, 100000 * 1024);
  assert.equal(mem.memory_used_percent.value, 100);
});

test('field hilang → null + error per metrik terkait saja', () => {
  const mem = parseMeminfo('MemTotal: 100000 kB\n');
  assert.equal(mem.memory_total_bytes.status, METRIC_STATUS.ok);
  assert.equal(mem.memory_available_bytes.status, METRIC_STATUS.invalid);
  assert.equal(mem.memory_available_bytes.code, ERROR_CODE.missing);
  assert.equal(mem.memory_available_bytes.value, null);
  // Turunan tidak dihitung tanpa available.
  assert.equal(mem.memory_used_bytes.value, null);
  assert.equal(mem.memory_used_percent.value, null);
});

test('format rusak, NaN, dan tak hingga tidak menjadi nol', () => {
  assert.equal(parseUptime('abc 1.0').uptime_seconds.value, null);
  assert.equal(parseUptime('').uptime_seconds.code, ERROR_CODE.missing);
  assert.equal(parseUptime('nan nan').uptime_seconds.code, ERROR_CODE.not_numeric);
  assert.equal(parseUptime('1e999 1').uptime_seconds.code, ERROR_CODE.not_finite);
  assert.equal(parseLoadavg('NaN 1 2').load_1.value, null);
  assert.equal(parseLoadavg('NaN 1 2').load_5.value, 1);
});

test('MemTotal <= 0 tidak valid', () => {
  const mem = parseMeminfo('MemTotal: 0 kB\nMemAvailable: 0 kB\n');
  assert.equal(mem.memory_total_bytes.status, METRIC_STATUS.invalid);
  assert.equal(mem.memory_total_bytes.code, ERROR_CODE.not_positive);
  assert.equal(mem.memory_total_bytes.value, null);
});

test('MemAvailable di luar 0..MemTotal tidak valid, total tetap dipertahankan', () => {
  const mem = parseMeminfo('MemTotal: 100000 kB\nMemAvailable: 200000 kB\n');
  assert.equal(mem.memory_total_bytes.status, METRIC_STATUS.ok);
  assert.equal(mem.memory_available_bytes.status, METRIC_STATUS.invalid);
  assert.equal(mem.memory_available_bytes.code, ERROR_CODE.out_of_range);
});

test('kerusakan satu metrik tidak menghapus metrik lain yang valid', () => {
  const sample = normalizeSystemSample({
    deviceId: 1,
    observedAt: OBSERVED_AT,
    receivedAt: RECEIVED_AT,
    outputs: { uptime: '266591.49 1', loadavg: 'rusak', meminfo: fixture('meminfo.txt') },
  });
  assert.equal(sample.collection_status, 'partial');
  assert.equal(sample.uptime_seconds, 266591.49);
  assert.equal(sample.memory_used_bytes, 59916288);
  assert.equal(sample.load_1, null);
  assert.equal(sample.metric_status.load_1.code, ERROR_CODE.not_numeric);
});

test('semua metrik gagal → collection_status error, semua nilai null', () => {
  const sample = normalizeSystemSample({
    deviceId: 1,
    observedAt: OBSERVED_AT,
    receivedAt: RECEIVED_AT,
    outputs: {},
  });
  assert.equal(sample.collection_status, 'error');
  assert.equal(sample.uptime_seconds, null);
  assert.equal(sample.memory_used_percent, null);
});

test('/proc/uptime field kedua tidak dipakai sebagai CPU %', () => {
  const a = parseUptime('100.00 999999.99');
  assert.equal(a.uptime_seconds.value, 100);
});
