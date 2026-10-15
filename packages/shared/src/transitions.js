// Kebijakan transisi keterjangkauan §5 (usulan, menunggu persetujuan Zidan).
// Murni: tidak menyentuh DB, sehingga bisa diuji tanpa jaringan.
import { TRANSITION } from './constants.js';

export const REACHABLE = {
  unknown: 'unknown',
  up: 'up',
  down: 'down',
};

// state: { reachable, failCount, okCount }
export function initialPingState() {
  return { reachable: REACHABLE.unknown, failCount: 0, okCount: 0 };
}

// Perubahan hanya dari pemeriksaan yang BENAR-BENAR dijalankan.
// sample: { reachable: true|false|null }
export function applyPingTransition(state, sample) {
  const next = { ...state };
  let event = null;

  // Pemeriksaan tidak sempat jalan (collector error/timeout internal) tidak dihitung.
  if (sample.reachable === null || sample.reachable === undefined) {
    return { state: next, event: null };
  }

  if (sample.reachable) {
    next.okCount = state.okCount + 1;
    next.failCount = 0;
    if (state.reachable === REACHABLE.unknown) {
      // Hasil sukses pertama menetapkan reachable tanpa recovery palsu.
      next.reachable = REACHABLE.up;
    } else if (state.reachable === REACHABLE.down && next.okCount >= TRANSITION.recoverAfterSuccesses) {
      next.reachable = REACHABLE.up;
      next.okCount = 0;
      event = 'recovered';
    }
  } else {
    next.failCount = state.failCount + 1;
    next.okCount = 0;
    if (state.reachable === REACHABLE.unknown) {
      if (next.failCount >= TRANSITION.downAfterFailures) {
        next.reachable = REACHABLE.down;
        next.failCount = 0;
        event = 'down';
      }
    } else if (state.reachable === REACHABLE.up && next.failCount >= TRANSITION.downAfterFailures) {
      next.reachable = REACHABLE.down;
      next.failCount = 0;
      event = 'down';
    }
  }

  return { state: next, event };
}

// Kesegaran per metrik, bukan per sampel.
export function isStale(lastValidAt, nowMs, thresholdMs) {
  if (!lastValidAt) return true;
  return nowMs - new Date(lastValidAt).getTime() > thresholdMs;
}
