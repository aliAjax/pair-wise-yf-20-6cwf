import { useEffect, useMemo, useState } from "react";
import "./styles.css";
import { PointMap } from "./PointMap";
import {
  LAUNCH_POINTS,
  NO_FIRE_ZONES,
  SEGMENTS,
  SHOW_END,
  buildPreview,
  formatTime,
  revalidatePointFrom,
  shotLabel,
  validateBatch,
  type PreviewRow,
  type Shot,
  type Violation,
  type Wind,
} from "./rules";
import { loadState, saveState } from "./storage";

function num(text: string): number {
  return Number(text);
}

function validShotNumbers(s: Shot): boolean {
  return (
    Number.isFinite(s.azimuth) &&
    Number.isFinite(s.fireAt) &&
    Number.isFinite(s.flight) &&
    Number.isFinite(s.spread) &&
    s.fireAt >= 0 &&
    s.flight > 0 &&
    s.spread > 0
  );
}

/** 方位角编辑格：失焦或回车提交，联锁拒绝时由父组件回退显示值 */
function AzimuthCell({ value, onCommit }: { value: number; onCommit: (v: number) => void }) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  function commit() {
    const n = Number(text);
    if (!Number.isFinite(n)) {
      setText(String(value));
      return;
    }
    const normalized = ((n % 360) + 360) % 360;
    if (normalized !== value) onCommit(normalized);
    else setText(String(value));
  }
  return (
    <input
      className="azimuth-input"
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === "Enter" && commit()}
      aria-label="调整方位角"
    />
  );
}

