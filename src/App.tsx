import { useEffect, useMemo, useRef, useState } from "react";
import "./styles.css";
import PointMap, { POINT_COLORS } from "./PointMap";
import {
  DEFAULT_WIND,
  LAUNCH_POINTS,
  MIN_SHOT_GAP,
  NO_FIRE_ZONES,
  SEGMENTS,
  type BurstInfo,
  type EvalResult,
  type FireNode,
  type Violation,
  type Wind,
  downstreamNodeIds,
  evaluateAll,
  formatTimecode,
  getPoint,
  getSegment,
  parseTimecode,
  reevaluateFrom,
  submitBatch,
} from "./rules";
import { clearState, loadState, saveNodes, saveQueue, saveWind } from "./storage";

interface RehearsalState {
  t: number;
  playing: boolean;
}

let idSeq = 0;
function nextId(): string {
  idSeq += 1;
  return `node-${Date.now().toString(36)}-${idSeq}`;
}

export default function App() {
  // ---------- 持久化状态（刷新保留） ----------
  const initial = useRef<ReturnType<typeof loadState> | null>(null);
  if (initial.current === null) initial.current = loadState();

  const [nodes, setNodes] = useState<FireNode[]>(initial.current.nodes);
  const [queue, setQueue] = useState<FireNode[]>(initial.current.queue);
  const [wind, setWind] = useState<Wind>(initial.current.wind);
  const [selectedPointId, setSelectedPointId] = useState(LAUNCH_POINTS[0].id);

  // 已登记节点的联锁结论。角度调整走增量重算，其余操作做全量重算。
  const [evalResult, setEvalResult] = useState<EvalResult>(() =>
    evaluateAll(initial.current!.nodes, initial.current!.wind)
  );

  const [batchReject, setBatchReject] = useState<Violation[] | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [rehearsal, setRehearsal] = useState<RehearsalState | null>(null);
  const [speed, setSpeed] = useState(1);

  // ---------- 登记表单 ----------
  const [form, setForm] = useState({
    segmentId: SEGMENTS[0].id,
    azimuth: "45",
    ignite: "",
    flight: "2.5",
    radius: "18",
  });
  const [formError, setFormError] = useState<string | null>(null);

  // ---------- 持久化 ----------
  useEffect(() => saveNodes(nodes), [nodes]);
  useEffect(() => saveQueue(queue), [queue]);
  useEffect(() => saveWind(wind), [wind]);

  // 预演是“当前脚本通过校验”的快照：脚本或风向一变即作废，需重新生成
  useEffect(() => {
    setRehearsal(null);
  }, [nodes, wind]);

  const violatingIds = useMemo(
    () => new Set(evalResult.violations.map((v) => v.nodeId)),
    [evalResult]
  );

  const valid = nodes.length > 0 && evalResult.violations.length === 0;

  const rehearsalEnd = useMemo(() => {
    const last = evalResult.bursts.reduce(
      (m, b) => Math.max(m, b.burstAt),
      0
    );
    return last + 2;
  }, [evalResult.bursts]);

  // 违规出现时不允许保留预演
  useEffect(() => {
    if (rehearsal && !valid) setRehearsal(null);
  }, [rehearsal, valid]);

  // ---------- 预演播放循环 ----------
  useEffect(() => {
    if (!rehearsal?.playing) return;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = ((now - last) / 1000) * speed;
      last = now;
      setRehearsal((r) => {
        if (!r || !r.playing) return r;
        const t = r.t + dt;
        return t >= rehearsalEnd ? { t: rehearsalEnd, playing: false } : { ...r, t };
      });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [rehearsal?.playing, speed, rehearsalEnd]);

  // ---------- 操作 ----------

  /** 加入待提交批次（批次提交时整批校验、整批拒绝） */
  function enqueue() {
    const az = Number(form.azimuth);
    const igniteAt = parseTimecode(form.ignite);
    const flight = Number(form.flight);
    const radius = Number(form.radius);

    if (
      !Number.isFinite(az) ||
      az < 0 ||
      az >= 360 ||
      igniteAt === null ||
      !Number.isFinite(flight) ||
      flight <= 0 ||
      !Number.isFinite(radius) ||
      radius <= 0
    ) {
      setFormError(
        "请检查：方位角 0–359°、点火时刻 mm:ss.mmm、飞行时长与扩散半径均须为正数。"
      );
      return;
    }

    setFormError(null);
    setBatchReject(null);
    const node: FireNode = {
      id: nextId(),
      pointId: selectedPointId,
      segmentId: form.segmentId,
      azimuthDeg: az,
      igniteAt,
      flightSec: flight,
      spreadRadius: radius,
    };
    setQueue((q) => [...q, node]);
    setNotice(
      `已加入待提交批次：${getPoint(selectedPointId).name} · ${formatTimecode(igniteAt)} 点火`
    );
  }

  /** 联锁提交：任一发违规则整批拒绝，已登记脚本不受影响 */
  function commitBatch() {
    const outcome = submitBatch(nodes, queue, wind);
    if (!outcome.accepted) {
      setBatchReject(outcome.violations);
      setNotice(null);
      return;
    }
    const merged = [...nodes, ...queue];
    setNodes(merged);
    setQueue([]);
    setBatchReject(null);
    setEvalResult(evaluateAll(merged, wind));
    setNotice(`批次联锁通过，${queue.length} 发已写入燃放脚本。`);
  }

  /** 调整角度：只重算该点后续节点（增量） */
  function applyAngle(nodeId: string, nextAz: number) {
    const target = nodes.find((n) => n.id === nodeId);
    if (!target || !Number.isFinite(nextAz) || nextAz < 0 || nextAz >= 360) return;
    if (Math.abs(nextAz - target.azimuthDeg) < 1e-9) return;

    const next = nodes.map((n) =>
      n.id === nodeId ? { ...n, azimuthDeg: nextAz } : n
    );
    setNodes(next);
    setEvalResult((prev) => reevaluateFrom(next, wind, target.pointId, nodeId, prev));

    const ids = downstreamNodeIds(next, target.pointId, nodeId);
    const probe = evaluateAll(next, wind);
    setNotice(
      `「${getPoint(target.pointId).name}」角度 ${target.azimuthDeg.toFixed(0)}° → ${nextAz.toFixed(
        0
      )}°，联锁台仅重算该点位 ${ids.length} 个后续节点；` +
        (probe.violations.length === 0
          ? "重算通过，可生成预演。"
          : `重算发现 ${probe.violations.length} 项违规，预演保持锁定。`)
    );
  }

  function removeNode(nodeId: string) {
    const next = nodes.filter((n) => n.id !== nodeId);
    setNodes(next);
    setEvalResult(evaluateAll(next, wind));
  }

  function removeFromQueue(id: string) {
    setQueue((q) => q.filter((n) => n.id !== id));
    setBatchReject(null);
  }

  function updateWind(patch: Partial<Wind>) {
    setWind((w) => {
      const next = { ...w, ...patch };
      setEvalResult(evaluateAll(nodes, next));
      return next;
    });
  }

  function resetAll() {
    if (!window.confirm("确定清空全部登记与待提交批次，恢复只读原脚本？")) return;
    clearState();
    setNodes([]);
    setQueue([]);
    setWind({ ...DEFAULT_WIND });
    setEvalResult(evaluateAll([], DEFAULT_WIND));
    setBatchReject(null);
    setNotice("已恢复原脚本：四个发射点、三段节目、两块禁放区保持不动。");
    setRehearsal(null);
  }

  const violationsByNode = useMemo(() => {
    const m = new Map<string, Violation[]>();
    for (const v of evalResult.violations) {
      const list = m.get(v.nodeId) ?? [];
      list.push(v);
      m.set(v.nodeId, list);
    }
    return m;
  }, [evalResult]);

  return (
    <main className="app console">
      {/* ---------- 顶栏 ---------- */}
      <header className="topbar panel">
        <div>
          <p className="eyebrow">FIREWORKS INTERLOCK CONSOLE</p>
          <h1>烟花燃放联锁台</h1>
          <p className="lock-note">
            🔒 原脚本只读：{LAUNCH_POINTS.length} 个发射点 · {SEGMENTS.length} 段节目 ·{" "}
            {NO_FIRE_ZONES.length} 块临时禁放区，操作员只能登记与调整自己的点火节点
          </p>
        </div>
        <div className="wind-box">
          <span>实时风向（提交与重算均采用）</span>
          <label>
            风向角°
            <input
              type="number"
              min={0}
              max={359}
              value={wind.dirDeg}
              onChange={(e) =>
                updateWind({ dirDeg: ((Number(e.target.value) % 360) + 360) % 360 })
              }
            />
          </label>
          <label>
            风速 m/s
            <input
              type="number"
              min={0}
              step={0.1}
              value={wind.speed}
              onChange={(e) => updateWind({ speed: Math.max(0, Number(e.target.value)) })}
            />
          </label>
          <button className="ghost" onClick={resetAll}>
            清空登记 / 恢复原脚本
          </button>
        </div>
      </header>

      {/* ---------- 指标 ---------- */}
      <section className="metrics">
        <article>
          <small>已登记点火节点</small>
          <strong>{nodes.length}</strong>
        </article>
        <article>
          <small>待提交批次</small>
          <strong>{queue.length}</strong>
        </article>
        <article className={evalResult.violations.length ? "alarm" : "clean"}>
          <small>联锁违规</small>
          <strong>{evalResult.violations.length}</strong>
        </article>
        <article>
          <small>节目总时长</small>
          <strong>{formatTimecode(SEGMENTS[SEGMENTS.length - 1].end)}</strong>
        </article>
      </section>

      <div className="layout">
        {/* ---------- 左：点位界面 + 预演 + 时间轴 ---------- */}
        <section className="panel map-panel">
          <div className="heading">
            <div>
              <p>点位界面</p>
              <h2>场地平面图与风偏爆开范围</h2>
            </div>
            <span className={`interlock ${valid ? "go" : "hold"}`}>
              {valid ? "联锁通过 · 可预演" : nodes.length === 0 ? "尚无登记" : "联锁阻断 · 预演锁定"}
            </span>
          </div>

          <PointMap
            nodes={nodes}
            bursts={evalResult.bursts}
            violatingNodeIds={violatingIds}
            wind={wind}
            selectedPointId={selectedPointId}
            onSelectPoint={setSelectedPointId}
            rehearsalTime={rehearsal ? rehearsal.t : null}
            playing={rehearsal?.playing ?? false}
          />

          <Timeline
            nodes={nodes}
            bursts={evalResult.bursts}
            violatingIds={violatingIds}
            rehearsal={rehearsal}
            onSeek={(t) => setRehearsal({ t, playing: false })}
          />

          <div className="rehearsal-bar">
            <button
              className="primary"
              disabled={!valid}
              onClick={() => setRehearsal({ t: 0, playing: true })}
            >
              生成预演
            </button>
            <button
              disabled={!rehearsal}
              onClick={() =>
                setRehearsal((r) => (r ? { ...r, playing: !r.playing } : r))
              }
            >
              {rehearsal?.playing ? "暂停" : "播放"}
            </button>
            <button
              disabled={!rehearsal}
              onClick={() => setRehearsal({ t: 0, playing: false })}
            >
              回到开场
            </button>
            <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))}>
              <option value={0.5}>0.5×</option>
              <option value={1}>1×</option>
              <option value={2}>2×</option>
              <option value={4}>4×</option>
            </select>
            <span className="rehearsal-hint">
              {valid
                ? "逐发：弹丸沿虚线弹道推进，落点按风偏漂移后扩散爆开"
                : "存在违规时预演锁定；调整角度重算通过后才能生成"}
            </span>
          </div>
        </section>

        {/* ---------- 右：点火登记 ---------- */}
        <section className="panel form-panel">
          <div className="heading">
            <div>
              <p>点火登记</p>
              <h2>
                向「{getPoint(selectedPointId).name}（{selectedPointId}）」登记一发
              </h2>
            </div>
          </div>

          <div className="field-grid">
            <label>
              <span>发射点（可在左图点选）</span>
              <select
                value={selectedPointId}
                onChange={(e) => setSelectedPointId(e.target.value)}
              >
                {LAUNCH_POINTS.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.id} {p.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>所属节目段</span>
              <select
                value={form.segmentId}
                onChange={(e) => setForm((f) => ({ ...f, segmentId: e.target.value }))}
              >
                {SEGMENTS.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}（{formatTimecode(s.start)} – {formatTimecode(s.end)}）
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>方位角（罗盘角，0°=北、90°=东）</span>
              <input
                type="number"
                min={0}
                max={359}
                value={form.azimuth}
                onChange={(e) => setForm((f) => ({ ...f, azimuth: e.target.value }))}
              />
            </label>
            <label>
              <span>点火时刻 mm:ss.mmm</span>
              <input
                placeholder="00:12.500"
                value={form.ignite}
                onChange={(e) => setForm((f) => ({ ...f, ignite: e.target.value }))}
              />
            </label>
            <label>
              <span>飞行时长（秒，决定飞行距离）</span>
              <input
                type="number"
                min={0.1}
                step={0.1}
                value={form.flight}
                onChange={(e) => setForm((f) => ({ ...f, flight: e.target.value }))}
              />
            </label>
            <label>
              <span>扩散半径（米）</span>
              <input
                type="number"
                min={1}
                step={1}
                value={form.radius}
                onChange={(e) => setForm((f) => ({ ...f, radius: e.target.value }))}
              />
            </label>
          </div>

          <p className="formula">
            爆开圆心 = 发射点 + 方位角方向 ×（{`20 m/s`} × 飞行时长） + 风偏（风向{" "}
            {wind.dirDeg.toFixed(0)}° × {wind.speed.toFixed(1)} m/s × 飞行时长）
          </p>

          {formError && <p className="error-line">{formError}</p>}

          <div className="batch-actions">
            <button onClick={enqueue}>加入待提交批次</button>
            <button className="primary" disabled={queue.length === 0} onClick={commitBatch}>
              联锁提交批次（{queue.length} 发）
            </button>
          </div>

          {queue.length > 0 && (
            <div className="queue">
              <h3>待提交批次（任一发违规即整批拒绝）</h3>
              <ul>
                {queue.map((n) => (
                  <li key={n.id}>
                    <i style={{ background: POINT_COLORS[n.pointId] }} />
                    <span>
                      {getPoint(n.pointId).name} · {getSegment(n.segmentId).name} ·{" "}
                      {n.azimuthDeg.toFixed(0)}° · {formatTimecode(n.igniteAt)} 点火 · 飞{" "}
                      {n.flightSec}s · 扩散 {n.spreadRadius}m
                    </span>
                    <button className="mini" onClick={() => removeFromQueue(n.id)}>
                      撤下
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {batchReject && (
            <div className="reject-box">
              <h3>🚫 整批拒绝：{batchReject.length} 项联锁违规，已登记脚本未改动</h3>
              <ul>
                {batchReject.map((v, i) => (
                  <li key={i}>{v.message}</li>
                ))}
              </ul>
            </div>
          )}
        </section>
      </div>

      {notice && (
        <div className="panel notice" role="status">
          {notice}
        </div>
      )}

      {/* ---------- 已登记脚本：按点位分组 ---------- */}
      <section className="panel roster">
        <div className="heading">
          <div>
            <p>已登记脚本</p>
            <h2>四个发射点的点火序列（同点相邻间隔 ≥ {MIN_SHOT_GAP}s）</h2>
          </div>
          <span className="muted">角度调整只触发该点后续节点重算</span>
        </div>

        <div className="roster-grid">
          {LAUNCH_POINTS.map((p) => {
            const list = nodes
              .filter((n) => n.pointId === p.id)
              .sort((a, b) => a.igniteAt - b.igniteAt);
            return (
              <article key={p.id} className="roster-col">
                <h3 style={{ borderTopColor: POINT_COLORS[p.id] }}>
                  <i style={{ background: POINT_COLORS[p.id] }} />
                  {p.id} {p.name}
                  <b>{list.length} 发</b>
                </h3>
                {list.length === 0 && <p className="muted">尚未登记</p>}
                {list.map((n) => (
                  <NodeRow
                    key={n.id}
                    node={n}
                    violations={violationsByNode.get(n.id) ?? []}
                    onApplyAngle={(az) => applyAngle(n.id, az)}
                    onRemove={() => removeNode(n.id)}
                  />
                ))}
              </article>
            );
          })}
        </div>

        {evalResult.violations.length > 0 && (
          <div className="violation-list">
            <h3>联锁阻断明细</h3>
            <ul>
              {evalResult.violations.map((v, i) => (
                <li key={i}>
                  <KindTag kind={v.kind} /> {v.message}
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>
    </main>
  );
}

// ---------- 时间轴 ----------

function Timeline({
  nodes,
  bursts,
  violatingIds,
  rehearsal,
  onSeek,
}: {
  nodes: readonly FireNode[];
  bursts: readonly BurstInfo[];
  violatingIds: ReadonlySet<string>;
  rehearsal: RehearsalState | null;
  onSeek: (t: number) => void;
}) {
  const total = SEGMENTS[SEGMENTS.length - 1].end;
  const burstAt = new Map(bursts.map((b) => [b.nodeId, b.burstAt]));

  return (
    <div className="timeline">
      <div className="tl-segments">
        {SEGMENTS.map((s) => (
          <div
            key={s.id}
            className="tl-seg"
            style={{ left: `${(s.start / total) * 100}%`, width: `${((s.end - s.start) / total) * 100}%` }}
          >
            {s.name}
            <small>
              {formatTimecode(s.start)}–{formatTimecode(s.end)}
            </small>
          </div>
        ))}
      </div>
      <div className="tl-track">
        {nodes.map((n) => (
          <span
            key={n.id}
            className={`tl-tick ${violatingIds.has(n.id) ? "bad" : ""}`}
            style={{
              left: `${(n.igniteAt / total) * 100}%`,
              background: POINT_COLORS[n.pointId],
            }}
            title={`${getPoint(n.pointId).name} · 点火 ${formatTimecode(
              n.igniteAt
            )} · 爆开 ${formatTimecode(burstAt.get(n.id) ?? n.igniteAt)}`}
          />
        ))}
        {rehearsal && (
          <span className="tl-playhead" style={{ left: `${(rehearsal.t / total) * 100}%` }} />
        )}
      </div>
      {rehearsal && (
        <input
          className="tl-scrub"
          type="range"
          min={0}
          max={total}
          step={0.05}
          value={Math.min(rehearsal.t, total)}
          onChange={(e) => onSeek(Number(e.target.value))}
        />
      )}
    </div>
  );
}

// ---------- 单节点行（方位角就地调整） ----------

function NodeRow({
  node,
  violations,
  onApplyAngle,
  onRemove,
}: {
  node: FireNode;
  violations: readonly Violation[];
  onApplyAngle: (az: number) => void;
  onRemove: () => void;
}) {
  const [az, setAz] = useState(String(node.azimuthDeg));
  useEffect(() => setAz(String(node.azimuthDeg)), [node.azimuthDeg]);

  const dirty = Number(az) !== node.azimuthDeg && Number.isFinite(Number(az));

  return (
    <div className={`node-row ${violations.length ? "bad" : ""}`}>
      <div className="node-main">
        <time>{formatTimecode(node.igniteAt)}</time>
        <span className="node-seg">{getSegment(node.segmentId).name}</span>
        <span>飞{node.flightSec}s</span>
        <span>扩{node.spreadRadius}m</span>
      </div>
      <div className="node-angle">
        <input
          type="number"
          min={0}
          max={359}
          value={az}
          onChange={(e) => setAz(e.target.value)}
          aria-label="方位角"
        />
        <span>°</span>
        <button
          className="mini"
          disabled={!dirty || Number(az) < 0 || Number(az) >= 360}
          onClick={() => onApplyAngle(Number(az))}
        >
          调角度
        </button>
        <button className="mini danger" onClick={onRemove}>
          删除
        </button>
      </div>
      {violations.length > 0 && (
        <ul className="node-errors">
          {violations.map((v, i) => (
            <li key={i}>
              <KindTag kind={v.kind} /> {v.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function KindTag({ kind }: { kind: Violation["kind"] }) {
  const text: Record<Violation["kind"], string> = {
    segmentBoundary: "越节目边界",
    shotGap: "同点间隔不足",
    noFireIntrusion: "侵入禁放区",
    badInput: "字段非法",
  };
  return <em className={`kind kind-${kind}`}>{text[kind]}</em>;
}
