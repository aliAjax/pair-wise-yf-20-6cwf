// 业务文件三：点位界面
// 场地平面图（SVG）：只读的禁放区与四个发射点、按风向算出的弹道/爆开范围，
// 以及通过校验后才允许播放的逐发预演。所有几何口径都来自 rules.ts。

import { useMemo } from "react";
import {
  FIELD,
  LAUNCH_POINTS,
  NO_FIRE_ZONES,
  type BurstInfo,
  type FireNode,
  type Wind,
  bearingUnit,
  formatTimecode,
} from "./rules";

const W = FIELD.width;
const H = FIELD.height;
const PAD = 26;
const VB_W = W + PAD * 2;
const VB_H = H + PAD * 2;

/** 数学坐标（北向上）转 SVG 坐标（y 向下） */
function sx(x: number): number {
  return PAD + x;
}
function sy(y: number): number {
  return PAD + H - y;
}

const POINT_COLORS: Record<string, string> = {
  "LP-1": "#38bdf8",
  "LP-2": "#a78bfa",
  "LP-3": "#34d399",
  "LP-4": "#fb923c",
};

interface PointMapProps {
  nodes: readonly FireNode[];
  bursts: readonly BurstInfo[];
  violatingNodeIds: ReadonlySet<string>;
  wind: Wind;
  selectedPointId: string;
  onSelectPoint: (id: string) => void;
  /** 预演播放头（秒）；null 表示未生成预演 */
  rehearsalTime: number | null;
  playing: boolean;
}