function App() {
  const initial = useMemo(loadState, []);
  const [shots, setShots] = useState<Shot[]>(initial.shots);
  const [drafts, setDrafts] = useState<Shot[]>(initial.drafts);
  const [wind, setWind] = useState<Wind>(initial.wind);
  const [violations, setViolations] = useState<Violation[]>([]);
  const [notice, setNotice] = useState("");
  const [preview, setPreview] = useState<PreviewRow[]>(() =>
    initial.shots.length > 0 ? buildPreview(initial.shots, initial.wind) : []
  );
  const [selectedPointId, setSelectedPointId] = useState(LAUNCH_POINTS[0].id);
  const [form, setForm] = useState({ azimuth: "0", fireAt: "10", flight: "3", spread: "25" });

  // 刷新保留：任何状态变化都落盘
  useEffect(() => {
    saveState({ shots, drafts, wind });
  }, [shots, drafts, wind]);

  const violationIds = useMemo(
    () => new Set(violations.map((v) => v.shotId)),
    [violations]
  );

  const sortedShots = useMemo(
    () =>
      [...shots].sort(
        (a, b) => a.pointId.localeCompare(b.pointId) || a.fireAt - b.fireAt
      ),
    [shots]
  );

  function register() {
    const shot: Shot = {
      id: crypto.randomUUID(),
      pointId: selectedPointId,
      azimuth: ((num(form.azimuth) % 360) + 360) % 360,
      fireAt: num(form.fireAt),
      flight: num(form.flight),
      spread: num(form.spread),
    };
    if (!validShotNumbers(shot)) {
      setNotice("登记失败：请填写有效的方位角、点火时刻、飞行时长与扩散半径。");
      return;
    }
    setDrafts((prev) => [...prev, shot]);
    setViolations([]);
    setNotice(`已登记 ${shotLabel(shot)}，等待整批联锁校验。`);
  }

  function submitBatch() {
    if (drafts.length === 0) return;
    const result = validateBatch(drafts, shots, wind);
    if (result.length > 0) {
      // 整批拒绝：shots 原样保留，一发不入
      setViolations(result);
      setNotice(`联锁校验未通过：${result.length} 发违规，整批拒绝，原脚本未改动。`);
      return;
    }
    const next = [...shots, ...drafts];
    setShots(next);
    setDrafts([]);
    setViolations([]);
    setPreview(buildPreview(next, wind));
    setNotice(`联锁校验通过，${drafts.length} 发已入场，预演已生成。`);
  }

  function adjustAzimuth(id: string, azimuth: number) {
    const target = shots.find((s) => s.id === id);
    if (!target) return;
    const next = shots.map((s) => (s.id === id ? { ...s, azimuth } : s));
    // 只重算该点位自该时刻起的后续节点
    const result = revalidatePointFrom(next, target.pointId, target.fireAt, wind);
    if (result.length > 0) {
      setViolations(result);
      setNotice(
        `方位角调整被联锁拒绝：已重算 ${target.pointId} 自 ${formatTime(
          target.fireAt
        )} 起的后续节点，脚本保持原样。`
      );
      return;
    }
    setShots(next);
    setViolations([]);
    setPreview(buildPreview(next, wind));
    setNotice(`已重算 ${target.pointId} 后续节点，校验通过，预演已更新。`);
  }

  function removeShot(id: string) {
    const next = shots.filter((s) => s.id !== id);
    setShots(next);
    setViolations([]);
    setPreview(next.length > 0 ? buildPreview(next, wind) : []);
    setNotice("已撤销该发，预演已同步。");
  }

  function applyWind(next: Wind) {
    setWind(next);
    // 风向变化影响全部爆开范围，逐点位整体复核
    const result = LAUNCH_POINTS.flatMap((p) =>
      revalidatePointFrom(shots, p.id, 0, next)
    );
    if (result.length > 0) {
      setViolations(result);
      setPreview([]);
      setNotice("风向变化后联锁复核未通过，预演已撤回，请调整脚本。");
    } else {
      setViolations([]);
      setPreview(shots.length > 0 ? buildPreview(shots, next) : []);
      setNotice("风向已更新，全量复核通过。");
    }
  }

  return (
    <main className="app">
      <section className="hero">
        <p>单页联锁台 · 刷新自动保留</p>
        <h1>烟花燃放联锁台</h1>
        <span>
          预置四个发射点、三段节目与两块临时禁放区。登记方位角、点火时刻、飞行时长与扩散半径后，
          提交时按当前风向推算爆开范围：侵入禁放区、同点位间隔不足一秒或越过节目结束，
          整批拒绝，原脚本不动；校验通过才生成预演。
        </span>
      </section>

      <section className="metrics">
        <article>
          <small>发射点</small>
          <strong>{LAUNCH_POINTS.length}</strong>
        </article>
        <article>
          <small>节目段落</small>
          <strong>{SEGMENTS.length}</strong>
        </article>
        <article>
          <small>临时禁放区</small>
          <strong>{NO_FIRE_ZONES.length}</strong>
        </article>
        <article>
          <small>在册点火 / 待发</small>
          <strong>
            {shots.length} / {drafts.length}
          </strong>
        </article>
      </section>

      <section className="console">
        <aside className="panel">
          <h2>气象与节目</h2>
          <div className="wind-grid">
            <label>
              <span>风向去向角（°）</span>
              <input
                type="number"
                value={wind.direction}
                onChange={(e) =>
                  applyWind({ ...wind, direction: num(e.target.value) || 0 })
                }
              />
            </label>
            <label>
              <span>风速（m/s）</span>
              <input
                type="number"
                value={wind.speed}
                onChange={(e) =>
                  applyWind({ ...wind, speed: Math.max(0, num(e.target.value) || 0) })
                }
              />
            </label>
          </div>
          <ol className="segments">
            {SEGMENTS.map((seg) => (
              <li key={seg.id}>
                <b>{seg.name}</b>
                <span>
                  {formatTime(seg.start)} — {formatTime(seg.end)}
                </span>
              </li>
            ))}
            <li className="show-end">节目结束 {formatTime(SHOW_END)}</li>
          </ol>
        </aside>

        <section className="panel map-panel">
          <div className="heading">
            <div>
              <p>点位界面</p>
              <h2>发射场平面图</h2>
            </div>
            <span className="legend">
              <i className="dot dot-ok" /> 已确认 <i className="dot dot-draft" /> 待发{" "}
              <i className="dot dot-bad" /> 违规
            </span>
          </div>
          <PointMap
            shots={shots}
            drafts={drafts}
            wind={wind}
            selectedPointId={selectedPointId}
            violationIds={violationIds}
            onSelectPoint={setSelectedPointId}
          />
        </section>
      </section>

      <section className="panel form-panel">
        <div className="heading">
          <div>
            <p>点火登记</p>
            <h2>登记待发节点（{LAUNCH_POINTS.find((p) => p.id === selectedPointId)?.name}）</h2>
          </div>
          <button className="primary" onClick={register}>
            登记为待发
          </button>
        </div>
        <div className="field-grid">
          <label>
            <span>发射点（可点击平面图切换）</span>
            <select
              value={selectedPointId}
              onChange={(e) => setSelectedPointId(e.target.value)}
            >
              {LAUNCH_POINTS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>方位角（°，0=正北）</span>
            <input
              type="number"
              value={form.azimuth}
              onChange={(e) => setForm({ ...form, azimuth: e.target.value })}
            />
          </label>
          <label>
            <span>点火时刻（秒）</span>
            <input
              type="number"
              value={form.fireAt}
              onChange={(e) => setForm({ ...form, fireAt: e.target.value })}
            />
          </label>
          <label>
            <span>飞行时长（秒）</span>
            <input
              type="number"
              value={form.flight}
              onChange={(e) => setForm({ ...form, flight: e.target.value })}
            />
          </label>
          <label>
            <span>扩散半径（米）</span>
            <input
              type="number"
              value={form.spread}
              onChange={(e) => setForm({ ...form, spread: e.target.value })}
            />
          </label>
        </div>
      </section>

      <section className="panel">
        <div className="heading">
          <div>
            <p>待发批次</p>
            <h2>待联锁校验（{drafts.length} 发）</h2>
          </div>
          <button className="primary" onClick={submitBatch} disabled={drafts.length === 0}>
            提交整批校验
          </button>
        </div>
        {drafts.length === 0 ? (
          <p className="empty">暂无待发节点，请先在上方登记。</p>
        ) : (
          <div className="records">
            {drafts.map((d) => (
              <article key={d.id} className={violationIds.has(d.id) ? "record-bad" : ""}>
                <b>{d.pointId}</b>
                <div>
                  <h3>
                    {formatTime(d.fireAt)} 点火 · 方位 {d.azimuth}°
                  </h3>
                  <p>
                    飞行 {d.flight}s · 扩散 {d.spread}m
                  </p>
                </div>
                <button onClick={() => setDrafts(drafts.filter((x) => x.id !== d.id))}>
                  移除
                </button>
              </article>
            ))}
          </div>
        )}
        {notice && <p className={violations.length > 0 ? "notice notice-bad" : "notice"}>{notice}</p>}
        {violations.length > 0 && (
          <ul className="violations">
            {violations.map((v) => (
              <li key={v.shotId}>
                <b>{v.label}</b>
                <ul>
                  {v.reasons.map((r) => (
                    <li key={r}>{r}</li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="panel">
        <div className="heading">
          <div>
            <p>燃放脚本</p>
            <h2>已确认节点（{shots.length} 发）</h2>
          </div>
        </div>
        {sortedShots.length === 0 ? (
          <p className="empty">脚本为空，提交校验通过后节点会进入这里。</p>
        ) : (
          <table className="script-table">
            <thead>
              <tr>
                <th>发射点</th>
                <th>点火时刻</th>
                <th>方位角（°，可改）</th>
                <th>飞行时长</th>
                <th>扩散半径</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {sortedShots.map((s) => (
                <tr key={s.id} className={violationIds.has(s.id) ? "row-bad" : ""}>
                  <td>{s.pointId}</td>
                  <td>{formatTime(s.fireAt)}</td>
                  <td>
                    <AzimuthCell
                      value={s.azimuth}
                      onCommit={(v) => adjustAzimuth(s.id, v)}
                    />
                  </td>
                  <td>{s.flight}s</td>
                  <td>{s.spread}m</td>
                  <td>
                    <button onClick={() => removeShot(s.id)}>撤销</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {preview.length > 0 && (
        <section className="panel">
          <div className="heading">
            <div>
              <p>预演</p>
              <h2>整场时间轴（校验通过后生成）</h2>
            </div>
          </div>
          {SEGMENTS.map((seg) => {
            const rows = preview.filter((r) => r.segment?.id === seg.id);
            if (rows.length === 0) return null;
            return (
              <div key={seg.id} className="preview-segment">
                <h3>
                  {seg.name}
                  <span>
                    {formatTime(seg.start)} — {formatTime(seg.end)}
                  </span>
                </h3>
                <div className="records">
                  {rows.map((r) => (
                    <article key={r.id}>
                      <b>{formatTime(r.fireAt)}</b>
                      <div>
                        <h3>
                          {r.pointName} · 方位 {r.azimuth}°
                        </h3>
                        <p>
                          爆点 ({r.burst.cx.toFixed(0)}, {r.burst.cy.toFixed(0)})m · 半径{" "}
                          {r.burst.radius}m · 飞行 {r.flight}s
                        </p>
                      </div>
                    </article>
                  ))}
                </div>
              </div>
            );
          })}
        </section>
      )}
    </main>
  );
}

export default App;
