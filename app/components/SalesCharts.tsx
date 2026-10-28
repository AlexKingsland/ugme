/**
 * Sales charts for the Analytics page — plain SVG, no chart library.
 * Colors: categorical slots 1 (blue) + 2 (orange) of the validated reference palette.
 */
import * as React from "react";

export const DIRECT_COLOR = "#2a78d6";
export const INFLUENCED_COLOR = "#eb6834";
const GRID = "var(--p-color-border-secondary, #e3e3e3)";
const AXIS_TEXT = "var(--p-color-text-secondary, #616161)";

export type ChartPoint = { date: string; direct: number; influenced: number; total: number };

function useWidth<T extends HTMLElement>(): [React.RefObject<T>, number] {
  const ref = React.useRef<T>(null);
  const [w, setW] = React.useState(640);
  React.useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(280, Math.floor(e.contentRect.width))));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

/** Friendly axis: ~4 steps of 1, 2, 2.5 or 5 × 10^n, max rounded up to a step. */
function niceScale(v: number, cap = Infinity): { max: number; ticks: number[] } {
  const raw = Math.max(v, 1e-9) / 4;
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = ([1, 2, 2.5, 5, 10].find((m) => m * p >= raw) || 10) * p;
  const max = Math.min(cap, Math.max(step, Math.ceil(v / step - 1e-9) * step));
  const ticks: number[] = [];
  for (let t = 0; t <= max + 1e-9; t += step) ticks.push(Math.round(t * 1e6) / 1e6);
  return { max, ticks };
}

function shortDate(iso: string) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
}

function Legend({ items }: { items: { label: string; color: string }[] }) {
  return (
    <div style={{ display: "flex", gap: 16, flexWrap: "wrap", fontSize: 12, color: AXIS_TEXT }}>
      {items.map((i) => (
        <span key={i.label} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          <span style={{ width: 10, height: 10, borderRadius: 3, background: i.color }} />
          {i.label}
        </span>
      ))}
    </div>
  );
}

/** Sits beside the hovered x (right of it, or left near the right edge) so it never hides the mark. */
function Tooltip({ x, y, width, children }: { x: number; y: number; width: number; children: React.ReactNode }) {
  const W = 180;
  const left = x + 16 + W <= width ? x + 16 : Math.max(0, x - 16 - W);
  return (
    <div
      style={{
        position: "absolute", left, top: Math.max(0, Math.min(y, HEIGHT - 60)), transform: "translateY(-50%)", width: W,
        background: "var(--p-color-bg-surface, #fff)", border: "1px solid var(--p-color-border, #ccc)",
        borderRadius: 8, boxShadow: "0 4px 12px rgba(0,0,0,.12)", padding: "8px 10px", fontSize: 12,
        pointerEvents: "none", zIndex: 2, color: "var(--p-color-text, #303030)",
      }}
    >
      {children}
    </div>
  );
}

function Row({ color, label, value }: { color?: string; label: string; value: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 8, lineHeight: "18px" }}>
      <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
        {color && <span style={{ width: 8, height: 8, borderRadius: 2, background: color }} />}
        {label}
      </span>
      <strong style={{ fontWeight: 600 }}>{value}</strong>
    </div>
  );
}

const PAD = { top: 12, right: 8, bottom: 26, left: 56 };
const HEIGHT = 240;

function xLabelEvery(n: number, w: number) {
  const fit = Math.max(2, Math.floor((w - PAD.left - PAD.right) / 64));
  return Math.max(1, Math.ceil(n / fit));
}

/** Daily wall revenue — stacked bars: direct (bottom) + influenced (top). */
export function RevenueChart({ data, money }: { data: ChartPoint[]; money: (cents: number) => string }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = React.useState<number | null>(null);
  const plotW = width - PAD.left - PAD.right;
  const plotH = HEIGHT - PAD.top - PAD.bottom;
  // money in cents: keep steps on whole currency units
  const { max, ticks } = niceScale(Math.max(...data.map((d) => d.direct + d.influenced), 100) / 100);
  const maxC = max * 100;
  const slot = plotW / Math.max(1, data.length);
  const barW = Math.max(2, Math.min(28, slot * 0.7));
  const y = (v: number) => PAD.top + plotH - (v / maxC) * plotH;
  const every = xLabelEvery(data.length, width);

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <Legend items={[{ label: "Direct (added from the wall)", color: DIRECT_COLOR }, { label: "Influenced (watched, then bought)", color: INFLUENCED_COLOR }]} />
      <svg width={width} height={HEIGHT} role="img" aria-label="Daily Social Wall revenue, direct and influenced" style={{ display: "block", marginTop: 8 }}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={PAD.left} x2={width - PAD.right} y1={y(t * 100)} y2={y(t * 100)} stroke={GRID} strokeWidth={1} />
            <text x={PAD.left - 8} y={y(t * 100)} dy="0.32em" textAnchor="end" fontSize={11} fill={AXIS_TEXT}>{money(t * 100)}</text>
          </g>
        ))}
        {data.map((d, i) => {
          const cx = PAD.left + slot * i + slot / 2;
          const x = cx - barW / 2;
          const base = y(0);
          const hD = base - y(d.direct);
          const hI = base - y(d.influenced);
          const gap = hD > 0 && hI > 0 ? 2 : 0; // 2px surface gap between stacked segments
          const r = Math.min(4, barW / 2);
          return (
            <g key={d.date}>
              {hover === i && <rect x={PAD.left + slot * i} y={PAD.top} width={slot} height={plotH} fill="var(--p-color-bg-surface-hover, #f3f3f3)" />}
              {hD > 0 && (
                <path
                  d={hI > 0 ? `M${x},${base}V${base - hD}H${x + barW}V${base}Z` : roundedTop(x, base - hD, barW, hD, r)}
                  fill={DIRECT_COLOR}
                />
              )}
              {hI > 0 && <path d={roundedTop(x, base - hD - gap - hI, barW, hI, r)} fill={INFLUENCED_COLOR} />}
              {i % every === 0 && (
                <text x={cx} y={HEIGHT - 8} textAnchor="middle" fontSize={11} fill={AXIS_TEXT}>{shortDate(d.date)}</text>
              )}
              <rect
                x={PAD.left + slot * i} y={PAD.top} width={slot} height={plotH} fill="transparent"
                onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}
              />
            </g>
          );
        })}
        <line x1={PAD.left} x2={width - PAD.right} y1={y(0)} y2={y(0)} stroke="var(--p-color-border, #8a8a8a)" strokeWidth={1} />
      </svg>
      {hover !== null && data[hover] && (
        <Tooltip x={PAD.left + slot * hover + slot / 2} y={PAD.top + plotH / 2 + 26} width={width}>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>{shortDate(data[hover].date)}</div>
          <Row color={DIRECT_COLOR} label="Direct" value={money(data[hover].direct)} />
          <Row color={INFLUENCED_COLOR} label="Influenced" value={money(data[hover].influenced)} />
          <Row label="Store revenue" value={money(data[hover].total)} />
        </Tooltip>
      )}
    </div>
  );
}

