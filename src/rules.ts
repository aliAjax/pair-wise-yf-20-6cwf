// 业务文件一：联锁规则引擎
// 所有几何计算、节目时段校验、禁放区侵入判定与增量重算都集中在这里，纯函数、可测试。

// ---------- 基础类型 ----------

export interface Vec {
  x: number; // 东向，单位：米
  y: number; // 北向，单位：米
}

/** 预设发射点（原脚本，只读） */
export interface LaunchPoint {
  id: string;
  name: string;
  pos: Vec;
}

/** 预设节目段（原脚本，只读；起止时刻均为相对开场的秒数） */
export interface ProgramSegment {
  id: string;
  name: string;
  start: number;
  end: number;
}

/** 预设临时禁放区（原脚本，只读；圆形区域） */
export interface NoFireZone {
  id: string;
  name: string;
  center: Vec;
  radius: number;
}

/** 风向设置：罗盘角，风朝该方向吹（0=北、90=东、180=南、270=西） */
export interface Wind {
  dirDeg: number;
  speed: number; // m/s
}

/** 一次点火登记 */
export interface FireNode {
  id: string;
  pointId: string;
  segmentId: string;
  azimuthDeg: number; // 发射方位角（罗盘角）
  igniteAt: number; // 点火时刻（秒）
  flightSec: number; // 飞行时长（秒）
  spreadRadius: number; // 扩散半径（米）
}

export type ViolationKind =
  | "segmentBoundary"
  | "shotGap"
  | "noFireIntrusion"
  | "badInput";

export interface Violation {
  kind: ViolationKind;
  nodeId: string;
  message: string;
}

export interface BurstInfo {
  nodeId: string;
  /** 弹丸水平飞行终点（落点圆心，未受风偏） */
  flightEnd: Vec;
  /** 实际爆开圆心（含风偏） */
  center: Vec;
  radius: number;
  /** 弹丸离地的飞行轨迹：发射点 → 飞行终点 */
  path: [Vec, Vec];
  burstAt: number; // 爆开时刻 = 点火 + 飞行
}

export interface EvalResult {
  violations: Violation[];
  bursts: BurstInfo[]; // 仅为输入合法的节点生成
}

// ---------- 常量 ----------

/** 场地为 300m（东-西）× 220m（南-北），坐标原点在场地西南角 */
export const FIELD = { width: 300, height: 220 };
/** 弹丸水平飞行速度（模型常数，米/秒） */
export const FLIGHT_SPEED = 20;
/** 同一点位相邻两发的最小点火间隔（秒） */
export const MIN_SHOT_GAP = 1;

// ---------- 预设原脚本（不可编辑） ----------

export const LAUNCH_POINTS: readonly LaunchPoint[] = [
  { id: "LP-1", name: "东台", pos: { x: 60, y: 55 } },
  { id: "LP-2", name: "西台", pos: { x: 60, y: 165 } },
  { id: "LP-3", name: "北岸地", pos: { x: 240, y: 178 } },
  { id: "LP-4", name: "南岸地", pos: { x: 240, y: 42 } },
];

export const SEGMENTS: readonly ProgramSegment[] = [
  { id: "SEG-1", name: "序幕 Intro", start: 0, end: 60 },
  { id: "SEG-2", name: "主章 Chorus", start: 60, end: 150 },
  { id: "SEG-3", name: "终章 Finale", start: 150, end: 240 },
];

export const NO_FIRE_ZONES: readonly NoFireZone[] = [
  { id: "NF-1", name: "临时观礼台区", center: { x: 150, y: 110 }, radius: 26 },
  { id: "NF-2", name: "器材堆放区", center: { x: 205, y: 55 }, radius: 18 },
];

export const DEFAULT_WIND: Wind = { dirDeg: 120, speed: 3.5 };

// ---------- 工具 ----------

const RAD = Math.PI / 180;

