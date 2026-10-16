import { test } from 'node:test';
import assert from 'node:assert/strict';
import { alertDedupKey, correlateAlerts } from '@ama/shared';
import { correlationInputOf } from '../src/alerts-job.js';

const row = (rule_id, status, target = null) => ({ rule_id, status, device_id: 2, target, dedup_key: alertDedupKey({ rule_id, device_id: 2, target }) });
const devices = [{ id: 2, stale: false, client_count: 3 }];
const incidentAp = (alerts) => correlateAlerts({ atMs: Date.now(), alerts, devices, collectorAgeMs: 1000 }).some((c) => c.rule_id === 'incident.ap');

test('alert resolved tidak menahan incident.ap (dulu 7 AP tertahan)', () => {
  const resolved = [row('ap.client_count.drop', 'resolved'), row('client.signal.weak', 'resolved', 'aa:bb:cc:00:00:01')];
  assert.deepEqual(correlationInputOf([], resolved), []);
  assert.equal(incidentAp(correlationInputOf([], resolved)), false);
});

test('alert yang ditutup siklus ini keluar dari korelasi; yang di-hold tetap', () => {
  const weak = row('client.signal.weak', 'active', 'aa:bb:cc:00:00:01');
  const memory = row('ap.memory.high', 'active');
  assert.equal(incidentAp(correlationInputOf([], [weak, memory])), true);
  assert.equal(incidentAp(correlationInputOf([{ ...memory, active: false }], [weak, memory])), false);
  // Temuan aktif + baris terbukanya = satu indikator, bukan dua.
  assert.equal(correlationInputOf([{ ...weak, active: true }], [weak]).length, 1);
});

test('client.disconnected dan ap.client_count.* bukan indikator incident.ap', () => {
  const churn = [row('client.disconnected', 'active', 'aa:bb:cc:00:00:02'), row('ap.client_count.drop', 'active')];
  assert.equal(incidentAp(correlationInputOf([], churn)), false);
});
