// Badge status: selalu teks, warna hanya penegas (aman untuk buta warna).
import React from 'react';
import { FRESHNESS_LABEL, REACHABLE_LABEL, collectionLabel, reachabilityOf } from './format.js';

export function StatusBadge({ tone = 'unknown', label }) {
  return <span className={`badge badge-${tone}`}>{label}</span>;
}

export function ReachabilityBadge({ device }) {
  const tone = reachabilityOf(device);
  return <StatusBadge tone={tone} label={REACHABLE_LABEL[tone]} />;
}

export function FreshnessBadge({ freshness }) {
  return <StatusBadge tone={freshness ?? 'no_data'} label={FRESHNESS_LABEL[freshness] ?? '—'} />;
}

export function CollectionBadge({ device }) {
  const status = device?.collection_status;
  const tone = status === 'ok' ? 'ok' : status === 'partial' ? 'partial' : status ? 'error' : 'neutral';
  return <StatusBadge tone={tone} label={collectionLabel(device)} />;
}