/** 罗盘角对应的单位向量：0°=北(0,1)，90°=东(1,0) */
export function bearingUnit(deg: number): Vec {
  const d = RAD * deg;
  return { x: Math.sin(d), y: Math.cos(d) };
}

/** 解析 mm:ss.mmm 时刻文本为秒；非法返回 null */
export function parseTimecode(text: string): number | null {
  const m = /^(\d{1,3}):([0-5]\d)(?:[.,](\d{1,3}))?$/.exec(text.trim());
  if (!m) return null;
  const min = Number(m[1]);
  const sec = Number(m[2]);
  const frac = m[3] ? Number(m[3].padEnd(3, "0")) / 1000 : 0;
  return min * 60 + sec + frac;
}

/** 秒格式化为 mm:ss.mmm（毫秒四舍五入，整秒自动进位） */
export function formatTimecode(sec: number): string {
  const v = Math.round(Math.max(0, sec) * 1000) / 1000;
  const mm = Math.floor(v / 60);
  const ss = Math.floor(v % 60);
  const ms = Math.round((v - Math.floor(v)) * 1000);
  return `${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}.${String(
    ms
  ).padStart(3, "0")}`;
}

export function getPoint(id: string): LaunchPoint {
  const p = LAUNCH_POINTS.find((p) => p.id === id);
  if (!p) throw new Error(`未知发射点：${id}`);
  return p;
}

export function getSegment(id: string): ProgramSegment {
  const s = SEGMENTS.find((s) => s.id === id);
  if (!s) throw new Error(`未知节目段：${id}`);
  return s;
}

/** 单个节点的几何与爆开信息；输入字段不合法时返回 null */
export function computeBurst(node: FireNode, wind: Wind): BurstInfo | null {
  if (
    !Number.isFinite(node.azimuthDeg) ||
    !Number.isFinite(node.igniteAt) ||
    !Number.isFinite(node.flightSec) ||
    !Number.isFinite(node.spreadRadius) ||
    node.igniteAt < 0 ||
    node.flightSec <= 0 ||
    node.spreadRadius <= 0
  ) {
    return null;
  }

  const origin = getPoint(node.pointId).pos;
  const dir = bearingUnit(node.azimuthDeg);
  const reach = FLIGHT_SPEED * node.flightSec;
  const flightEnd: Vec = {
    x: origin.x + dir.x * reach,
    y: origin.y + dir.y * reach,
  };

  // 风偏：弹丸在飞行全程受顺风推移
  const windVec = bearingUnit(wind.dirDeg);
  const drift = wind.speed * node.flightSec;
  const center: Vec = {
    x: flightEnd.x + windVec.x * drift,
    y: flightEnd.y + windVec.y * drift,
  };

  return {
    nodeId: node.id,
    flightEnd,
    center,
    radius: node.spreadRadius,
    path: [origin, flightEnd],
    burstAt: node.igniteAt + node.flightSec,
  };
}

/** 爆开范围（含扩散半径）是否侵入任一禁放区：圆心距 < 禁放区半径 + 扩散半径 */
export function intrudedZones(burst: BurstInfo): NoFireZone[] {
  return NO_FIRE_ZONES.filter((z) => {
    const dx = burst.center.x - z.center.x;
    const dy = burst.center.y - z.center.y;
    const d = Math.hypot(dx, dy);
    return d < z.radius + burst.radius;
  });
}

export function isValidNodeInput(node: FireNode): boolean {
  return (
    !!getPointOpt(node.pointId) &&
    !!SEGMENTS.find((s) => s.id === node.segmentId) &&
    Number.isFinite(node.azimuthDeg) &&
    node.azimuthDeg >= 0 &&
    node.azimuthDeg < 360 &&
    Number.isFinite(node.igniteAt) &&
    node.igniteAt >= 0 &&
    Number.isFinite(node.flightSec) &&
    node.flightSec > 0 &&
    Number.isFinite(node.spreadRadius) &&
    node.spreadRadius > 0
  );
}