function roundedTop(x: number, top: number, w: number, h: number, r: number) {
  const rr = Math.min(r, h);
  return `M${x},${top + h}V${top + rr}Q${x},${top} ${x + rr},${top}H${x + w - rr}Q${x + w},${top} ${x + w},${top + rr}V${top + h}Z`;
}

/** Wall revenue as a share of store revenue per day — single line, gaps on days with no sales. */
export function ShareChart({ data, money }: { data: ChartPoint[]; money: (cents: number) => string }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = React.useState<number | null>(null);
  const plotW = width - PAD.left - PAD.right;
  const plotH = HEIGHT - PAD.top - PAD.bottom;
  const pct = data.map((d) => (d.total > 0 ? ((d.direct + d.influenced) / d.total) * 100 : null));
  const { max, ticks } = niceScale(Math.max(...pct.map((p) => p ?? 0), 1), 100);
  const step = data.length > 1 ? plotW / (data.length - 1) : 0;
  const xAt = (i: number) => PAD.left + (data.length > 1 ? step * i : plotW / 2);
  const y = (v: number) => PAD.top + plotH - (v / max) * plotH;
  const every = xLabelEvery(data.length, width);

  // Path with breaks where a day had no store revenue
  let d = "";
  let pen = false;
  pct.forEach((p, i) => {
    if (p === null) { pen = false; return; }
    d += `${pen ? "L" : "M"}${xAt(i)},${y(p)}`;
    pen = true;
  });

  const onMove = (e: React.MouseEvent<SVGRectElement>) => {
    const box = (e.currentTarget as SVGRectElement).getBoundingClientRect();
    const i = Math.round((e.clientX - box.left) / (step || 1));
    setHover(Math.max(0, Math.min(data.length - 1, i)));
  };
  const fmtPct = (v: number) => `${v >= 10 || v === 0 ? v.toFixed(0) : v.toFixed(1)}%`;

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <svg width={width} height={HEIGHT} role="img" aria-label="Social Wall revenue as a percent of store revenue, per day" style={{ display: "block" }}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={PAD.left} x2={width - PAD.right} y1={y(t)} y2={y(t)} stroke={GRID} strokeWidth={1} />
            <text x={PAD.left - 8} y={y(t)} dy="0.32em" textAnchor="end" fontSize={11} fill={AXIS_TEXT}>{fmtPct(t)}</text>
          </g>
        ))}
        {data.map((p, i) =>
          i % every === 0 ? (
            <text key={p.date} x={xAt(i)} y={HEIGHT - 8} textAnchor="middle" fontSize={11} fill={AXIS_TEXT}>{shortDate(p.date)}</text>
          ) : null,
        )}
        <path d={d} fill="none" stroke={DIRECT_COLOR} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        {/* Isolated days (no neighbours) still need a visible mark */}
        {pct.map((p, i) =>
          p !== null && pct[i - 1] == null && pct[i + 1] == null ? <circle key={i} cx={xAt(i)} cy={y(p)} r={4} fill={DIRECT_COLOR} /> : null,
        )}
        {hover !== null && (
          <g>
            <line x1={xAt(hover)} x2={xAt(hover)} y1={PAD.top} y2={PAD.top + plotH} stroke="var(--p-color-border, #8a8a8a)" strokeDasharray="3 3" />
            {pct[hover] !== null && <circle cx={xAt(hover)} cy={y(pct[hover]!)} r={5} fill={DIRECT_COLOR} stroke="var(--p-color-bg-surface, #fff)" strokeWidth={2} />}
          </g>
        )}
        <rect x={PAD.left} y={PAD.top} width={plotW} height={plotH} fill="transparent" onMouseMove={onMove} onMouseLeave={() => setHover(null)} />
      </svg>
      {hover !== null && data[hover] && (
        <Tooltip x={xAt(hover)} y={(pct[hover] !== null ? y(pct[hover]!) : PAD.top + plotH / 2)} width={width}>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>{shortDate(data[hover].date)}</div>
          <Row label="Share of revenue" value={pct[hover] === null ? "No sales" : fmtPct(pct[hover]!)} />
          <Row label="Wall revenue" value={money(data[hover].direct + data[hover].influenced)} />
          <Row label="Store revenue" value={money(data[hover].total)} />
        </Tooltip>
      )}
    </div>
  );
}
