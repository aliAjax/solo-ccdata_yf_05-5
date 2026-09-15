import { useMemo, useState } from 'react';
import {
  desk,
  useDesk,
  currentAgent,
  setCurrentAgent,
  fmtTs,
  cabinLabel,
  cabinViews,
  voyageConflicts,
  loads,
} from './cruise/ui';
import { RULE_LABEL, RULE_DESC, blockingConflicts, uid } from './cruise/engine';
import { buildSeedStore } from './cruise/seed';
import type { Cabin, Conflict, Passenger, RuleCode, Voyage } from './cruise/types';
import './App.css';

const AGENTS = ['客服·小周', '客服·小钱', '主管', '客房部'];

type Tab = 'ops' | 'setup';

export default function App() {
  const { state, conflicts } = useDesk();
  const [agent, setAgent] = useState(currentAgent());
  const [voyageId, setVoyageId] = useState(state.voyages[0]?.id ?? '');
  const [tab, setTab] = useState<Tab>('ops');
  const [selectedCabin, setSelectedCabin] = useState<string | null>(null);

  const voyage = state.voyages.find((v) => v.id === voyageId) ?? state.voyages[0];
  const vc = voyage ? voyageConflicts(conflicts, voyage.id) : [];
  const errors = voyage ? blockingConflicts(conflicts, voyage.id) : [];
  const warnings = vc.filter((c) => c.severity === 'warning');
  const pendingArbs = state.arbitrations.filter((a) => a.status === 'pending');

  const switchAgent = (name: string) => {
    setAgent(name);
    setCurrentAgent(name);
  };

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="logo">⚓</span>
          <div>
            <h1>邮轮舱位分配与救生容量校验台</h1>
            <p>录入 · 分配 · 实时复核 · 冲突处置 · 登船确认（事件链持久化，刷新不丢）</p>
          </div>
        </div>
        <div className="agent-box">
          <label>当前客服</label>
          <select value={agent} onChange={(e) => switchAgent(e.target.value)}>
            {AGENTS.map((a) => (
              <option key={a}>{a}</option>
            ))}
          </select>
          {pendingArbs.length > 0 && <span className="arb-badge">{pendingArbs.length} 单待裁定</span>}
        </div>
      </header>

      <nav className="tabs">
        <button className={tab === 'ops' ? 'on' : ''} onClick={() => setTab('ops')}>
          舱位操作台
        </button>
        <button className={tab === 'setup' ? 'on' : ''} onClick={() => setTab('setup')}>
          基础数据录入
        </button>
        <button
          className="tab-right"
          onClick={() => {
            if (confirm('确定清空全部数据并重建演示数据？')) desk.reset(() => buildSeedStore(true));
          }}
        >
          重置演示数据
        </button>
      </nav>

      {tab === 'setup' ? (
        <SetupPanel agent={agent} />
      ) : voyage ? (
        <OpsPanel
          agent={agent}
          voyage={voyage}
          setVoyageId={setVoyageId}
          errors={errors}
          warnings={warnings}
          selectedCabin={selectedCabin}
          setSelectedCabin={setSelectedCabin}
        />
      ) : (
        <div className="empty">请先在「基础数据录入」中创建航次。</div>
      )}

      <footer className="footer">
        事件总数 {desk.events.length} · 当前修订 {desk.revision} · 全量复核 {conflicts.length} 项冲突（全航次）
      </footer>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 操作台
// ---------------------------------------------------------------------------

function OpsPanel(props: {
  agent: string;
  voyage: Voyage;
  setVoyageId: (id: string) => void;
  errors: Conflict[];
  warnings: Conflict[];
  selectedCabin: string | null;
  setSelectedCabin: (id: string | null) => void;
}) {
  const { state, conflicts } = useDesk();
  const { agent, voyage, setVoyageId, errors, warnings, selectedCabin, setSelectedCabin } = props;
  const views = useMemo(() => cabinViews(state, conflicts, voyage.id), [state, conflicts, voyage.id]);
  const ls = loads(state, voyage.id);
  const pax = state.passengers.filter((p) => p.voyageId === voyage.id && p.status !== 'removed');
  const unassigned = pax.filter((p) => !p.cabinId);
  const confirmation = state.confirmations[voyage.id];

  return (
    <div className="ops">
      <div className="voyage-bar">
        <label>航次</label>
        <select
          value={voyage.id}
          onChange={(e) => {
            setVoyageId(e.target.value);
            setSelectedCabin(null);
          }}
        >
          {state.voyages.map((v) => (
            <option key={v.id} value={v.id}>
              {v.code} {v.name}（{fmtTs(v.departureTs)} 出发{v.status === 'confirmed' ? ' · 已确认' : ''}）
            </option>
          ))}
        </select>
        <span className="vmeta">
          {pax.length} 名旅客 · {state.cabins.length} 间舱 · {state.boats.length} 艘救生艇
        </span>
        <div className="spacer" />
        <button onClick={() => desk.autoAssign(voyage.id, agent)}>▶ 自动分配</button>
        <button
          className="ghost"
          onClick={() => {
            if (confirm('清空本航次全部床位分配（拆单重来）？')) desk.clearAssignment(voyage.id, agent);
          }}
        >
          清空分配
        </button>
      </div>

      <div className="grid3">
        <section className="panel cabins-panel">
          <PanelTitle title="舱位图" hint="点选舱室换舱 / 锁舱 / 封舱；角标为在住/禁住人数" />
          <div className="decks">
            {groupBy(views, (v) => v.cabin.deck).map(([deck, list]) => (
              <div key={deck} className="deck-row">
                <div className="deck-label">{deck} 甲板</div>
                <div className="cabin-cells">
                  {list.map(({ cabin, inside, conflicts: ccs }) => (
                    <CabinCell
                      key={cabin.id}
                      cabin={cabin}
                      count={inside.length}
                      selected={selectedCabin === cabin.id}
                      conflicts={ccs}
                      onClick={() => setSelectedCabin(selectedCabin === cabin.id ? null : cabin.id)}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
          {selectedCabin && (
            <CabinEditor key={selectedCabin} cabinId={selectedCabin} voyage={voyage} agent={agent} onClose={() => setSelectedCabin(null)} />
          )}
          <Legend />
        </section>

        <section className="panel capacity-panel">
          <PanelTitle title="救生容量" hint="按集合点聚合：容量 / 救生艇定员（含冗余）" />
          {ls.map((l) => {
            const boatCap = l.boatCapacity;
            const need = Math.ceil(l.assigned * (1 + state.config.boatCapacityMargin));
            const boatBad = boatCap > 0 && need > boatCap;
            const stBad = l.assigned > l.station.capacity;
            return (
              <div key={l.station.id} className={'station-card' + (boatBad || stBad ? ' bad' : '')}>
                <div className="station-head">
                  <b>{l.station.name}</b>
                  <span className={stBad ? 'red' : ''}>
                    {l.assigned}/{l.station.capacity}
                  </span>
                </div>
                <div className="bar">
                  <i style={{ width: `${Math.min(100, Math.round(l.ratio * 100))}%` }} className={stBad ? 'red' : ''} />
                </div>
                <div className="station-foot">
                  救生艇：{l.boats.map((b) => b.name.replace('救生艇 ', '')).join('、') || '无'}
                  <span className={boatBad ? 'red' : ''}>
                    艇位 {boatCap} · 含冗余需 {need}
                  </span>
                </div>
              </div>
            );
          })}
          <div className="config-line">
            艇位冗余 {Math.round(state.config.boatCapacityMargin * 100)}% · 周转{' '}
            {(state.config.minTurnaroundMs / 3600000).toFixed(0)}h · 失衡阈值{' '}
            {Math.round(state.config.stationImbalanceRatio * 100)}% · 陪同 {state.config.escortAgeMin}+ 岁 · 儿童
            &lt;{state.config.childAgeMax} 岁
          </div>

          <PanelTitle title="待人工裁定" hint="两名客服同改一舱：两份修改都保留，绝不静默覆盖" />
          <ArbitrationList agent={agent} />
        </section>

        <section className="panel conflicts-panel">
          <PanelTitle title="实时复核冲突" hint={`错误 ${errors.length} · 警告 ${warnings.length}`} />
          <ConflictList conflicts={[...errors, ...warnings]} onJumpCabin={setSelectedCabin} />
          <ConfirmationBox
            voyage={voyage}
            errors={errors}
            warnings={warnings}
            agent={agent}
            unassignedCount={unassigned.length}
            confirmed={!!confirmation}
          />
        </section>
      </div>

      <div className="grid2">
        <section className="panel">
          <PanelTitle title="旅客名册" hint={`${pax.length} 人，未分配 ${unassigned.length} 人`} />
          <PassengerTable voyageId={voyage.id} setSelectedCabin={setSelectedCabin} agent={agent} />
        </section>
        <section className="panel">
          <PanelTitle title="操作链" hint="事件溯源：刷新 / 跨标签页后按此链重放，方案与操作都在" />
          <EventLog />
        </section>
      </div>
    </div>
  );
}

function groupBy<T>(arr: T[], key: (x: T) => string): [string, T[]][] {
  const m = new Map<string, T[]>();
  for (const x of arr) {
    const k = key(x);
    const a = m.get(k) ?? [];
    a.push(x);
    m.set(k, a);
  }
  return [...m.entries()];
}

function PanelTitle({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="panel-title">
      <h3>{title}</h3>
      {hint && <p>{hint}</p>}
    </div>
  );
}

function Legend() {
  return (
    <div className="legend">
      <span><i className="sw normal" />正常</span>
      <span><i className="sw warn" />警告</span>
      <span><i className="sw err" />错误</span>
      <span><i className="sw locked" />锁舱</span>
      <span><i className="sw sealed" />封舱</span>
      <span><i className="sw acc" />无障碍</span>
    </div>
  );
}

function CabinCell({
  cabin,
  count,
  selected,
  conflicts,
  onClick,
}: {
  cabin: Cabin;
  count: number;
  selected: boolean;
  conflicts: Conflict[];
  onClick: () => void;
}) {
  const hasErr = conflicts.some((c) => c.severity === 'error');
  const hasWarn = conflicts.some((c) => c.severity === 'warning');
  const cls = [
    'cabin',
    cabin.status === 'sealed' ? 'sealed' : '',
    cabin.status === 'locked' ? 'locked' : '',
    hasErr ? 'err' : hasWarn ? 'warn' : '',
    selected ? 'sel' : '',
  ].join(' ');
  return (
    <button className={cls} onClick={onClick} title={conflicts.map((c) => c.detail).join('\n') || '无冲突'}>
      <b>{cabin.number}</b>
      {cabin.accessible && <span className="tag-acc">♿</span>}
      <span className={count > cabin.maxOccupancy ? 'red' : ''}>
        {count}/{cabin.maxOccupancy}
      </span>
      {cabin.status === 'locked' && <span className="st">🔒</span>}
      {cabin.status === 'sealed' && <span className="st">🚫</span>}
      <span className="ver">
        v{cabin.version}
        {cabin.lastEditedBy ? `·${cabin.lastEditedBy.slice(-2)}` : ''}
      </span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// 舱室编辑（换舱 / 强制入住 / 锁舱 / 封舱）
// ---------------------------------------------------------------------------

function CabinEditor({
  cabinId,
  voyage,
  agent,
  onClose,
}: {
  cabinId: string;
  voyage: Voyage;
  agent: string;
  onClose: () => void;
}) {
  const { state } = useDesk();
  const cabin = state.cabins.find((c) => c.id === cabinId);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  // 打开面板即锁定基准版本：面板开着时他人改舱，提交将走并发裁定而非静默覆盖
  const [baseVersion, setBaseVersion] = useState(cabin?.version ?? 0);
  if (!cabin) return null;
  const stale = cabin.version !== baseVersion;
  const syncBase = () => setBaseVersion(desk.state.cabins.find((c) => c.id === cabinId)?.version ?? baseVersion);

  const inside = state.passengers.filter(
    (p) => p.cabinId === cabinId && p.voyageId === voyage.id && p.status !== 'removed',
  );
  const candidates = state.passengers.filter(
    (p) => p.voyageId === voyage.id && p.status !== 'removed' && p.cabinId !== cabinId,
  );
  const [addIds, setAddIds] = useState<string[]>([]);
  const [removeIds, setRemoveIds] = useState<string[]>([]);
  const [force, setForce] = useState(false);

  const toggle = (list: string[], set: (v: string[]) => void, id: string) =>
    set(list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);

  const submit = () => {
    const result = desk.submitProposal(agent, {
      by: agent,
      note: force ? '客服强制调整（超禁住人数，申请主管裁定）' : '客服舱室调整',
      forceOverMaxOccupancy: force,
      edits: [{ cabinId, baseVersion, add: addIds, remove: removeIds }],
    });
    if (result.ok) {
      setMsg({ kind: 'ok', text: '已提交并全量复核' });
      setAddIds([]);
      setRemoveIds([]);
      setForce(false);
      syncBase();
    } else if (result.reason === 'concurrent') {
      setMsg({
        kind: 'err',
        text: `并发冲突：你打开面板后该舱已被 ${cabin.lastEditedBy ?? '他人'} 改动（你基于 v${baseVersion}，当前 v${cabin.version}）。你的修改未被覆盖，已完整保留到「待人工裁定」队列，单号 ${result.arbitrationId}`,
      });
    } else if (result.reason === 'needs_force_approval') {
      setMsg({
        kind: 'err',
        text: `该调整会超过禁住人数，已按强制申请进入「待人工裁定」队列（单号 ${result.arbitrationId}），须主管批准后才会入住；物理床位上限不可突破。`,
      });
    } else {
      setMsg({ kind: 'err', text: result.reason ?? '提交失败' });
    }
  };

  const setStatus = (status: Cabin['status']) => {
    desk.commit(agent, 'CABIN_STATUS', { cabinId, status, by: agent });
    setMsg({
      kind: 'ok',
      text: `舱室已${status === 'sealed' ? '临时封舱' : status === 'locked' ? '锁定' : '恢复正常'}，已全量复核`,
    });
    syncBase();
  };

  return (
    <div className="editor">
      {stale && (
        <div className="editor-msg err" style={{ marginTop: 0 }}>
          ⚠ 该舱在你打开面板后已被 {cabin.lastEditedBy ?? '他人'} 修改（v{baseVersion} → v{cabin.version}）。
          你仍可提交——修改会进入待裁定队列，由人工选择应用或丢弃，不会覆盖对方修改。
        </div>
      )}
      <div className="editor-head">
        <b>{cabinLabel(cabin)}</b>
        <span className="ver">
          面板基准 v{baseVersion} · 当前 v{cabin.version}
          {cabin.lastEditedBy ? ` ·最后修改：${cabin.lastEditedBy}` : ''}
        </span>
        <button className="mini" onClick={onClose}>
          ✕
        </button>
      </div>
      <div className="editor-row">
        <span>
          床位 {cabin.beds} · 禁住 {cabin.maxOccupancy} · {cabin.accessible ? '无障碍舱' : '普通舱'} · 集合点{' '}
          {state.stations.find((s) => s.id === cabin.stationId)?.name}
        </span>
        <span className="status-acts">
          <button className={'mini' + (cabin.status === 'normal' ? ' on' : '')} onClick={() => setStatus('normal')}>
            正常
          </button>
          <button
            className={'mini' + (cabin.status === 'locked' ? ' on' : '')}
            onClick={() => setStatus(cabin.status === 'locked' ? 'normal' : 'locked')}
          >
            🔒 锁舱
          </button>
          <button
            className={'mini danger' + (cabin.status === 'sealed' ? ' on' : '')}
            onClick={() => setStatus(cabin.status === 'sealed' ? 'normal' : 'sealed')}
          >
            🚫 临时封舱
          </button>
        </span>
      </div>

      <div className="editor-cols">
        <div>
          <p className="col-h">在住 {inside.length} 人（勾选移出＝拆单/换出）</p>
          <div className="chips">
            {inside.map((p) => (
              <button
                key={p.id}
                className={'chip out' + (removeIds.includes(p.id) ? ' picked' : '')}
                onClick={() => toggle(removeIds, setRemoveIds, p.id)}
              >
                {p.name}·{p.age}岁{p.age < state.config.childAgeMax ? '·儿童' : ''}
              </button>
            ))}
            {!inside.length && <span className="muted">空舱</span>}
          </div>
        </div>
        <div>
          <p className="col-h">可调入 {candidates.length} 人（勾选加入）</p>
          <div className="chips scroll">
            {candidates.map((p) => (
              <button
                key={p.id}
                className={
                  'chip in' +
                  (addIds.includes(p.id) ? ' picked' : '') +
                  (p.needsAccessible && !cabin.accessible ? ' badfit' : '')
                }
                onClick={() => toggle(addIds, setAddIds, p.id)}
                title={
                  p.needsAccessible
                    ? '该旅客需要无障碍舱'
                    : p.cabinId
                      ? `当前住 ${cabinLabel(state.cabins.find((c) => c.id === p.cabinId)!)}`
                      : '当前未分配'
                }
              >
                {p.name}·{p.age}岁
                {p.needsAccessible ? '·♿' : ''}
                {p.cabinId ? `←${state.cabins.find((c) => c.id === p.cabinId)?.number}` : '·无舱'}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="editor-foot">
        <label className="force">
          <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} />
          强制超过禁住人数（仍不得超过物理床位 {cabin.beds}，须主管裁定）
        </label>
        <div className="spacer" />
        <button onClick={submit} disabled={!addIds.length && !removeIds.length}>
          提交修改
        </button>
      </div>
      {msg && <div className={'editor-msg ' + msg.kind}>{msg.text}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 冲突清单
// ---------------------------------------------------------------------------

const RULE_DOM: Record<RuleCode, string> = {
  OVERSOLD: '总量',
  UNASSIGNED: '总量',
  CABIN_OVERCAP: '舱室',
  CHILD_ALONE: '舱室',
  BOAT_OVERCAP: '救生',
  STATION_IMBALANCE: '集合点',
  TURNAROUND: '周转',
  SEALED_OCCUPIED: '舱室',
  ACCESS_NEED: '舱室',
  GROUP_SPLIT: '团体',
  ADJACENCY: '相邻',
};

function ConflictList({
  conflicts,
  onJumpCabin,
}: {
  conflicts: Conflict[];
  onJumpCabin: (id: string) => void;
}) {
  const { state } = useDesk();
  if (!conflicts.length) return <div className="all-clear">✅ 全部规则通过，无冲突</div>;
  return (
    <ul className="conflicts">
      {conflicts.map((c) => (
        <li key={c.id} className={'conflict ' + c.severity}>
          <div className="cf-head">
            <span className={'dot ' + c.severity}>{c.severity === 'error' ? '●' : '▲'}</span>
            <b>{RULE_LABEL[c.rule]}</b>
            <span className="dom">{RULE_DOM[c.rule]}</span>
            {c.cabinId && (
              <button className="mini" onClick={() => onJumpCabin(c.cabinId!)}>
                {cabinLabel(state.cabins.find((x) => x.id === c.cabinId)!)}
              </button>
            )}
          </div>
          <p className="cf-detail">{c.detail}</p>
          <p className="cf-desc">{RULE_DESC[c.rule]}</p>
          {c.passengerIds?.length ? (
            <div className="cf-pax">
              旅客：
              {c.passengerIds.slice(0, 8).map((id) => {
                const p = state.passengers.find((x) => x.id === id);
                return p ? (
                  <span key={id} className="pchip">
                    {p.name}({p.age})
                  </span>
                ) : null;
              })}
              {c.passengerIds.length > 8 && <span> 等 {c.passengerIds.length} 人</span>}
            </div>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// 登船确认
// ---------------------------------------------------------------------------

function ConfirmationBox({
  voyage,
  errors,
  warnings,
  agent,
  unassignedCount,
  confirmed,
}: {
  voyage: Voyage;
  errors: Conflict[];
  warnings: Conflict[];
  agent: string;
  unassignedCount: number;
  confirmed: boolean;
}) {
  const [ack, setAck] = useState<Record<string, boolean>>({});
  const [msg, setMsg] = useState<string | null>(null);
  const allAck = warnings.every((w) => ack[w.id]);

  const doConfirm = () => {
    if (confirmed) {
      if (confirm('撤回本航次登船清单确认？')) {
        desk.revokeConfirm(voyage.id, agent);
        setMsg('已撤回确认');
      }
      return;
    }
    const res = desk.confirm(voyage.id, agent, Object.keys(ack).filter((k) => ack[k]));
    setMsg(res.ok ? '✅ 登船清单已确认' : `⛔ ${res.reason}`);
  };

  return (
    <div className={'confirm-box' + (confirmed ? ' confirmed' : errors.length ? ' blocked' : '')}>
      <div className="cf-title">
        {confirmed ? '🟢 登船清单已确认' : errors.length ? '🔴 冲突未解除，禁止确认' : '🟡 可确认（需知悉全部警告）'}
      </div>
      {!confirmed && !!warnings.length && (
        <div className="ack-list">
          {warnings.map((w) => (
            <label key={w.id} className="ack">
              <input
                type="checkbox"
                checked={!!ack[w.id]}
                onChange={(e) => setAck({ ...ack, [w.id]: e.target.checked })}
              />
              已知悉：{RULE_LABEL[w.rule]} — {w.detail.slice(0, 26)}…
            </label>
          ))}
        </div>
      )}
      <div className="confirm-meta">
        错误 {errors.length} · 警告 {warnings.length} · 未分配 {unassignedCount}
      </div>
      <button
        className={confirmed ? 'ghost' : 'primary'}
        disabled={!confirmed && (errors.length > 0 || !allAck)}
        onClick={doConfirm}
      >
        {confirmed ? '撤回确认' : '确认登船清单'}
      </button>
      {msg && <p className={'editor-msg ' + (msg.startsWith('✅') ? 'ok' : 'err')}>{msg}</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 裁定队列
// ---------------------------------------------------------------------------

function ArbitrationList({ agent }: { agent: string }) {
  const { state } = useDesk();
  const pending = state.arbitrations.filter((a) => a.status === 'pending');
  if (!pending.length)
    return (
      <div className="muted small">
        无待裁定修改。两名客服基于同一版本先后提交同一舱时，后到修改会在此等待，双方修改都保留。
      </div>
    );
  return (
    <div className="arb-list">
      {pending.map((arb) => (
        <div key={arb.id} className={'arb-card' + (arb.kind === 'force' ? ' force' : '')}>
          <div className="arb-head">
            <b>单号 {arb.id.slice(-6)}</b>
            <span className="dom">{arb.kind === 'force' ? '主管强制审批' : '并发改舱'}</span>
            <span>{arb.proposal.by}</span>
            <span className="muted">{fmtTs(arb.raisedTs)}</span>
          </div>
          <p className="arb-note">“{arb.proposal.note}”</p>
          {arb.kind === 'force' && (
            <p className="arb-stale" style={{ listStyle: 'none', paddingLeft: 0 }}>
              客服申请超过禁住人数（未超物理床位），等待主管强制批准后方可入住。
            </p>
          )}
          {arb.stale.length > 0 && (
            <ul className="arb-stale">
              {arb.stale.map((st) => {
                const c = state.cabins.find((x) => x.id === st.cabinId)!;
                return (
                  <li key={st.cabinId}>
                    {cabinLabel(c)}：提案基于 v{st.baseVersion}，当前已 v{st.currentVersion}
                    {st.currentEditor ? `（${st.currentEditor} 已改）` : ''}
                  </li>
                );
              })}
            </ul>
          )}
          <div className="arb-edits">
            {arb.proposal.edits.map((e) => {
              const c = state.cabins.find((x) => x.id === e.cabinId)!;
              const nowCount = state.passengers.filter((p) => p.cabinId === c.id && p.status !== 'removed').length;
              const after = nowCount + e.add.length - e.remove.length;
              return (
                <div key={e.cabinId}>
                  {cabinLabel(c)}（{nowCount}→{after}，禁住 {c.maxOccupancy}
                  {after > c.maxOccupancy ? ' ⚠超禁住' : ''}）：
                  {e.remove.map((id) => (
                    <span key={id} className="pchip out">
                      移出 {state.passengers.find((p) => p.id === id)?.name}
                    </span>
                  ))}
                  {e.add.map((id) => (
                    <span key={id} className="pchip in">
                      调入 {state.passengers.find((p) => p.id === id)?.name}
                    </span>
                  ))}
                </div>
              );
            })}
          </div>
          <div className="arb-actions">
            {arb.kind === 'force' ? (
              <button
                className="mini"
                onClick={() => desk.resolveArbitration(arb.id, 'apply', agent, '主管批准强制超过禁住人数', true)}
              >
                ✓ 主管批准强制入住
              </button>
            ) : (
              <button
                className="mini"
                onClick={() => desk.resolveArbitration(arb.id, 'apply', agent, '人工裁定：应用后到修改', false)}
              >
                应用其修改（rebase 到当前版本）
              </button>
            )}
            <button
              className="mini ghost"
              onClick={() =>
                desk.resolveArbitration(
                  arb.id,
                  'discard',
                  agent,
                  arb.kind === 'force' ? '主管驳回强制申请' : '人工裁定：丢弃',
                  false,
                )
              }
            >
              {arb.kind === 'force' ? '驳回' : '丢弃'}
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 旅客表
// ---------------------------------------------------------------------------

function PassengerTable({
  voyageId,
  setSelectedCabin,
  agent,
}: {
  voyageId: string;
  setSelectedCabin: (id: string) => void;
  agent: string;
}) {
  const { state, conflicts } = useDesk();
  const [q, setQ] = useState('');
  const pax = state.passengers
    .filter((p) => p.voyageId === voyageId && p.status !== 'removed')
    .filter((p) => !q || p.name.includes(q) || String(p.age).includes(q));
  const paxConflicts = new Map<string, Conflict[]>();
  for (const c of conflicts.filter((x) => x.voyageId === voyageId)) {
    for (const id of c.passengerIds ?? []) {
      const arr = paxConflicts.get(id) ?? [];
      arr.push(c);
      paxConflicts.set(id, arr);
    }
  }

  return (
    <div>
      <div className="table-tools">
        <input placeholder="搜索姓名 / 年龄" value={q} onChange={(e) => setQ(e.target.value)} />
        <PassengerAddForm voyageId={voyageId} agent={agent} />
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>旅客</th>
              <th>年龄</th>
              <th>团体</th>
              <th>需求</th>
              <th>舱室</th>
              <th>关联冲突</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {pax.map((p) => {
              const c = p.cabinId ? state.cabins.find((x) => x.id === p.cabinId) : null;
              const g = state.groups.find((x) => x.id === p.groupId);
              const cfs = paxConflicts.get(p.id) ?? [];
              return (
                <tr
                  key={p.id}
                  className={cfs.some((x) => x.severity === 'error') ? 'row-err' : cfs.length ? 'row-warn' : ''}
                >
                  <td>{p.name}</td>
                  <td>
                    {p.age}
                    {p.age < state.config.childAgeMax ? ' 🧒' : ''}
                  </td>
                  <td>{g?.name ?? '—'}</td>
                  <td>
                    {p.needsAccessible ? '♿ ' : ''}
                    {p.adjacentWithIds?.length ? `相邻×${p.adjacentWithIds.length}` : ''}
                    {!p.needsAccessible && !p.adjacentWithIds?.length ? '—' : ''}
                  </td>
                  <td>
                    {c ? (
                      <button className="mini" onClick={() => setSelectedCabin(c.id)}>
                        {cabinLabel(c)}
                      </button>
                    ) : (
                      <span className="red">未分配</span>
                    )}
                  </td>
                  <td className="cf-cell">
                    {cfs.slice(0, 2).map((cf) => (
                      <span key={cf.id} className={'minicf ' + cf.severity}>
                        {RULE_LABEL[cf.rule]}
                      </span>
                    ))}
                  </td>
                  <td>
                    <button
                      className="mini ghost"
                      onClick={() => {
                        if (confirm(`将旅客 ${p.name} 标记为移除？`))
                          desk.commit(agent, 'PASSENGER_REMOVE', { passengerId: p.id });
                      }}
                    >
                      移除
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function PassengerAddForm({ voyageId, agent }: { voyageId: string; agent: string }) {
  const [name, setName] = useState('');
  const [age, setAge] = useState('30');
  const [acc, setAcc] = useState(false);
  const [groupId, setGroupId] = useState('');
  const { state } = useDesk();

  const add = () => {
    if (!name.trim()) return;
    const passenger: Passenger = {
      id: uid('p'),
      name: name.trim(),
      age: Number(age) || 0,
      voyageId,
      cabinId: null,
      status: 'booked',
      needsAccessible: acc,
      groupId: groupId || undefined,
    };
    desk.commit(agent, 'PASSENGER_ADD', { passenger });
    setName('');
  };

  return (
    <span className="add-form">
      <input placeholder="新旅客姓名" value={name} onChange={(e) => setName(e.target.value)} />
      <input className="w60" type="number" value={age} onChange={(e) => setAge(e.target.value)} title="年龄" />
      <select value={groupId} onChange={(e) => setGroupId(e.target.value)}>
        <option value="">散客</option>
        {state.groups
          .filter((g) => g.voyageId === voyageId)
          .map((g) => (
            <option key={g.id} value={g.id}>
              {g.name}
            </option>
          ))}
      </select>
      <label className="chk">
        <input type="checkbox" checked={acc} onChange={(e) => setAcc(e.target.checked)} />
        ♿
      </label>
      <button className="mini" onClick={add}>
        录入旅客
      </button>
    </span>
  );
}

// ---------------------------------------------------------------------------
// 操作链
// ---------------------------------------------------------------------------

const EVENT_LABEL: Record<string, string> = {
  VOYAGE_ADD: '录入航次',
  VOYAGE_UPDATE: '修改航次',
  STATION_ADD: '录入集合点',
  BOAT_ADD: '录入救生艇',
  CABIN_ADD: '录入舱室',
  CABIN_UPDATE: '修改舱室资料',
  CABIN_STATUS: '锁舱/封舱/恢复',
  GROUP_ADD: '录入团体',
  PASSENGER_ADD: '录入旅客',
  PASSENGER_REMOVE: '移除旅客',
  ASSIGNMENT_CLEAR: '清空分配',
  AUTO_ASSIGN: '自动分配',
  PROPOSAL_APPLY: '舱室调整生效',
  PROPOSAL_RAISE: '并发改舱→待裁定',
  PROPOSAL_DISCARD: '裁定：丢弃',
  CONFIRM: '确认登船清单',
  CONFIRM_REVOKE: '撤回确认',
  CONFIG_UPDATE: '规则参数调整',
};

function EventLog() {
  const { events } = useDesk();
  const [filter, setFilter] = useState('');
  const shown = [...events].reverse().filter((e) => !filter || e.type.includes(filter));
  return (
    <div>
      <div className="table-tools">
        <select value={filter} onChange={(e) => setFilter(e.target.value)}>
          <option value="">全部事件</option>
          {Object.entries(EVENT_LABEL).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
        <span className="muted small">共 {events.length} 条，倒序展示</span>
      </div>
      <ul className="eventlog">
        {shown.slice(0, 120).map((e) => (
          <li key={e.id} className={e.type.startsWith('PROPOSAL_RAISE') ? 'ev-raise' : ''}>
            <span className="ev-id">#{e.id}</span>
            <span className="ev-time">{fmtTs(e.ts)}</span>
            <span className="ev-by">{e.by}</span>
            <b>{EVENT_LABEL[e.type] ?? e.type}</b>
            <EventSummary type={e.type} payload={e.payload as Record<string, unknown>} />
          </li>
        ))}
      </ul>
    </div>
  );
}

function EventSummary({ type, payload }: { type: string; payload: Record<string, unknown> }) {
  const { state } = useDesk();
  const cname = (id?: string) => state.cabins.find((c) => c.id === id);
  if (type === 'CABIN_STATUS') {
    const c = cname(payload.cabinId as string);
    return (
      <span className="ev-detail">
        {c ? cabinLabel(c) : ''} → {String(payload.status)}
      </span>
    );
  }
  if (type === 'PROPOSAL_APPLY') {
    const prop = payload.proposal as {
      note?: string;
      edits: { cabinId: string; add: string[]; remove: string[] }[];
    };
    return (
      <span className="ev-detail">
        {prop.edits
          .map(
            (e) =>
              `${cname(e.cabinId)?.number ?? ''}(${e.remove.length ? `-${e.remove.length}` : ''}${
                e.add.length ? `+${e.add.length}` : ''
              })`,
          )
          .join('，')}
        {payload.note ? `｜${String(payload.note)}` : prop.note ? `｜${prop.note}` : ''}
      </span>
    );
  }
  if (type === 'PROPOSAL_RAISE') {
    const a = payload.arbitration as { id: string; stale: { cabinId: string }[] };
    return (
      <span className="ev-detail red">
        单号 {a.id.slice(-6)}，冲突舱 {a.stale.map((s) => cname(s.cabinId)?.number).join('、')}
      </span>
    );
  }
  if (type === 'AUTO_ASSIGN' || type === 'ASSIGNMENT_CLEAR' || type === 'CONFIRM' || type === 'CONFIRM_REVOKE') {
    const v = state.voyages.find((x) => x.id === payload.voyageId);
    return <span className="ev-detail">{v?.code}</span>;
  }
  if (type === 'PASSENGER_ADD') {
    const p = payload.passenger as Passenger;
    return (
      <span className="ev-detail">
        {p.name}·{p.age}岁
      </span>
    );
  }
  return null;
}

// ---------------------------------------------------------------------------
// 基础数据录入
// ---------------------------------------------------------------------------

function SetupPanel({ agent }: { agent: string }) {
  const { state } = useDesk();
  return (
    <div className="setup">
      <section className="panel">
        <PanelTitle title="航次" hint="连续航次间隔低于周转阈值会触发清洁周转冲突" />
        <VoyageForm agent={agent} />
        <ul className="mini-list">
          {state.voyages.map((v) => (
            <li key={v.id}>
              <b>{v.code}</b> {v.name} · {fmtTs(v.departureTs)} → {fmtTs(v.arrivalTs)} · {v.status}
            </li>
          ))}
        </ul>
      </section>

      <section className="panel">
        <PanelTitle title="集合点 / 救生艇" />
        <StationBoatForm agent={agent} />
        <ul className="mini-list">
          {state.stations.map((st) => (
            <li key={st.id}>
              {st.name}（{st.deck} 甲板，容量 {st.capacity}）— 救生艇：
              {state.boats.filter((b) => b.stationId === st.id).map((b) => `${b.name} ${b.capacity}人`).join('、') || '无'}
            </li>
          ))}
        </ul>
      </section>

      <section className="panel">
        <PanelTitle title="舱室" hint="床位为物理上限，禁住人数为安全定员；可现场调整制造超员场景" />
        <CabinAddForm agent={agent} />
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>舱号</th>
                <th>甲板</th>
                <th>床位</th>
                <th>禁住</th>
                <th>无障碍</th>
                <th>集合点</th>
                <th>版本</th>
              </tr>
            </thead>
            <tbody>
              {state.cabins.map((c) => (
                <CabinSetupRow key={c.id} cabin={c} agent={agent} />
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="panel">
        <PanelTitle title="规则参数" />
        <ConfigForm agent={agent} />
      </section>
    </div>
  );
}

function VoyageForm({ agent }: { agent: string }) {
  const [code, setCode] = useState('DP-TEST');
  const [name, setName] = useState('测试航次');
  const [dep, setDep] = useState('2026-09-23T09:00');
  const [arr, setArr] = useState('2026-09-25T09:00');
  const submit = () => {
    const voyage: Voyage = {
      id: uid('v'),
      code,
      name,
      departureTs: Date.parse(dep),
      arrivalTs: Date.parse(arr),
      status: 'active',
    };
    desk.commit(agent, 'VOYAGE_ADD', { voyage });
  };
  return (
    <div className="form-row">
      <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="航次代码" />
      <input value={name} onChange={(e) => setName(e.target.value)} placeholder="航次名称" />
      <input type="datetime-local" value={dep} onChange={(e) => setDep(e.target.value)} />
      <input type="datetime-local" value={arr} onChange={(e) => setArr(e.target.value)} />
      <button className="mini" onClick={submit}>
        录入航次
      </button>
    </div>
  );
}

function StationBoatForm({ agent }: { agent: string }) {
  const [sname, setSname] = useState('');
  const [scap, setScap] = useState('40');
  const [bname, setBname] = useState('');
  const [bcap, setBcap] = useState('20');
  const [stationId, setStationId] = useState('');
  const { state } = useDesk();
  return (
    <div className="stack-form">
      <div className="form-row">
        <input placeholder="集合点名" value={sname} onChange={(e) => setSname(e.target.value)} />
        <input className="w60" type="number" value={scap} onChange={(e) => setScap(e.target.value)} title="容量" />
        <button
          className="mini"
          onClick={() => {
            if (!sname.trim()) return;
            desk.commit(agent, 'STATION_ADD', {
              station: { id: uid('s'), name: sname.trim(), deck: '?', capacity: Number(scap) },
            });
            setSname('');
          }}
        >
          录入集合点
        </button>
      </div>
      <div className="form-row">
        <input placeholder="救生艇名" value={bname} onChange={(e) => setBname(e.target.value)} />
        <input className="w60" type="number" value={bcap} onChange={(e) => setBcap(e.target.value)} title="定员" />
        <select value={stationId} onChange={(e) => setStationId(e.target.value)}>
          <option value="">归属集合点</option>
          {state.stations.map((st) => (
            <option key={st.id} value={st.id}>
              {st.name}
            </option>
          ))}
        </select>
        <button
          className="mini"
          onClick={() => {
            if (!bname.trim() || !stationId) return;
            desk.commit(agent, 'BOAT_ADD', {
              boat: { id: uid('b'), name: bname.trim(), stationId, capacity: Number(bcap) },
            });
            setBname('');
          }}
        >
          录入救生艇
        </button>
      </div>
    </div>
  );
}

function CabinAddForm({ agent }: { agent: string }) {
  const [number, setNumber] = useState('401');
  const [deck, setDeck] = useState('4');
  const [beds, setBeds] = useState('2');
  const [max, setMax] = useState('2');
  const [stationId, setStationId] = useState('');
  const [acc, setAcc] = useState(false);
  const { state } = useDesk();
  return (
    <div className="form-row">
      <input className="w60" value={number} onChange={(e) => setNumber(e.target.value)} placeholder="舱号" />
      <input className="w50" value={deck} onChange={(e) => setDeck(e.target.value)} placeholder="甲板" />
      <input className="w60" type="number" value={beds} onChange={(e) => setBeds(e.target.value)} title="床位" />
      <input className="w60" type="number" value={max} onChange={(e) => setMax(e.target.value)} title="禁住人数" />
      <select value={stationId} onChange={(e) => setStationId(e.target.value)}>
        <option value="">集合点</option>
        {state.stations.map((st) => (
          <option key={st.id} value={st.id}>
            {st.name}
          </option>
        ))}
      </select>
      <label className="chk">
        <input type="checkbox" checked={acc} onChange={(e) => setAcc(e.target.checked)} />
        ♿
      </label>
      <button
        className="mini"
        onClick={() => {
          if (!stationId) return alert('请选择集合点');
          const cabin: Cabin = {
            id: uid('c'),
            number: Number(number),
            deck,
            beds: Number(beds),
            maxOccupancy: Number(max),
            accessible: acc,
            stationId,
            status: 'normal',
            version: 0,
          };
          desk.commit(agent, 'CABIN_ADD', { cabin });
        }}
      >
        录入舱室
      </button>
    </div>
  );
}

function CabinSetupRow({ cabin, agent }: { cabin: Cabin; agent: string }) {
  const { state } = useDesk();
  const update = (patch: Partial<Pick<Cabin, 'beds' | 'maxOccupancy' | 'stationId' | 'accessible'>>) =>
    desk.commit(agent, 'CABIN_UPDATE', { id: cabin.id, patch, by: agent });
  return (
    <tr>
      <td>{cabin.number}</td>
      <td>{cabin.deck}</td>
      <td>
        <input
          className="w50"
          type="number"
          defaultValue={cabin.beds}
          onBlur={(e) => Number(e.target.value) !== cabin.beds && update({ beds: Number(e.target.value) })}
        />
      </td>
      <td>
        <input
          className="w50"
          type="number"
          defaultValue={cabin.maxOccupancy}
          onBlur={(e) =>
            Number(e.target.value) !== cabin.maxOccupancy && update({ maxOccupancy: Number(e.target.value) })
          }
        />
      </td>
      <td>
        <input
          type="checkbox"
          defaultChecked={cabin.accessible}
          onChange={(e) => update({ accessible: e.target.checked })}
        />
      </td>
      <td>
        <select defaultValue={cabin.stationId} onChange={(e) => update({ stationId: e.target.value })}>
          {state.stations.map((st) => (
            <option key={st.id} value={st.id}>
              {st.name}
            </option>
          ))}
        </select>
      </td>
      <td className="muted small">v{cabin.version}</td>
    </tr>
  );
}

function ConfigForm({ agent }: { agent: string }) {
  const { state } = useDesk();
  const c = state.config;
  const upd = (patch: Partial<typeof c>) => desk.commit(agent, 'CONFIG_UPDATE', { patch });
  return (
    <div className="form-grid">
      <label>
        救生艇冗余{' '}
        <input
          type="number"
          defaultValue={Math.round(c.boatCapacityMargin * 100)}
          onBlur={(e) => upd({ boatCapacityMargin: Number(e.target.value) / 100 })}
        />
        %
      </label>
      <label>
        集合点失衡阈值{' '}
        <input
          type="number"
          defaultValue={Math.round(c.stationImbalanceRatio * 100)}
          onBlur={(e) => upd({ stationImbalanceRatio: Number(e.target.value) / 100 })}
        />
        %
      </label>
      <label>
        最少周转{' '}
        <input
          type="number"
          defaultValue={c.minTurnaroundMs / 3600000}
          onBlur={(e) => upd({ minTurnaroundMs: Number(e.target.value) * 3600000 })}
        />
        小时
      </label>
      <label>
        儿童年龄 &lt;{' '}
        <input type="number" defaultValue={c.childAgeMax} onBlur={(e) => upd({ childAgeMax: Number(e.target.value) })} />
        岁
      </label>
      <label>
        陪同年龄 ≥{' '}
        <input
          type="number"
          defaultValue={c.escortAgeMin}
          onBlur={(e) => upd({ escortAgeMin: Number(e.target.value) })}
        />
        岁
      </label>
      <label>
        相邻舱号差 ≤{' '}
        <input
          type="number"
          defaultValue={c.adjacencyCabinGap}
          onBlur={(e) => upd({ adjacencyCabinGap: Number(e.target.value) })}
        />
      </label>
    </div>
  );
}