export default function PointMap({
  nodes,
  bursts,
  violatingNodeIds,
  wind,
  selectedPointId,
  onSelectPoint,
  rehearsalTime,
  playing,
}: PointMapProps) {
  const burstById = useMemo(
    () => new Map(bursts.map((b) => [b.nodeId, b])),
    [bursts]
  );

  const windVec = bearingUnit(wind.dirDeg);

  // 预演可见性：飞行中弹丸沿弹道推进；爆开后扩散圈维持约 1.6s 余韵
  const view = useMemo(() => {
    if (rehearsalTime === null) return null;
    const t = rehearsalTime;
    return nodes.map((n) => {
      const b = burstById.get(n.id);
      if (!b) return { node: n, phase: "invalid" as const };
      const flight = Math.max(0.001, n.flightSec);
      if (t < n.igniteAt) return { node: n, phase: "idle" as const };
      if (t < b.burstAt) {
        return {
          node: n,
          phase: "flying" as const,
          progress: Math.min(1, (t - n.igniteAt) / flight),
        };
      }
      const since = t - b.burstAt;
      if (since < 1.6) {
        return {
          node: n,
          phase: "burst" as const,
          progress: Math.min(1, since / 1.6),
        };
      }
      return { node: n, phase: "done" as const };
    });
  }, [rehearsalTime, nodes, burstById]);

  const activeIds = new Set<string>();
  if (view) {
    for (const v of view) {
      if (v.phase === "flying" || v.phase === "burst") activeIds.add(v.node.id);
    }
  }

  return (
    <div className="map-wrap">
      <svg
        className="point-map"
        viewBox={`0 0 ${VB_W} ${VB_H}`}
        role="img"
        aria-label="燃放点位平面图"
      >
        <defs>
          <pattern id="nofire-hatch" width="8" height="8" patternUnits="userSpaceOnUse">
            <rect width="8" height="8" fill="rgba(220,38,38,0.10)" />
            <path d="M-2 8 L8 -2 M2 10 L10 2" stroke="#dc2626" strokeWidth="1" />
          </pattern>
        </defs>

        {/* 场地边框 */}
        <rect
          x={PAD}
          y={PAD}
          width={W}
          height={H}
          rx={6}
          className="field-frame"
        />

        {/* 北向标 */}
        <g transform={`translate(${PAD + W / 2}, 12)`}>
          <path d="M0 8 L-5 0 L0 -4 L5 0 Z" fill="#172033" />
          <text x="9" y="4" className="map-label">
            N
          </text>
        </g>

        {/* 临时禁放区（原脚本只读） */}
        {NO_FIRE_ZONES.map((z) => (
          <g key={z.id}>
            <circle
              cx={sx(z.center.x)}
              cy={sy(z.center.y)}
              r={z.radius}
              fill="url(#nofire-hatch)"
              stroke="#dc2626"
              strokeDasharray="5 3"
            />
            <text
              x={sx(z.center.x)}
              y={sy(z.center.y) + 3.5}
              textAnchor="middle"
              className="zone-label"
            >
              {z.name}
            </text>
          </g>
        ))}

        {/* 弹道（细虚线） */}
        {bursts.map((b) => {
          const bad = violatingNodeIds.has(b.nodeId);
          const dim = view !== null && !activeIds.has(b.nodeId);
          return (
            <line
              key={`path-${b.nodeId}`}
              x1={sx(b.path[0].x)}
              y1={sy(b.path[0].y)}
              x2={sx(b.flightEnd.x)}
              y2={sy(b.flightEnd.y)}
              className={bad ? "trajectory bad" : "trajectory"}
              style={{ opacity: dim ? 0.18 : 0.85 }}
            />
          );
        })}

        {/* 爆开范围（含风偏后的圆心与扩散半径） */}
        {bursts.map((b) => {
          const bad = violatingNodeIds.has(b.nodeId);
          let r = b.radius;
          let opacity = bad ? 0.28 : 0.16;
          let strokeOpacity = 0.9;
          if (view) {
            const st = view.find((v) => v.node.id === b.nodeId);
            if (!st || st.phase === "idle" || st.phase === "invalid" || st.phase === "done") {
              opacity = 0.05;
              strokeOpacity = 0.25;
            } else if (st.phase === "burst") {
              r = b.radius * (0.35 + 0.65 * st.progress);
              opacity = 0.32 * (1 - st.progress * 0.4);
            }
          }
          const pointId = burstNodePoint(nodes, b.nodeId);
          return (
            <circle
              key={`burst-${b.nodeId}`}
              cx={sx(b.center.x)}
              cy={sy(b.center.y)}
              r={r}
              className={bad ? "burst bad" : "burst"}
              fill={(pointId && POINT_COLORS[pointId]) || "#60a5fa"}
              fillOpacity={opacity}
              strokeOpacity={strokeOpacity}
            />
          );
        })}

        {/* 预演飞行中的弹丸 */}
        {view?.map((v) => {
          if (v.phase !== "flying") return null;
          const b = burstById.get(v.node.id);
          if (!b) return null;
          const x =
            b.path[0].x + (b.flightEnd.x - b.path[0].x) * (v.progress ?? 0);
          const y =
            b.path[0].y + (b.flightEnd.y - b.path[0].y) * (v.progress ?? 0);
          return (
            <circle
              key={`shell-${v.node.id}`}
              cx={sx(x)}
              cy={sy(y)}
              r={3.2}
              className="shell"
              fill={POINT_COLORS[v.node.pointId] ?? "#fde68a"}
            />
          );
        })}

        {/* 发射点（原脚本只读，可点选） */}
        {LAUNCH_POINTS.map((p) => {
          const selected = p.id === selectedPointId;
          const count = nodes.filter((n) => n.pointId === p.id).length;
          return (
            <g
              key={p.id}
              className="launch-point"
              onClick={() => onSelectPoint(p.id)}
              role="button"
              aria-label={`${p.name}，登记 ${count} 发`}
            >
              {selected && (
                <circle
                  cx={sx(p.pos.x)}
                  cy={sy(p.pos.y)}
                  r={11}
                  className="point-ring"
                />
              )}
              <rect
                x={sx(p.pos.x) - 6}
                y={sy(p.pos.y) - 6}
                width={12}
                height={12}
                rx={2}
                fill={POINT_COLORS[p.id]}
                stroke="#0b1220"
                strokeWidth={1.2}
              />
              <text
                x={sx(p.pos.x) + 10}
                y={sy(p.pos.y) - 7}
                className="map-label point-label"
              >
                {p.id} {p.name}
                <tspan className="point-count">（{count}发）</tspan>
              </text>
            </g>
          );
        })}

        {/* 风向风级 HUD */}
        <g transform={`translate(${VB_W - PAD - 8}, ${VB_H - PAD - 6})`}>
          <line
            x1={-windVec.x * 26}
            y1={windVec.y * 26}
            x2={windVec.x * 26}
            y2={-windVec.y * 26}
            className="wind-arrow"
            markerEnd="url(#wind-head)"
          />
          <defs>
            <marker
              id="wind-head"
              markerWidth="7"
              markerHeight="7"
              refX="5.5"
              refY="3.5"
              orient="auto"
            >
              <path d="M0 0 L7 3.5 L0 7 Z" fill="#0ea5e9" />
            </marker>
          </defs>
          <text x={-windVec.x * 26 - 4} y={windVec.y * 26 + 14} textAnchor="end" className="wind-label">
            风 {wind.dirDeg.toFixed(0)}° · {wind.speed.toFixed(1)}m/s（箭头为吹向）
          </text>
        </g>
      </svg>

      <ul className="map-legend">
        {LAUNCH_POINTS.map((p) => (
          <li key={p.id}>
            <i style={{ background: POINT_COLORS[p.id] }} />
            {p.id} {p.name}
          </li>
        ))}
        <li>
          <i className="legend-zone" />
          临时禁放区（只读）
        </li>
        {playing && <li className="legend-clock">▶ 预演 {formatTimecode(rehearsalTime ?? 0)}</li>}
      </ul>
    </div>
  );
}

function burstNodePoint(nodes: readonly FireNode[], nodeId: string): string | null {
  return nodes.find((n) => n.id === nodeId)?.pointId ?? null;
}

export { POINT_COLORS };
