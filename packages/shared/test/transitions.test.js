import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyPingTransition, initialPingState, REACHABLE, isStale } from '@ama/shared';

const run = (samples) =>
  samples.reduce(
    (acc, reachable) => {
      const { state, event } = applyPingTransition(acc.state, { reachable });
      return { state, events: event ? [...acc.events, event] : acc.events };
    },
    { state: initialPingState(), events: [] },
  );

test('unknown → hasil sukses pertama menetapkan up tanpa event recovery palsu', () => {
  const { state, events } = run([true]);
  assert.equal(state.reachable, REACHABLE.up);
  assert.deepEqual(events, []);
});

test('up → 3 gagal beruntun menetapkan down (satu event)', () => {
  const { state, events } = run([true, false, false, false]);
  assert.equal(state.reachable, REACHABLE.down);
  assert.deepEqual(events, ['down']);
});

test('2 gagal belum menetapkan down', () => {
  const { state, events } = run([true, false, false]);
  assert.equal(state.reachable, REACHABLE.up);
  assert.deepEqual(events, []);
});

test('down → 2 sukses beruntun recovery (satu event)', () => {
  const { state, events } = run([true, false, false, false, true, true]);
  assert.equal(state.reachable, REACHABLE.up);
  assert.deepEqual(events, ['down', 'recovered']);
});

test('keadaan sama berulang tidak membuat event duplikat', () => {
  const { events } = run([true, ...Array(10).fill(true)]);
  assert.deepEqual(events, []);
});

test('pemeriksaan tidak dijalankan (reachable null) tidak menambah hitungan gagal', () => {
  const afterDown = run([true, false, false, false]).state;
  const { state } = applyPingTransition(afterDown, { reachable: null });
  assert.equal(state.reachable, REACHABLE.down);
  assert.equal(state.failCount, 0);
  assert.equal(state.okCount, 0);
});

test('restart backend dengan keadaan tersimpan tidak menghasilkan transisi palsu', () => {
  // Simulasi restart: state dibangun ulang dari DB, counter ikut tersimpan.
  const persisted = run([true, false, false, false]).state;
  const { state, event } = applyPingTransition(persisted, { reachable: false });
  assert.equal(event, null);
  assert.equal(state.reachable, REACHABLE.down);
});

test('stale dihitung dari timestamp observasi valid, bukan waktu sekarang', () => {
  const now = Date.parse('2026-10-15T08:00:00Z');
  assert.equal(isStale(null, now, 180_000), true);
  assert.equal(isStale('2026-10-15T07:56:00Z', now, 180_000), true);
  assert.equal(isStale('2026-10-15T07:58:00Z', now, 180_000), false);
});
