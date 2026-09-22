/**
 * 规则文件：联锁校验与爆开范围计算。
 * 只放领域逻辑，不碰界面与存储。
 */

export interface LaunchPoint {
  id: string;
  name: string;
  x: number; // 场地平面坐标（米），x 向东，y 向北
  y: number;
}

export interface Segment {
  id: string;
  name: string;
  start: number; // 秒，相对节目开始
  end: number;
}

export interface NoFireZone {
  id: string;
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  note: string;
}

export interface Wind {
  direction: number; // 风向去向角，度，0=正北，顺时针
  speed: number; // 米/秒
}

export interface Shot {
  id: string;
  pointId: string;
  azimuth: number; // 方位角，度，0=正北，顺时针
  fireAt: number; // 点火时刻，秒
  flight: number; // 飞行时长，秒
  spread: number; // 扩散半径，米
}

export interface Burst {
  cx: number;
  cy: number;
  radius: number;
}

export interface Violation {
  shotId: string;
  label: string;
  reasons: string[];
}

/* ---------- 预置数据 ---------- */

export const MAP_W = 720;
export const MAP_H = 320;

/** 弹丸水平分速度（米/秒），用于由飞行时长推算爆点水平距离 */
export const SHELL_SPEED = 40;
/** 同点位两发最小间隔（秒） */
export const MIN_INTERVAL = 1;

export const LAUNCH_POINTS: LaunchPoint[] = [
  { id: "P1", name: "一号位 · 西侧", x: 90, y: 56 },
  { id: "P2", name: "二号位 · 中西", x: 270, y: 56 },
  { id: "P3", name: "三号位 · 中东", x: 450, y: 56 },
  { id: "P4", name: "四号位 · 东侧", x: 630, y: 56 },
];

export const SEGMENTS: Segment[] = [
  { id: "S1", name: "序章 · 迎宾", start: 0, end: 60 },
  { id: "S2", name: "展开 · 叙事", start: 60, end: 150 },
  { id: "S3", name: "高潮 · 谢幕", start: 150, end: 240 },
];

export const SHOW_END = SEGMENTS[SEGMENTS.length - 1].end;

export const NO_FIRE_ZONES: NoFireZone[] = [
  { id: "Z1", name: "观众临时候场区", x: 170, y: 170, w: 150, h: 100, note: "演出期间全程禁放" },
  { id: "Z2", name: "设备临时堆放区", x: 480, y: 190, w: 130, h: 80, note: "撤场前禁止落火" },
];

/* ---------- 工具 ---------- */

export function formatTime(t: number): string {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${String(m).padStart(2, "0")}:${s.toFixed(1).padStart(4, "0")}`;
}

export function pointOf(shot: Shot): LaunchPoint {
  return LAUNCH_POINTS.find((p) => p.id === shot.pointId) ?? LAUNCH_POINTS[0];
}

export function shotLabel(shot: Shot): string {
  return `${shot.pointId} · ${formatTime(shot.fireAt)}`;
}

/* ---------- 爆开范围 ---------- */

/** 按风向推算爆开圆：弹道位移 + 风飘移，半径为扩散半径 */
export function computeBurst(shot: Shot, wind: Wind): Burst {
  const point = pointOf(shot);
  const a = (shot.azimuth * Math.PI) / 180;
  const w = (wind.direction * Math.PI) / 180;
  const dist = shot.flight * SHELL_SPEED;
  return {
    cx: point.x + Math.sin(a) * dist + Math.sin(w) * wind.speed * shot.flight,
    cy: point.y + Math.cos(a) * dist + Math.cos(w) * wind.speed * shot.flight,
    radius: shot.spread,
  };
}

export function burstHitsZone(burst: Burst, zone: NoFireZone): boolean {
  const nx = Math.max(zone.x, Math.min(burst.cx, zone.x + zone.w));
  const ny = Math.max(zone.y, Math.min(burst.cy, zone.y + zone.h));
  const dx = burst.cx - nx;
  const dy = burst.cy - ny;
  return dx * dx + dy * dy < burst.radius * burst.radius;
}

/* ---------- 联锁校验 ---------- */

/** 单发校验：context 为同场其余已确认节点 */
export function checkShot(shot: Shot, context: Shot[], wind: Wind): string[] {
  const reasons: string[] = [];

  if (shot.fireAt > SHOW_END) {
    reasons.push(`点火时刻 ${formatTime(shot.fireAt)} 越过节目结束 ${formatTime(SHOW_END)}`);
  }

  const samePoint = context
    .filter((s) => s.id !== shot.id && s.pointId === shot.pointId)
    .sort((a, b) => a.fireAt - b.fireAt);
  const prev = samePoint.filter((s) => s.fireAt <= shot.fireAt).pop();
  const next = samePoint.find((s) => s.fireAt > shot.fireAt);
  if (prev && shot.fireAt - prev.fireAt < MIN_INTERVAL) {
    reasons.push(`与同点位前一发 ${formatTime(prev.fireAt)} 间隔不足 ${MIN_INTERVAL} 秒`);
  }
  if (next && next.fireAt - shot.fireAt < MIN_INTERVAL) {
    reasons.push(`与同点位后一发 ${formatTime(next.fireAt)} 间隔不足 ${MIN_INTERVAL} 秒`);
  }

  const burst = computeBurst(shot, wind);
  for (const zone of NO_FIRE_ZONES) {
    if (burstHitsZone(burst, zone)) {
      reasons.push(`爆开范围侵入${zone.name}`);
    }
  }
  return reasons;
}

/**
 * 整批校验：任一待发节点违规则整批拒绝，调用方不得改动原脚本。
 * 批内按点火时刻排序后逐发校验，批内先发对后发同样构成间隔约束。
 */
export function validateBatch(drafts: Shot[], accepted: Shot[], wind: Wind): Violation[] {
  const context = [...accepted];
  const violations: Violation[] = [];
  for (const shot of [...drafts].sort((a, b) => a.fireAt - b.fireAt)) {
    const reasons = checkShot(shot, context, wind);
    if (reasons.length > 0) {
      violations.push({ shotId: shot.id, label: shotLabel(shot), reasons });
    }
    context.push(shot);
  }
  return violations;
}

/**
 * 增量重算：调整某发参数（如方位角）后，只重算该点位自该时刻起的后续节点。
 */
export function revalidatePointFrom(
  shots: Shot[],
  pointId: string,
  fromTime: number,
  wind: Wind
): Violation[] {
  return shots
    .filter((s) => s.pointId === pointId && s.fireAt >= fromTime)
    .sort((a, b) => a.fireAt - b.fireAt)
    .map((shot) => ({ shot, reasons: checkShot(shot, shots, wind) }))
    .filter(({ reasons }) => reasons.length > 0)
    .map(({ shot, reasons }) => ({ shotId: shot.id, label: shotLabel(shot), reasons }));
}

/* ---------- 预演 ---------- */

export interface PreviewRow extends Shot {
  pointName: string;
  burst: Burst;
  segment: Segment | null;
}

/** 仅在整批/增量校验通过后调用，生成时间轴预演 */
export function buildPreview(shots: Shot[], wind: Wind): PreviewRow[] {
  return [...shots]
    .sort((a, b) => a.fireAt - b.fireAt)
    .map((shot) => ({
      ...shot,
      pointName: pointOf(shot).name,
      burst: computeBurst(shot, wind),
      segment: SEGMENTS.find((seg) => shot.fireAt >= seg.start && shot.fireAt < seg.end) ?? null,
    }));
}
