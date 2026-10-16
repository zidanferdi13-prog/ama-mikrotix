import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createScheduler } from '../src/scheduler.js';

function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

test('pekerjaan yang sama tidak overlap: slot berikutnya dilewati', async () => {
  let calls = 0;
  const gate = deferred();
  let clock = 0;

  const scheduler = createScheduler({
    jobs: [
      {
        deviceId: 1,
        kind: 'ping',
        intervalMs: 15_000,
        run: async () => {
          calls += 1;
          await gate.promise;
        },
      },
    ],
    tickMs: 1000,
    now: () => clock,
  });

  clock = 15_001;
  await scheduler.tick();
  assert.equal(calls, 1);

  // Slot berikutnya jatuh saat pekerjaan pertama masih aktif → dilewati.
  clock = 30_002;
  await scheduler.tick();
  assert.equal(calls, 1);
  assert.equal(scheduler.isRunning(1, 'ping'), true);

  gate.resolve();
  await Promise.resolve();
  await new Promise((r) => setImmediate(r));
  assert.equal(scheduler.isRunning(1, 'ping'), false);
});

test('concurrency per kind dibatasi (ping maksimum 2)', async () => {
  const gates = [deferred(), deferred(), deferred()];
  let started = 0;
  let clock = 0;

  const jobs = [1, 2, 3].map((deviceId, i) => ({
    deviceId,
    kind: 'ping',
    intervalMs: 15_000,
    run: async () => {
      started += 1;
      await gates[i].promise;
    },
  }));

  const scheduler = createScheduler({ jobs, tickMs: 1000, now: () => clock });
  clock = 15_001;
  await scheduler.tick();

  // 2 mulai; yang ketiga tertahan batas concurrency.
  assert.equal(started, 2);

  gates[0].resolve();
  await new Promise((r) => setImmediate(r));
  await scheduler.tick();
  assert.equal(started, 3);
});

test('kegagalan satu pekerjaan tidak menghentikan scheduler', async () => {
  let second = 0;
  let clock = 0;
  const scheduler = createScheduler({
    jobs: [
      { deviceId: 1, kind: 'ping', intervalMs: 1000, run: async () => { throw new Error('boom'); } },
      { deviceId: 2, kind: 'ping', intervalMs: 1000, run: async () => { second += 1; } },
    ],
    tickMs: 1000,
    now: () => clock,
  });

  clock = 1001;
  await scheduler.tick();
  await new Promise((r) => setImmediate(r));

  clock = 2002;
  await scheduler.tick();
  assert.equal(second, 2);
});

test('setJobs: AP baru mulai dikoleksi tanpa mereset jadwal AP lama, AP yang dilepas berhenti', async () => {
  let clock = 0;
  const runs = [];
  const job = (deviceId) => ({
    deviceId,
    kind: 'ping',
    intervalMs: 10_000,
    run: async () => {
      runs.push(deviceId);
    },
  });
  const scheduler = createScheduler({ jobs: [job(1)], tickMs: 1000, now: () => clock });

  clock = 10_001;
  await scheduler.tick();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(runs, [1]);

  // AP ditambahkan dari dashboard: jadwal AP 1 tidak ikut direset.
  scheduler.setJobs([job(1), job(2)]);
  clock = 20_002;
  await scheduler.tick();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(runs, [1, 1, 2]);

  // AP 1 dinonaktifkan: hanya AP 2 yang berjalan.
  scheduler.setJobs([job(2)]);
  clock = 30_003;
  await scheduler.tick();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(runs, [1, 1, 2, 2]);
});