function getPointOpt(id: string): LaunchPoint | undefined {
  return LAUNCH_POINTS.find((p) => p.id === id);
}

// ---------- 全量校验 ----------

/**
 * 对全部已登记点火节点做联锁校验。
 * 同一点位按点火时刻排序后逐发判定间隔；节目边界与禁放区逐发判定。
 */
export function evaluateAll(nodes: readonly FireNode[], wind: Wind): EvalResult {
  const violations: Violation[] = [];
  const bursts = new Map<string, BurstInfo>();

  for (const node of nodes) {
    if (!isValidNodeInput(node)) {
      violations.push({
        kind: "badInput",
        nodeId: node.id,
        message: "登记字段不完整或不合法",
      });
      continue;
    }
    const burst = computeBurst(node, wind);
    if (!burst) continue;
    bursts.set(node.id, burst);

    const seg = getSegment(node.segmentId);

    if (node.igniteAt < seg.start) {
      violations.push({
        kind: "segmentBoundary",
        nodeId: node.id,
        message: `点火时刻 ${formatTimecode(node.igniteAt)} 早于「${seg.name}」开场 ${formatTimecode(seg.start)}`,
      });
    }
    if (burst.burstAt > seg.end) {
      violations.push({
        kind: "segmentBoundary",
        nodeId: node.id,
        message: `爆开时刻 ${formatTimecode(burst.burstAt)} 越过「${seg.name}」结束 ${formatTimecode(seg.end)}`,
      });
    }

    const hit = intrudedZones(burst);
    for (const z of hit) {
      violations.push({
        kind: "noFireIntrusion",
        nodeId: node.id,
        message: `爆开范围侵入禁放区「${z.name}」（圆心距边界不足 ${(
          z.radius + burst.radius
        ).toFixed(1)}m 安全线）`,
      });
    }
  }

  // 同一点位相邻两发间隔不足 1 秒
  for (const point of LAUNCH_POINTS) {
    const seq = nodes
      .filter((n) => n.pointId === point.id && isValidNodeInput(n))
      .slice()
      .sort((a, b) => a.igniteAt - b.igniteAt || (a.id < b.id ? -1 : 1));
    for (let i = 1; i < seq.length; i++) {
      const prev = seq[i - 1];
      const cur = seq[i];
      if (cur.igniteAt - prev.igniteAt < MIN_SHOT_GAP) {
        violations.push({
          kind: "shotGap",
          nodeId: cur.id,
          message: `「${point.name}」与前一发 ${formatTimecode(prev.igniteAt)} 间隔仅 ${(
            cur.igniteAt - prev.igniteAt
          ).toFixed(2)}s，不足 ${MIN_SHOT_GAP}s`,
        });
      }
    }
  }

  return {
    violations,
    bursts: nodes.map((n) => bursts.get(n.id)).filter((b): b is BurstInfo => !!b),
  };
}

/**
 * 业务要求：调整某点角度后，只重算该点“后续节点”。
 * 返回从变更节点（含）起、同一点位按点火时刻排序的节点 id 列表。
 */
export function downstreamNodeIds(
  nodes: readonly FireNode[],
  pointId: string,
  fromNodeId: string
): string[] {
  const origin = nodes.find((n) => n.id === fromNodeId);
  if (!origin) return [];
  return nodes
    .filter(
      (n) =>
        n.pointId === pointId &&
        (n.igniteAt > origin.igniteAt ||
          (n.igniteAt === origin.igniteAt && n.id >= fromNodeId))
    )
    .sort((a, b) => a.igniteAt - b.igniteAt || (a.id < b.id ? -1 : 1))
    .map((n) => n.id);
}

/**
 * 增量重算：仅刷新受影响节点的爆开几何，并重跑它们的规则。
 * 其余节点的校验结论保持不变（联锁台只重算该点后续节点）。
 */
