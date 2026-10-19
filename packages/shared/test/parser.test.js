import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  parseUptime,
  parseLoadavg,
  parseMeminfo,
  parseClientCount,
  parseDeviceIdentity,
  parseLinkRadio,
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

// `mca-dump` UniFi: jumlah client = Σ num_sta. Data tak terbaca tidak pernah jadi nol.
test('parseClientCount: jumlah num_sta, rusak → invalid, tanpa vap_table → unsupported', () => {
  const valid = '{"vap_table":[{"name":"wlan0","num_sta":5},{"name":"wlan1","num_sta":3}]}';
  assert.equal(parseClientCount(valid).client_count.status, METRIC_STATUS.ok);
  assert.equal(parseClientCount(valid).client_count.value, 8);
  assert.equal(parseClientCount('{"vap_table":[]}').client_count.value, 0);

  // Vendor tanpa dukungan: bukan error, tapi juga bukan nol.
  assert.equal(parseClientCount('{"uptime":120}').client_count.status, METRIC_STATUS.unsupported);
  assert.equal(parseClientCount('[]').client_count.status, METRIC_STATUS.unsupported);
  assert.equal(parseClientCount('{"uptime":120}').client_count.value, null);

  // Teks hilang/kosong dan JSON rusak.
  assert.equal(parseClientCount(undefined).client_count.code, ERROR_CODE.missing);
  assert.equal(parseClientCount('').client_count.code, ERROR_CODE.missing);
  assert.equal(parseClientCount('bukan json').client_count.code, ERROR_CODE.not_numeric);
  assert.equal(parseClientCount('bukan json').client_count.value, null);
  assert.equal(parseClientCount('{"vap_table":[{"num_sta":2},').client_count.code, ERROR_CODE.not_numeric);

  // num_sta negatif/bukan angka tidak dijumlahkan.
  assert.equal(parseClientCount('{"vap_table":[{"num_sta":-1}]}').client_count.code, ERROR_CODE.not_numeric);
  assert.equal(parseClientCount('{"vap_table":[{"num_sta":"3"}]}').client_count.code, ERROR_CODE.not_numeric);
  assert.equal(parseClientCount('{"vap_table":[{"num_sta":2},{"num_sta":-1}]}').client_count.value, null);
});

test('normalizeSystemSample menyertakan client_count tanpa mengubah collection_status', () => {
  const outputs = {
    uptime: fixture('uptime.txt'),
    loadavg: fixture('loadavg.txt'),
    meminfo: fixture('meminfo.txt'),
  };

  const sample = normalizeSystemSample({
    deviceId: 1,
    observedAt: OBSERVED_AT,
    receivedAt: RECEIVED_AT,
    outputs: { ...outputs, mcaDump: '{"vap_table":[{"num_sta":4},{"num_sta":1}]}' },
  });
  assert.equal(sample.client_count, 5);
  assert.equal(sample.metric_status.client_count.status, METRIC_STATUS.ok);
  assert.equal(sample.collection_status, 'ok');

  // Vendor tanpa mca-dump: client_count null, sampel uptime/load/RAM tetap ok.
  const tanpaDukungan = normalizeSystemSample({ deviceId: 1, observedAt: OBSERVED_AT, outputs });
  assert.equal(tanpaDukungan.client_count, null);
  assert.equal(tanpaDukungan.metric_status.client_count.status, METRIC_STATUS.invalid);
  assert.equal(tanpaDukungan.collection_status, 'ok');

  // Output rusak: tetap null, bukan nol.
  const rusak = normalizeSystemSample({ deviceId: 1, observedAt: OBSERVED_AT, outputs: { ...outputs, mcaDump: 'bukan json' } });
  assert.equal(rusak.client_count, null);
  assert.equal(rusak.metric_status.client_count.code, ERROR_CODE.not_numeric);
});

test('parseDeviceIdentity: model_display + version dari mca-dump UniFi, selain itu null', () => {
  const dump = (extra) => JSON.stringify({ vap_table: [], ...extra });
  assert.deepEqual(parseDeviceIdentity(dump({ model: 'U7LR', model_display: 'UAP-AC-LR', version: '6.8.2.15592' })), { vendor: 'Ubiquiti', model: 'UAP-AC-LR', firmware: '6.8.2.15592' });
  assert.equal(parseDeviceIdentity(dump({ model: 'U7LR', version: '4.3.31.11368' })).model, 'U7LR');
  // Data tidak lengkap/bukan UniFi/rusak → tidak ada identitas (tetap belum terverifikasi).
  assert.equal(parseDeviceIdentity(dump({ model_display: 'UAP-AC-LR' })), null);
  assert.equal(parseDeviceIdentity(dump({ model_display: ' ', version: '6.8.2' })), null);
  assert.equal(parseDeviceIdentity(JSON.stringify({ model_display: 'X', version: '1' })), null);
  assert.equal(parseDeviceIdentity('bukan json'), null);
  assert.equal(parseDeviceIdentity(undefined), null);
});

