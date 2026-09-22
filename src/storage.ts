/**
 * 存储文件：localStorage 持久化，刷新后保留脚本、待发批次与风向。
 */

import type { Shot, Wind } from "./rules";

const KEY = "firework-interlock-v1";

export interface PersistedState {
  shots: Shot[];
  drafts: Shot[];
  wind: Wind;
}

export const DEFAULT_WIND: Wind = { direction: 90, speed: 3 };

function isShot(value: unknown): value is Shot {
  const s = value as Shot;
  return (
    typeof s === "object" &&
    s !== null &&
    typeof s.id === "string" &&
    typeof s.pointId === "string" &&
    typeof s.azimuth === "number" &&
    typeof s.fireAt === "number" &&
    typeof s.flight === "number" &&
    typeof s.spread === "number"
  );
}

export function loadState(): PersistedState {
  const fallback: PersistedState = { shots: [], drafts: [], wind: DEFAULT_WIND };
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return fallback;
    const data = JSON.parse(raw) as Partial<PersistedState>;
    return {
      shots: Array.isArray(data.shots) ? data.shots.filter(isShot) : [],
      drafts: Array.isArray(data.drafts) ? data.drafts.filter(isShot) : [],
      wind:
        data.wind &&
        typeof data.wind.direction === "number" &&
        typeof data.wind.speed === "number"
          ? data.wind
          : DEFAULT_WIND,
    };
  } catch {
    return fallback;
  }
}

export function saveState(state: PersistedState): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    // 存储不可用时静默降级，控制台功能不受影响
  }
}
