// 业务文件二：本地存储
// 预设（发射点 / 节目段 / 禁放区）是原脚本，永不落库；这里只持久化
// 操作员登记的点火节点、待提交批次与风向设置，刷新页面后自动恢复。

import type { FireNode, Wind } from "./rules";
import { DEFAULT_WIND } from "./rules";

const NODES_KEY = "fireworks-console:nodes:v1";
const QUEUE_KEY = "fireworks-console:queue:v1";
const WIND_KEY = "fireworks-console:wind:v1";

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function isNode(v: unknown): v is FireNode {
  if (!v || typeof v !== "object") return false;
  const n = v as Record<string, unknown>;
  return (
    typeof n.id === "string" &&
    typeof n.pointId === "string" &&
    typeof n.segmentId === "string" &&
    isFiniteNumber(n.azimuthDeg) &&
    isFiniteNumber(n.igniteAt) &&
    isFiniteNumber(n.flightSec) &&
    isFiniteNumber(n.spreadRadius)
  );
}

function isWind(v: unknown): v is Wind {
  if (!v || typeof v !== "object") return false;
  const w = v as Record<string, unknown>;
  return isFiniteNumber(w.dirDeg) && isFiniteNumber(w.speed);
}

function readList<T>(key: string, guard: (v: unknown) => v is T): T[] {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const data = JSON.parse(raw);
    if (!Array.isArray(data)) return [];
    return data.filter(guard);
  } catch {
    return [];
  }
}

export interface PersistedState {
  nodes: FireNode[];
  queue: FireNode[];
  wind: Wind;
}

export function loadState(): PersistedState {
  if (typeof localStorage === "undefined") {
    return { nodes: [], queue: [], wind: { ...DEFAULT_WIND } };
  }
  const windRaw = (() => {
    try {
      const raw = localStorage.getItem(WIND_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  })();
  return {
    nodes: readList(NODES_KEY, isNode),
    queue: readList(QUEUE_KEY, isNode),
    wind: isWind(windRaw) ? windRaw : { ...DEFAULT_WIND },
  };
}

export function saveNodes(nodes: readonly FireNode[]): void {
  try {
    localStorage.setItem(NODES_KEY, JSON.stringify(nodes));
  } catch {
    /* 存储不可用时静默降级为内存态 */
  }
}

export function saveQueue(queue: readonly FireNode[]): void {
  try {
    localStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
  } catch {
    /* 同上 */
  }
}

export function saveWind(wind: Wind): void {
  try {
    localStorage.setItem(WIND_KEY, JSON.stringify(wind));
  } catch {
    /* 同上 */
  }
}

export function clearState(): void {
  try {
    localStorage.removeItem(NODES_KEY);
    localStorage.removeItem(QUEUE_KEY);
    localStorage.removeItem(WIND_KEY);
  } catch {
    /* 同上 */
  }
}