// Bentuk asli mca-dump UniFi (dipangkas): if_table[0] + radio_table[].athstats + channel dari VAP.
const linkRadioDump = (over = {}) => JSON.stringify({
  if_table: [{ name: 'eth0', speed: 1000, full_duplex: true, up: true, rx_errors: 0, tx_errors: 0, rx_dropped: 6, tx_dropped: 0 }],
  radio_table: [
    { name: 'wifi0', radio: 'ng', athstats: { cu_total: 19, cu_interf: 0, noise_floor: -2078592224, n_tx_retries: 1892638, n_tx_pkts: 17148357 } },
    { name: 'wifi1', radio: 'na', athstats: { cu_total: 2, noise_floor: -95, n_tx_retries: 10, n_tx_pkts: 100 } },
  ],
  vap_table: [
    { radio: 'na', essid: 'vwire-abc', channel: 36 },
    { radio: 'ng', essid: 'Kantor', channel: 1 },
    { radio: 'na', essid: 'Kantor', channel: 149 },
  ],
  ...over,
});

test('parseLinkRadio: link + radio per band, nilai sampah/hilang → null', () => {
  const { values, link, radio } = parseLinkRadio(linkRadioDump());
  assert.equal(link.status, METRIC_STATUS.ok);
  assert.equal(radio.status, METRIC_STATUS.ok);
  assert.equal(values.eth_speed_mbps, 1000);
  assert.equal(values.eth_full_duplex, 1);
  assert.equal(values.eth_up, 1);
  assert.equal(values.eth_rx_dropped, 6);
  assert.equal(values.radio_ng_channel, 1);
  assert.equal(values.radio_na_channel, 149); // VAP vwire (mesh) dilewati
  assert.equal(values.radio_ng_cu_total, 19);
  assert.equal(values.radio_ng_noise_floor, null); // firmware melaporkan sampah
  assert.equal(values.radio_na_noise_floor, -95);
  assert.equal(values.radio_na_cu_interf, null); // firmware lama tidak punya field ini
  assert.equal(values.radio_ng_tx_retries, 1892638);

  // Nilai rusak: negatif, bukan angka, di luar rentang → null, tidak pernah 0.
  const rusak = parseLinkRadio(linkRadioDump({
    if_table: [{ speed: 0, full_duplex: 'ya', rx_errors: -1, tx_errors: '3' }],
    radio_table: [{ radio: 'ng', athstats: { cu_total: 101 } }, { radio: 'na', athstats: { cu_total: 'x' } }],
  }));
  assert.equal(rusak.values.eth_speed_mbps, null);
  assert.equal(rusak.values.eth_full_duplex, null);
  assert.equal(rusak.values.eth_rx_errors, null);
  assert.equal(rusak.values.eth_tx_errors, null);
  assert.equal(rusak.link.status, METRIC_STATUS.invalid);
  assert.equal(rusak.values.radio_ng_cu_total, null);
  assert.equal(rusak.radio.status, METRIC_STATUS.invalid);

  // Bukan UniFi → unsupported; output hilang/rusak → invalid.
  assert.equal(parseLinkRadio('{"uptime":1}').link.status, METRIC_STATUS.unsupported);
  assert.equal(parseLinkRadio('{"uptime":1}').radio.status, METRIC_STATUS.unsupported);
  assert.equal(parseLinkRadio(undefined).link.code, ERROR_CODE.missing);
  assert.equal(parseLinkRadio('bukan json').radio.code, ERROR_CODE.not_numeric);
});

test('normalizeSystemSample menyertakan link/radio tanpa mengubah collection_status', () => {
  const outputs = { uptime: fixture('uptime.txt'), loadavg: fixture('loadavg.txt'), meminfo: fixture('meminfo.txt') };
  const sample = normalizeSystemSample({ deviceId: 1, observedAt: OBSERVED_AT, outputs: { ...outputs, mcaDump: linkRadioDump({ if_table: [{ speed: 100 }] }) } });
  assert.equal(sample.eth_speed_mbps, 100);
  assert.equal(sample.radio_na_cu_total, 2);
  assert.equal(sample.metric_status.link.status, METRIC_STATUS.ok);
  assert.equal(sample.collection_status, 'ok');
  const lain = normalizeSystemSample({ deviceId: 1, observedAt: OBSERVED_AT, outputs: { ...outputs, mcaDump: '{"vap_table":[]}' } });
  assert.equal(lain.metric_status.radio.status, METRIC_STATUS.unsupported);
  assert.equal(lain.eth_speed_mbps, null);
  assert.equal(lain.collection_status, 'ok');
});