export function reevaluateFrom(
  nodes: readonly FireNode[],
  wind: Wind,
  pointId: string,
  fromNodeId: string,
  prev: EvalResult
): EvalResult {
  const affected = new Set(downstreamNodeIds(nodes, pointId, fromNodeId));
  if (affected.size === 0) return prev;

  const keptViolations = prev.violations.filter((v) => !affected.has(v.nodeId));
  const keptBursts = new Map(prev.bursts.map((b) => [b.nodeId, b]));

  const rerunNodes = nodes.filter((n) => affected.has(n.id));
  const rerun = evaluateAll(rerunNodes, wind);

  for (const b of rerun.bursts) keptBursts.set(b.nodeId, b);

  // 间隔判定跨越“重算边界”：重算首节点还要与同点位更早的最后一发核对
  const first = rerunNodes
    .slice()
    .sort((a, b) => a.igniteAt - b.igniteAt)[0];
  if (first && isValidNodeInput(first)) {
    const prior = nodes
      .filter(
        (n) =>
          n.pointId === pointId &&
          n.id !== first.id &&
          isValidNodeInput(n) &&
          (n.igniteAt < first.igniteAt ||
            (n.igniteAt === first.igniteAt && n.id < first.id))
      )
      .sort((a, b) => b.igniteAt - a.igniteAt)[0];
    if (prior && first.igniteAt - prior.igniteAt < MIN_SHOT_GAP) {
      if (!rerun.violations.some((v) => v.kind === "shotGap" && v.nodeId === first.id)) {
        rerun.violations.push({
          kind: "shotGap",
          nodeId: first.id,
          message: `「${getPoint(pointId).name}」与前一发 ${formatTimecode(
            prior.igniteAt
          )} 间隔仅 ${(first.igniteAt - prior.igniteAt).toFixed(2)}s，不足 ${MIN_SHOT_GAP}s`,
        });
      }
    }
  }

  return {
    violations: [...keptViolations, ...rerun.violations],
    bursts: nodes.map((n) => keptBursts.get(n.id)).filter((b): b is BurstInfo => !!b),
  };
}

// ---------- 提交批次（整批拒绝） ----------

export interface BatchOutcome {
  accepted: boolean;
  violations: Violation[];
}

/**
 * 联锁提交：把待提交批次叠加到既有节点上做全量校验。
 * 只要批次中任何一发触发规则，整批拒绝，既有脚本不受影响。
 */
export function submitBatch(
  existing: readonly FireNode[],
  batch: readonly FireNode[],
  wind: Wind
): BatchOutcome {
  const merged = [...existing, ...batch];
  const probe = evaluateAll(merged, wind);
  const batchIds = new Set(batch.map((n) => n.id));
  const violations = probe.violations.filter((v) => batchIds.has(v.nodeId));

  // 间隔违规在 evaluateAll 中挂在“后一发”上；批次节点若插在既有节点之前，
  // 后一发是既有节点，会被上面的过滤漏掉，这里补查跨批次相邻对。
  for (const point of LAUNCH_POINTS) {
    const seq = merged
      .filter((n) => n.pointId === point.id && isValidNodeInput(n))
      .sort((a, b) => a.igniteAt - b.igniteAt || (a.id < b.id ? -1 : 1));
    for (let i = 1; i < seq.length; i++) {
      const prev = seq[i - 1];
      const cur = seq[i];
      const gap = cur.igniteAt - prev.igniteAt;
      if (gap < MIN_SHOT_GAP) {
        for (const n of [prev, cur]) {
          if (
            batchIds.has(n.id) &&
            !violations.some((v) => v.kind === "shotGap" && v.nodeId === n.id)
          ) {
            const other = n.id === prev.id ? cur : prev;
            violations.push({
              kind: "shotGap",
              nodeId: n.id,
              message: `「${point.name}」与相邻发 ${formatTimecode(
                other.igniteAt
              )} 间隔仅 ${gap.toFixed(2)}s，不足 ${MIN_SHOT_GAP}s`,
            });
          }
        }
      }
    }
  }

  return { accepted: violations.length === 0, violations };
}
