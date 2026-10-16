// Grafik SVG tangan tanpa dependensi: label sumbu Y, garis bantu horizontal,
// area tipis di bawah garis, gap (null) tetap kosong, titik terakhir ditandai.
// Lebar diukur nyata (ResizeObserver) supaya teks/titik tidak terdistorsi.
// ponytail: cukup untuk 1–24 jam dan puluhan titik; pindah ke pustaka grafik
// hanya bila perlu zoom/brush/tooltip kaya.
import React, { useEffect, useState } from 'react';

const PAD = { top: 10, right: 10, bottom: 10, left: 0 };

// Callback ref: saat mount ref.current masih null (cabang "belum cukup data"
// tidak merender <svg>), deps [ref] membuat observer tak pernah terpasang.
function useMeasuredWidth(fallback) {
  const [node, setNode] = useState(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    if (!node || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver((entries) => {
      const w = Math.round(entries[0]?.contentRect?.width ?? 0);
      if (w > 0) setWidth(w);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [node]);
  return [width || fallback, setNode];
}

function normalize(values) {
  const list = Array.isArray(values) ? values : [];
  return list.map((point, index) => {
    const x = Number(point?.x);
    const y = Number(point?.y);
    return {
      x: Number.isFinite(x) ? x : index,
      y: point?.y === null || point?.y === undefined || !Number.isFinite(y) ? null : y,
    };
  });
}

// Langkah "bulat" (1/2/2.5/5/10 × 10^n) supaya label sumbu enak dibaca.
function niceStep(span, targetTicks) {
  if (!(span > 0)) return 1;
  const raw = span / Math.max(2, targetTicks - 1);
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / magnitude;
  const mult = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10;
  return mult * magnitude;
}

// Jumlah desimal mengikuti step: step 0.25 → 2 desimal, 0.005 → 3 desimal,
// supaya dua gridline tidak pernah berlabel sama ("0.01" dua kali).
function decimalsOf(step) {
  for (let d = 0; d <= 6; d += 1) {
    if (Math.abs(step * 10 ** d - Math.round(step * 10 ** d)) < 1e-9) return d;
  }
  return 6;
}

function tickLabel(value, step) {
  return value.toFixed(Math.max(0, decimalsOf(step)));
}

function segmentsOf(points) {
  const segments = [];
  let current = [];
  for (const point of points) {
    if (point.y === null) {
      if (current.length) segments.push(current);
      current = [];
    } else {
      current.push(point);
    }
  }
  if (current.length) segments.push(current);
  return segments;
}

export default function Chart({ values, label, unit, height, compact = false, digits = 1 }) {
  const chartHeight = height ?? (compact ? 30 : 180);
  const [width, setCanvasNode] = useMeasuredWidth(compact ? 180 : 520);

  const points = normalize(values);
  const valid = points.filter((point) => point.y !== null);

  if (valid.length < 2) {
    if (compact) return <span className="spark-empty">Data metrik belum tersedia.</span>;
    return (
      <figure className="chart">
        {label && (
          <figcaption>
            {label} {unit ? <span className="sub">({unit})</span> : null}
          </figcaption>
        )}
        <p className="chart-empty">Belum cukup data untuk grafik.</p>
      </figure>
    );
  }

  const ys = valid.map((point) => point.y);
  const rawMin = Math.min(...ys);
  const rawMax = Math.max(...ys);

  let lo = rawMin;
  let hi = rawMax;
  let step = 0;
  if (compact) {
    const pad = (rawMax - rawMin || Math.abs(rawMax) || 1) * 0.15;
    lo = rawMin - pad;
    hi = rawMax + pad;
  } else {
    step = niceStep(rawMax - rawMin, 4);
    lo = Math.floor(rawMin / step) * step;
    hi = Math.ceil(rawMax / step) * step;
    if (hi === lo) hi = lo + step;
  }

  const ticks = [];
  if (step > 0) {
    for (let value = lo; value <= hi + step / 1000 && ticks.length < 8; value += step) {
      ticks.push(Number(value.toFixed(6)));
    }
  }

  const xMin = Math.min(...points.map((point) => point.x));
  const xMax = Math.max(...points.map((point) => point.x));
  const plotW = Math.max(40, width - PAD.left - PAD.right);
  const plotH = Math.max(20, chartHeight - PAD.top - PAD.bottom);
  const baseline = PAD.top + plotH;
  const sx = (x) => PAD.left + (xMax === xMin ? plotW / 2 : ((x - xMin) / (xMax - xMin)) * plotW);
  const sy = (y) => PAD.top + ((hi - y) / (hi - lo || 1)) * plotH;

  const segments = segmentsOf(points);
  const last = valid[valid.length - 1];
  const average = ys.reduce((sum, y) => sum + y, 0) / ys.length;

  const areaPath = (segment) => {
    const head = `M ${sx(segment[0].x)} ${sy(segment[0].y)}`;
    const body = segment
      .slice(1)
      .map((point) => `L ${sx(point.x)} ${sy(point.y)}`)
      .join(' ');
    return `${head} ${body} L ${sx(segment[segment.length - 1].x)} ${baseline} L ${sx(segment[0].x)} ${baseline} Z`;
  };

  const description = `${label ?? 'Grafik'}${unit ? ` dalam ${unit}` : ''}: ${valid.length} sampel, minimum ${rawMin.toFixed(
    digits,
  )}, rata-rata ${average.toFixed(digits)}, maksimum ${rawMax.toFixed(digits)}${
    last ? `, nilai terakhir ${last.y.toFixed(digits)}` : ''
  }.`;

  const svg = (
    <svg
      ref={setCanvasNode}
      className={compact ? 'spark' : undefined}
      width={width}
      height={chartHeight}
      viewBox={`0 0 ${width} ${chartHeight}`}
      role="img"
      aria-label={description}
    >
      {ticks.map((tick) => (
        <line
          key={`grid-${tick}`}
          className="chart-grid"
          x1={PAD.left}
          x2={PAD.left + plotW}
          y1={sy(tick)}
          y2={sy(tick)}
        />
      ))}
      {!compact && (
        <line
          className="chart-axis"
          x1={PAD.left}
          x2={PAD.left + plotW}
          y1={baseline}
          y2={baseline}
        />
      )}
      {segments.map((segment, index) =>
        segment.length > 1 ? (
          <path key={`area-${index}`} className="chart-area" d={areaPath(segment)} />
        ) : null,
      )}
      {segments.map((segment, index) =>
        segment.length > 1 ? (
          <polyline
            key={`line-${index}`}
            className="chart-line"
            points={segment.map((point) => `${sx(point.x)},${sy(point.y)}`).join(' ')}
          />
        ) : (
          // Segmen berisi satu sampel: tetap tampilkan titik agar tidak terlihat kosong.
          <circle
            key={`dot-${index}`}
            className="chart-last"
            cx={sx(segment[0].x)}
            cy={sy(segment[0].y)}
            r={compact ? 2 : 3}
          />
        ),
      )}
      <circle className="chart-last" cx={sx(last.x)} cy={sy(last.y)} r={compact ? 2 : 3} />
    </svg>
  );

  if (compact) return svg;

  return (
    <figure className="chart">
      <figcaption>
        {label} {unit ? <span className="sub">({unit})</span> : null}
      </figcaption>
      <p className="chart-stats">
        <span>
          Terakhir <b>{last.y.toFixed(digits)}</b>
          {unit ? ` ${unit}` : ''}
        </span>
        <span>
          Min <b>{rawMin.toFixed(digits)}</b>
        </span>
        <span>
          Rata-rata <b>{average.toFixed(digits)}</b>
        </span>
        <span>
          Maks <b>{rawMax.toFixed(digits)}</b>
        </span>
      </p>
      <div className="chart-plot">
        <div className="chart-ylabels" style={{ height: chartHeight }} aria-hidden="true">
          {ticks.map((tick) => (
            <span key={`tick-${tick}`} style={{ top: `${sy(tick)}px` }}>
              {tickLabel(tick, step)}
            </span>
          ))}
        </div>
        <div className="chart-canvas">{svg}</div>
      </div>
    </figure>
  );
}
