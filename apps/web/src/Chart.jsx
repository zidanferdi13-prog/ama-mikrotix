// Grafik SVG sederhana: gap kegagalan tetap kosong, tidak diinterpolasi.
// ponytail: cukup untuk 3 AP dan rentang 1–24 jam; ganti ke library grafik
// bila perlu zoom/brush/tooltip kaya.
import React from 'react';

export default function Chart({ series, unit, label, height = 120 }) {
  const points = series.filter((p) => p.y !== null && p.y !== undefined && Number.isFinite(p.y));
  if (points.length < 2) {
    return <p className="banner">Belum cukup data untuk grafik.</p>;
  }

  const width = 600;
  const pad = 8;
  const xs = series.map((p) => p.x);
  const xMin = Math.min(...xs);
  const xMax = Math.max(...xs);
  const yMax = Math.max(...points.map((p) => p.y));
  const yMin = Math.min(0, Math.min(...points.map((p) => p.y)));

  const sx = (x) => pad + ((x - xMin) / (xMax - xMin || 1)) * (width - pad * 2);
  const sy = (y) => height - pad - ((y - yMin) / (yMax - yMin || 1)) * (height - pad * 2);

  // Pecah segmen pada gap agar nilai lama tidak tersambung seolah sampel baru.
  const segments = [];
  let current = [];
  for (const p of series) {
    if (p.y === null || p.y === undefined || !Number.isFinite(p.y)) {
      if (current.length) segments.push(current);
      current = [];
    } else {
      current.push(p);
    }
  }
  if (current.length) segments.push(current);

  return (
    <figure className="chart">
      <figcaption>
        {label} {unit ? <span className="sub">({unit})</span> : null}
      </figcaption>
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${label} ${unit ?? ''}`} preserveAspectRatio="none">
        {segments.map((seg, i) => (
          <polyline
            key={i}
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            points={seg.map((p) => `${sx(p.x)},${sy(p.y)}`).join(' ')}
          />
        ))}
      </svg>
      <p className="sub">
        Min {yMin.toFixed(1)} · Maks {yMax.toFixed(1)}
      </p>
    </figure>
  );
}
