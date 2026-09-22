/**
 * 点位界面文件：发射场平面图。
 * 展示发射点、临时禁放区、已确认与待发节点的爆开范围，支持点选发射点。
 */

import {
  LAUNCH_POINTS,
  MAP_H,
  MAP_W,
  NO_FIRE_ZONES,
  computeBurst,
  type Shot,
  type Wind,
} from "./rules";

interface PointMapProps {
  shots: Shot[];
  drafts: Shot[];
  wind: Wind;
  selectedPointId: string;
  violationIds: Set<string>;
  onSelectPoint: (pointId: string) => void;
}

/** 场地坐标（y 向北）转 SVG 坐标（y 向下） */
function toSvgY(y: number): number {
  return MAP_H - y;
}

export function PointMap({
  shots,
  drafts,
  wind,
  selectedPointId,
  violationIds,
  onSelectPoint,
}: PointMapProps) {
  const windRad = (wind.direction * Math.PI) / 180;
  const arrowLen = 26 + wind.speed * 4;

  return (
    <svg
      className="point-map"
      viewBox={`0 0 ${MAP_W} ${MAP_H}`}
      role="img"
      aria-label="发射场平面图"
    >
      <rect x={0} y={0} width={MAP_W} height={MAP_H} className="map-ground" />
      {Array.from({ length: 7 }, (_, i) => (
        <line
          key={`v${i}`}
          x1={(i + 1) * 90}
          y1={0}
          x2={(i + 1) * 90}
          y2={MAP_H}
          className="map-grid"
        />
      ))}
      {Array.from({ length: 3 }, (_, i) => (
        <line
          key={`h${i}`}
          x1={0}
          y1={(i + 1) * 80}
          x2={MAP_W}
          y2={(i + 1) * 80}
          className="map-grid"
        />
      ))}

      {/* 临时禁放区 */}
      {NO_FIRE_ZONES.map((zone) => (
        <g key={zone.id}>
          <rect
            x={zone.x}
            y={toSvgY(zone.y + zone.h)}
            width={zone.w}
            height={zone.h}
            className="map-zone"
          />
          <text x={zone.x + 8} y={toSvgY(zone.y + zone.h) + 18} className="map-zone-label">
            ⛔ {zone.name}
          </text>
          <text x={zone.x + 8} y={toSvgY(zone.y + zone.h) + 34} className="map-zone-note">
            {zone.note}
          </text>
        </g>
      ))}

      {/* 已确认节点爆开范围 */}
      {shots.map((shot) => {
        const b = computeBurst(shot, wind);
        const bad = violationIds.has(shot.id);
        return (
          <circle
            key={shot.id}
            cx={b.cx}
            cy={toSvgY(b.cy)}
            r={b.radius}
            className={bad ? "map-burst map-burst-bad" : "map-burst"}
          />
        );
      })}

      {/* 待发节点爆开范围（虚线） */}
      {drafts.map((shot) => {
        const b = computeBurst(shot, wind);
        const bad = violationIds.has(shot.id);
        return (
          <circle
            key={shot.id}
            cx={b.cx}
            cy={toSvgY(b.cy)}
            r={b.radius}
            className={bad ? "map-burst-draft map-burst-bad" : "map-burst-draft"}
          />
        );
      })}

      {/* 发射点 */}
      {LAUNCH_POINTS.map((point) => (
        <g
          key={point.id}
          className={
            point.id === selectedPointId ? "map-point map-point-active" : "map-point"
          }
          onClick={() => onSelectPoint(point.id)}
        >
          <circle cx={point.x} cy={toSvgY(point.y)} r={12} />
          <text x={point.x} y={toSvgY(point.y) + 4} className="map-point-id">
            {point.id}
          </text>
          <text x={point.x} y={toSvgY(point.y) + 30} className="map-point-name">
            {point.name}
          </text>
        </g>
      ))}

      {/* 风向指示 */}
      <g className="map-wind">
        <line
          x1={MAP_W - 60}
          y1={40}
          x2={MAP_W - 60 + Math.sin(windRad) * arrowLen}
          y2={40 - Math.cos(windRad) * arrowLen}
          markerEnd="url(#wind-arrow)"
        />
        <text x={MAP_W - 60} y={24}>
          风 {wind.direction}° · {wind.speed}m/s
        </text>
      </g>
      <defs>
        <marker
          id="wind-arrow"
          viewBox="0 0 10 10"
          refX="9"
          refY="5"
          markerWidth="7"
          markerHeight="7"
          orient="auto-start-reverse"
        >
          <path d="M 0 0 L 10 5 L 0 10 z" />
        </marker>
      </defs>
    </svg>
  );
}
