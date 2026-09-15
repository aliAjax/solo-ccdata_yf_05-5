// 验收脚本：完整走通 录入 → 分配 → 复核 → 处置 → 确认
// 覆盖：超员、陪同缺失、周转冲突、并发改舱（双提案保留 + 人工裁定）
// 运行：node scripts/acceptance.mjs（用 tsc 即时编译 src/cruise，无需额外依赖）
import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

// --- tsc 把 src/cruise 编译为 CommonJS 到临时目录 ---
const outDir = join(tmpdir(), 'cruise-acceptance');
mkdirSync(outDir, { recursive: true });
execFileSync(
  process.execPath,
  [
    join(root, 'node_modules/typescript/bin/tsc'),
    join(root, 'src/cruise/types.ts'),
    join(root, 'src/cruise/engine.ts'),
    join(root, 'src/cruise/seed.ts'),
    '--outDir',
    outDir,
    '--module',
    'commonjs',
    '--target',
    'es2022',
    '--skipLibCheck',
    '--ignoreConfig',
    '--strict',
    'false',
  ],
  { stdio: 'inherit' },
);
writeFileSync(join(outDir, 'package.json'), JSON.stringify({ type: 'commonjs' }));
const engine = await import(pathToFileURL(join(outDir, 'engine.js')).href);
const seedMod = await import(pathToFileURL(join(outDir, 'seed.js')).href);

// ---------------------------------------------------------------------------
// 微型断言框架
// ---------------------------------------------------------------------------
let passed = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) {
    passed += 1;
    console.log(`  ✅ ${name}`);
  } else {
    failures.push({ name, detail });
    console.log(`  ❌ ${name} ${detail}`);
  }
}
function group(name) {
  console.log(`\n■ ${name}`);
}
function hasRule(conflicts, rule, voyageId) {
  return conflicts.some((c) => c.rule === rule && (!voyageId || c.voyageId === voyageId));
}
function findRule(conflicts, rule, voyageId) {
  return conflicts.find((c) => c.rule === rule && (!voyageId || c.voyageId === voyageId));
}
function paxIds(conflict) {
  return new Set(conflict.passengerIds ?? []);
}

// ---------------------------------------------------------------------------
// 文件持久化适配器（验证“刷新后仍在”）
// ---------------------------------------------------------------------------
function fileAdapter(path) {
  return {
    load() {
      if (!existsSync(path)) return null;
      return JSON.parse(readFileSync(path, 'utf8'));
    },
    save(events) {
      writeFileSync(path, JSON.stringify(events));
    },
  };
}

// ===========================================================================
// 场景 0：录入 + 自动分配 + 初始复核
// ===========================================================================
group('场景 0｜基础数据录入与自动分配');
let store = seedMod.buildSeedStore(true);
let s = store.state;
check('录入 2 个航次', s.voyages.length === 2);
check('录入 20 间舱室', s.cabins.length === 20);
check('录入 5 艘救生艇 / 3 个集合点', s.boats.length === 5 && s.stations.length === 3);
check('v1 录入 30 名旅客', engine.voyagePassengers(s, 'v1').length === 30);
check('v2 录入 10 名旅客', engine.voyagePassengers(s, 'v2').length === 10);
let conflicts = engine.revalidate(s);
const v1Errors0 = conflicts.filter((c) => c.voyageId === 'v1' && c.severity === 'error');
check('v1 分配后无错误级冲突', v1Errors0.length === 0, v1Errors0.map((c) => c.detail).join(' / '));
const v2Unassigned = findRule(conflicts, 'UNASSIGNED', 'v2');
check('v2 已录入但未分配 → UNASSIGNED 错误拦截确认', !!v2Unassigned && v2Unassigned.passengerIds.length === 10);
check('v2 未分配状态不能确认登船清单', engine.confirmVoyage(store, 'v2', '主管', [], conflicts).ok === false);
const groupSplit = findRule(conflicts, 'GROUP_SPLIT', 'v1');
check('5 人张家因无 ≥5 人舱被标记拆分警告', !!groupSplit && groupSplit.cabinIds.length === 2);
check('无障碍老人住无障碍舱', s.passengers.find((p) => p.id === 'p05').cabinId && s.cabins.find((c) => c.id === s.passengers.find((p) => p.id === 'p05').cabinId).accessible);
check('无旅客漏分配', engine.voyagePassengers(s, 'v1').every((p) => p.cabinId));
const assignedCabin = s.cabins.find((c) => c.id === s.passengers.find((p) => p.id === 'p03').cabinId);
check('儿童所在舱有成人陪同', assignedCabin && s.passengers.some((p) => p.cabinId === assignedCabin.id && p.age >= 18));

// ===========================================================================
// 场景 1：超员（舱室超禁住人数 + 救生艇/集合点容量）
// ===========================================================================
group('场景 1｜超员：下调禁住人数 → CABIN_OVERCAP；确认门禁拦截');
{
  // 找一间当前有人的普通舱，记录其在住人数与禁住人数
  const occ = engine.cabinOccupancy(s, 'v1');
  const target = s.cabins.find((c) => (occ.get(c.id)?.length ?? 0) >= 2 && !c.accessible);
  const before = occ.get(target.id).length;
  engine.appendEvent(store, '客服·小周', 'CABIN_UPDATE', {
    id: target.id,
    patch: { maxOccupancy: before - 1 },
    by: '客服·小周',
    ts: Date.now(),
  });
  conflicts = engine.revalidate(s);
  const overcap = findRule(conflicts, 'CABIN_OVERCAP', 'v1');
  check('触发 CABIN_OVERCAP', !!overcap && overcap.cabinId === target.id);
  check('冲突指明舱室与全部在住旅客', overcap && paxIds(overcap).size === before);
  check('冲突文案含禁住人数数值', overcap.detail.includes(String(before - 1)));

  // 错误级冲突未解除 → 确认被拒
  const r = engine.confirmVoyage(store, 'v1', '客服·小周', [], conflicts);
  check('存在未解除错误时确认登船清单被拒', r.ok === false);
  check('拒绝理由给出冲突数量', r.reason.includes('1'));

  // 解除：恢复禁住人数
  engine.appendEvent(store, '客服·小周', 'CABIN_UPDATE', {
    id: target.id,
    patch: { maxOccupancy: before },
    by: '客服·小周',
    ts: Date.now(),
  });
  conflicts = engine.revalidate(s);
  check('恢复后 CABIN_OVERCAP 消失（稳定 ID 不再出现）', !hasRule(conflicts, 'CABIN_OVERCAP', 'v1'));

  // 真·超售：再补录 40 名旅客（远超 55 张可住床位），且无舱可分
  const extra = Array.from({ length: 40 }, (_, i) => ({
    id: `px${i}`,
    name: `超售客${i}`,
    age: 30,
    voyageId: 'v1',
    cabinId: null,
    status: 'booked',
  }));
  for (const passenger of extra) {
    engine.appendEvent(store, '客服·小周', 'PASSENGER_ADD', { passenger, ts: Date.now() });
  }
  conflicts = engine.revalidate(s);
  const oversold = findRule(conflicts, 'OVERSOLD', 'v1');
  check('补录后触发真超售 OVERSOLD（70 > 可住床位）', !!oversold && oversold.detail.includes('缺口') && oversold.detail.includes('70'));
  check('同时存在 UNASSIGNED 指明无舱旅客', hasRule(conflicts, 'UNASSIGNED', 'v1'));
  check('超售状态不能确认', engine.confirmVoyage(store, 'v1', '主管', [], conflicts).ok === false);
  // 撤掉补录旅客，回到干净状态
  for (const p of extra) {
    engine.appendEvent(store, '客服·小周', 'PASSENGER_REMOVE', { passengerId: p.id, ts: Date.now() });
  }
  conflicts = engine.revalidate(s);
  check('撤回补录后超售与未分配均消失', !hasRule(conflicts, 'OVERSOLD', 'v1') && !hasRule(conflicts, 'UNASSIGNED', 'v1'));

  // 超过禁住人数：不强制 → 拒绝；勾选强制 → 进裁定队列，主管批准后才超员入住并报 CABIN_OVERCAP
  const occ0b = engine.cabinOccupancy(s, 'v1');
  const capCabin = s.cabins.find((c) => c.status === 'normal' && (occ0b.get(c.id)?.length ?? 0) === c.maxOccupancy && c.beds > c.maxOccupancy);
  check('找到可强制超员的舱（床位>禁住）', !!capCabin);
  if (capCabin) {
    const freeAdult = s.passengers.find((p) => p.voyageId === 'v1' && p.status !== 'removed' && p.cabinId && p.cabinId !== capCabin.id && p.age >= 18 && !p.adjacentWithIds?.length && !p.groupId);
    const capBase = capCabin.version;
    const srcCabin = s.cabins.find((c) => c.id === freeAdult.cabinId);
    // 未勾选强制 → 硬拒绝，不产生任何事件变更
    const deny = engine.dispatchCabinProposal(store, '客服·小周', {
      by: '客服·小周', note: '试图多塞一人', forceOverMaxOccupancy: false,
      edits: [{ cabinId: capCabin.id, baseVersion: capBase, add: [freeAdult.id], remove: [] }],
    });
    check('超禁住人数且未强制 → 直接拒绝', deny.ok === false && deny.reason.includes('禁住人数'));
    check('拒绝不留裁定单、旅客未动', s.arbitrations.every((a) => a.proposal.note !== '试图多塞一人') && s.passengers.find((p) => p.id === freeAdult.id).cabinId === srcCabin.id);
    // 勾选强制 → 进裁定队列（force 类），现场不超员
    const ask = engine.dispatchCabinProposal(store, '客服·小周', {
      by: '客服·小周', note: '申请强制超禁住', forceOverMaxOccupancy: true,
      edits: [{ cabinId: capCabin.id, baseVersion: capBase, add: [freeAdult.id], remove: [] }],
    });
    check('勾选强制 → 进入裁定队列待主管批准', ask.ok === false && ask.reason === 'needs_force_approval' && !!ask.arbitrationId);
    const fArb = s.arbitrations.find((a) => a.id === ask.arbitrationId);
    check('裁定单类型为 force', fArb.kind === 'force');
    check('批准前现场未超员（无 CABIN_OVERCAP）', !engine.revalidate(s).some((c) => c.rule === 'CABIN_OVERCAP' && c.cabinId === capCabin.id));
    // 主管驳回一次：现场仍不变
    engine.resolveArbitration(store, fArb.id, 'discard', '主管', '证据不足，驳回', false);
    check('驳回后旅客仍在原舱', s.passengers.find((p) => p.id === freeAdult.id).cabinId === srcCabin.id);
    // 重新申请，主管批准（force=true）
    const ask2 = engine.dispatchCabinProposal(store, '客服·小周', {
      by: '客服·小周', note: '补充医疗证明，再次申请强制', forceOverMaxOccupancy: true,
      edits: [{ cabinId: capCabin.id, baseVersion: s.cabins.find((c) => c.id === capCabin.id).version, add: [freeAdult.id], remove: [] }],
    });
    engine.resolveArbitration(store, ask2.arbitrationId, 'apply', '主管', '批准强制入住', true);
    check('主管批准后旅客入住', s.passengers.find((p) => p.id === freeAdult.id).cabinId === capCabin.id);
    conflicts = engine.revalidate(s);
    const oc = conflicts.find((c) => c.rule === 'CABIN_OVERCAP' && c.cabinId === capCabin.id);
    check('超禁住入住 → CABIN_OVERCAP 错误（仍可被复核与确认门禁拦截）', !!oc);
    check('此时不能确认登船清单', engine.confirmVoyage(store, 'v1', '主管', [], conflicts).ok === false);
    // 恢复现场：旅客移回原舱
    engine.dispatchCabinProposal(store, '主管', {
      by: '主管', note: '取消强制，移回原舱',
      edits: [{ cabinId: capCabin.id, baseVersion: s.cabins.find((c) => c.id === capCabin.id).version, add: [], remove: [freeAdult.id] },
              { cabinId: srcCabin.id, baseVersion: s.cabins.find((c) => c.id === srcCabin.id).version, add: [freeAdult.id], remove: [] }],
    });
    conflicts = engine.revalidate(s);
    check('移回后 CABIN_OVERCAP 消失', !conflicts.some((c) => c.rule === 'CABIN_OVERCAP'));
  }
}

// ===========================================================================
// 场景 2：儿童陪同缺失（换舱后 CHILD_ALONE）
// ===========================================================================
group('场景 2｜儿童陪同缺失：把成人换走 → CHILD_ALONE → 换回解除');
{
  const occ = engine.cabinOccupancy(s, 'v1');
  // 找“1 成人 + 至少 1 儿童”的舱
  const mixed = [...occ.entries()].find(([, ps]) => {
    const adults = ps.filter((p) => p.age >= 18).length;
    const kids = ps.filter((p) => p.age < 18).length;
    return adults === 1 && kids >= 1;
  });
  check('种子中存在单成人带儿童舱', !!mixed);
  if (mixed) {
    const [cabinId, ps] = mixed;
    const adult = ps.find((p) => p.age >= 18);
    const kids = ps.filter((p) => p.age < 18);
    // 找一间有空床且不造成新陪同问题的成人舱（普通散客舱）
    const otherCabin = s.cabins.find(
      (c) => c.id !== cabinId && c.status === 'normal' && (occ.get(c.id)?.length ?? 0) < c.maxOccupancy,
    );
    const cabinBefore = s.cabins.find((c) => c.id === cabinId).version;
    const otherBefore = s.cabins.find((c) => c.id === otherCabin.id).version;
    // 换舱：从原舱 remove 成人，add 到另一舱
    const r1 = engine.dispatchCabinProposal(store, '客服·小周', {
      by: '客服·小周',
      note: '把成人临时换到隔壁',
      edits: [
        { cabinId, baseVersion: cabinBefore, add: [], remove: [adult.id] },
        { cabinId: otherCabin.id, baseVersion: otherBefore, add: [adult.id], remove: [] },
      ],
    });
    check('换舱提案直接生效', r1.ok === true);
    conflicts = engine.revalidate(s);
    const alone = findRule(conflicts, 'CHILD_ALONE', 'v1');
    check('触发 CHILD_ALONE', !!alone && alone.cabinId === cabinId);
    check('陪同冲突指明舱室与涉事儿童', alone && kids.every((k) => paxIds(alone).has(k.id)));
    check('陪同冲突期间不能确认', engine.confirmVoyage(store, 'v1', '客服·小周', [], conflicts).ok === false);

    // 处置：成人换回（注意版本号已 +1，必须读取当前版本——这正是并发保护点）
    const cabinNow = s.cabins.find((c) => c.id === cabinId).version;
    const otherNow = s.cabins.find((c) => c.id === otherCabin.id).version;
    const r2 = engine.dispatchCabinProposal(store, '客服·小周', {
      by: '客服·小周',
      note: '成人换回陪同',
      edits: [
        { cabinId: otherCabin.id, baseVersion: otherNow, add: [], remove: [adult.id] },
        { cabinId, baseVersion: cabinNow, add: [adult.id], remove: [] },
      ],
    });
    check('成人换回生效', r2.ok === true);
    conflicts = engine.revalidate(s);
    check('CHILD_ALONE 解除', !hasRule(conflicts, 'CHILD_ALONE', 'v1'));
  }
}

// ===========================================================================
// 场景 3：清洁周转冲突
// ===========================================================================
group('场景 3｜清洁周转：v2 复用 v1 刚用过的舱（间隔 4h < 6h）→ TURNAROUND');
{
  // 先给 v2 自动分配
  engine.appendEvent(store, '客服·小周', 'AUTO_ASSIGN', { voyageId: 'v2', ts: Date.now() });
  conflicts = engine.revalidate(s);
  // 自动分配不感知周转，找到周转冲突
  let turn = conflicts.filter((c) => c.rule === 'TURNAROUND');
  check('自动分配后出现 TURNAROUND 冲突（两航次间隔 4h）', turn.length > 0, turn.map((t) => t.detail).join(' / '));
  if (turn.length) {
    const t0 = turn[0];
    check('周转冲突指明舱室与航次对', !!t0.cabinId && t0.voyagePair?.length === 2);
    check('v2 存在错误级冲突，不能确认', engine.blockingConflicts(conflicts, 'v2').length > 0);
    // 处置：清空 v2 分配，只把 v2 旅客安排进 v1 未使用的舱（示意：用 clear + 手工提案）
    engine.clearAssignment(store, 'v2', '客服·小周');
    const v1UsedCabins = new Set(engine.voyagePassengers(s, 'v1').map((p) => p.cabinId));
    const safeCabins = s.cabins.filter((c) => !v1UsedCabins.has(c.id));
    const v2Pax = engine.voyagePassengers(s, 'v2');
    const edits = [];
    let ci = 0;
    let placed = 0;
    for (const cabin of safeCabins) {
      const room = cabin.maxOccupancy;
      const take = v2Pax.slice(placed, placed + room);
      if (take.length) edits.push({ cabinId: cabin.id, baseVersion: s.cabins.find((c) => c.id === cabin.id).version, add: take.map((p) => p.id), remove: [] });
      placed += take.length;
      ci += 1;
      if (placed >= v2Pax.length) break;
    }
    const rr = engine.dispatchCabinProposal(store, '客服·小周', {
      by: '客服·小周',
      note: 'v2 旅客全部改排至 v1 未使用舱，规避周转',
      edits,
    });
    check('规避周转的重排生效', rr.ok, rr.reason ?? '');
    conflicts = engine.revalidate(s);
    check('TURNAROUND 全部解除', !conflicts.some((c) => c.rule === 'TURNAROUND'));
    check('v2 全部旅客有舱', engine.voyagePassengers(s, 'v2').every((p) => p.cabinId));
  }
}

// ===========================================================================
// 场景 4：并发改舱 —— 两份修改都保留，人工裁定，禁止静默覆盖
// ===========================================================================
group('场景 4｜两名客服同时修改同一舱：后到提案进入裁定队列');
{
  // 回到 v1 干净状态：清空重排 v1
  engine.clearAssignment(store, 'v1', '管理员');
  engine.appendEvent(store, '管理员', 'AUTO_ASSIGN', { voyageId: 'v1', ts: Date.now() });
  conflicts = engine.revalidate(s);

  const occ = engine.cabinOccupancy(s, 'v1');
  // 客服 A、B 同时打开舱 X 和舱 Y 的操作面板（基准版本相同）
  const cabinX = s.cabins.find((c) => (occ.get(c.id)?.length ?? 0) === 2);
  const cabinY = s.cabins.find((c) => c.id !== cabinX?.id && (occ.get(c.id)?.length ?? 0) < c.maxOccupancy);
  const [a1, a2] = occ.get(cabinX.id);
  const unassignedPax = engine.voyagePassengers(s, 'v1').find((p) => !p.cabinId) ?? null;
  check('选取到测试舱 X（2 人）与有空床位的 Y', !!cabinX && !!cabinY);

  const baseX = cabinX.version;
  const baseY = cabinY.version;

  // 客服 A：把 a1 从 X 换到 Y
  const resA = engine.dispatchCabinProposal(store, '客服·小周', {
    by: '客服·小周',
    note: `A：${a1.name} 从 X 调到 Y`,
    edits: [
      { cabinId: cabinX.id, baseVersion: baseX, add: [], remove: [a1.id] },
      { cabinId: cabinY.id, baseVersion: baseY, add: [a1.id], remove: [] },
    ],
  });
  check('客服 A 的修改生效', resA.ok === true);
  check('X 舱版本号 +1', s.cabins.find((c) => c.id === cabinX.id).version === baseX + 1);

  // 客服 B 在 A 提交前后未刷新面板，仍持旧版本：把 a2 从 X 换到 Y
  const resB = engine.dispatchCabinProposal(store, '客服·小钱', {
    by: '客服·小钱',
    note: `B：${a2.name} 从 X 调到 Y`,
    edits: [
      { cabinId: cabinX.id, baseVersion: baseX, add: [], remove: [a2.id] }, // 过期版本
      { cabinId: cabinY.id, baseVersion: baseY, add: [a2.id], remove: [] }, // 过期版本
    ],
  });
  check('客服 B 的修改未静默覆盖，被拦下', resB.ok === false && resB.reason === 'concurrent');
  check('返回裁定单号', !!resB.arbitrationId);

  const arb = s.arbitrations.find((x) => x.id === resB.arbitrationId);
  check('裁定队列保留 B 的完整原始修改', arb && arb.status === 'pending' && arb.proposal.edits.length === 2);
  check('裁定单记录过期舱与版本/最后修改人', arb && arb.stale.length === 2 && arb.stale.every((z) => z.currentEditor === '客服·小周'));
  check('A 的修改仍在（a1 已在 Y）', s.passengers.find((p) => p.id === a1.id).cabinId === cabinY.id);
  check('B 的修改未生效（a2 仍在 X）', s.passengers.find((p) => p.id === a2.id).cabinId === cabinX.id);

  // 人工裁定：应用 B（rebase 到当前版本）
  engine.resolveArbitration(store, arb.id, 'apply', '主管', '两份换舱都有效，接续办理', false);
  const arb2 = s.arbitrations.find((x) => x.id === arb.id);
  check('裁定应用后状态 applied', arb2.status === 'applied');
  check('B 的修改在 A 之后保留并落地（a2 到 Y）', s.passengers.find((p) => p.id === a2.id).cabinId === cabinY.id);
  check('A 的修改未被覆盖（a1 仍在 Y）', s.passengers.find((p) => p.id === a1.id).cabinId === cabinY.id);

  // 第二个并发案例：裁定为丢弃
  const baseX2 = s.cabins.find((c) => c.id === cabinX.id).version;
  const baseY2 = s.cabins.find((c) => c.id === cabinY.id).version;
  // A 又改一次
  engine.dispatchCabinProposal(store, '客服·小周', {
    by: '客服·小周',
    note: 'A：再次调整 Y→X',
    edits: [
      { cabinId: cabinY.id, baseVersion: baseY2, add: [], remove: [a1.id] },
      { cabinId: cabinX.id, baseVersion: baseX2, add: [a1.id], remove: [] },
    ],
  });
  // B 持旧版本再提：物理硬约束演示——尝试把过多人塞进 X
  const resB2 = engine.dispatchCabinProposal(store, '客服·小钱', {
    by: '客服·小钱',
    note: 'B 旧面板：向 X 加人',
    edits: [{ cabinId: cabinX.id, baseVersion: baseX2, add: [a2.id], remove: [] }],
  });
  // a2 此刻在 Y，X 当前若满则直接被物理床位/状态拦截或进仲裁（取决于版本）
  check('物理校验对第二客服同样生效（拒绝或进仲裁，绝不脏写）', resB2.ok === false);
  if (resB2.arbitrationId) {
    const arb3 = s.arbitrations.find((x) => x.id === resB2.arbitrationId);
    engine.resolveArbitration(store, arb3.id, 'discard', '主管', '重复调舱，丢弃 B 单', false);
    check('裁定丢弃后状态 discarded', s.arbitrations.find((x) => x.id === arb3.id).status === 'discarded');
    check('丢弃不改变现场（a2 仍在 Y）', s.passengers.find((p) => p.id === a2.id).cabinId === cabinY.id);
  }
  conflicts = engine.revalidate(s);
  check('并发处置后全量复核无错误级冲突', !conflicts.some((c) => c.severity === 'error'), conflicts.filter(c=>c.severity==='error').map(c=>c.detail).join(' / '));
}

// ===========================================================================
// 场景 5：锁舱 / 临时封舱 后全量复核
// ===========================================================================
group('场景 5｜锁舱与临时封舱：封舱住客报错、锁舱不参与自动分配');
{
  const occ = engine.cabinOccupancy(s, 'v1');
  const occupiedCabin = s.cabins.find((c) => (occ.get(c.id)?.length ?? 0) > 0 && c.status === 'normal');
  engine.setCabinStatus(store, occupiedCabin.id, 'sealed', '客房部');
  conflicts = engine.revalidate(s);
  const sealed = findRule(conflicts, 'SEALED_OCCUPIED', 'v1');
  check('封有住客的舱 → SEALED_OCCUPIED', !!sealed && sealed.cabinId === occupiedCabin.id);
  check('封舱冲突指明在住旅客', sealed && paxIds(sealed).size === occ.get(occupiedCabin.id).length);
  check('封舱期间不能确认', engine.confirmVoyage(store, 'v1', '主管', [], conflicts).ok === false);
  // 解封
  engine.setCabinStatus(store, occupiedCabin.id, 'normal', '客房部');
  conflicts = engine.revalidate(s);
  check('解封后冲突消失', !hasRule(conflicts, 'SEALED_OCCUPIED', 'v1'));

  // 锁舱：清空重排后锁定的舱不被自动分配使用
  const lockCabin = s.cabins.find((c) => c.status === 'normal');
  engine.setCabinStatus(store, lockCabin.id, 'locked', '客服·小周');
  engine.clearAssignment(store, 'v1', '客服·小周');
  engine.appendEvent(store, '客服·小周', 'AUTO_ASSIGN', { voyageId: 'v1', ts: Date.now() });
  check('锁舱未被自动分配占用', !engine.voyagePassengers(s, 'v1').some((p) => p.cabinId === lockCabin.id));
  engine.setCabinStatus(store, lockCabin.id, 'normal', '客服·小周');
}

// ===========================================================================
// 场景 6：确认登船清单（警告知悉 + 确认后再变更自动失效）
// ===========================================================================
group('场景 6｜确认门禁：警告须知悉；确认后引入新冲突则不能放行');
{
  engine.clearAssignment(store, 'v1', '管理员');
  engine.appendEvent(store, '管理员', 'AUTO_ASSIGN', { voyageId: 'v1', ts: Date.now() });
  conflicts = engine.revalidate(s);
  const errors = engine.blockingConflicts(conflicts, 'v1');
  const warnings = conflicts.filter((c) => c.voyageId === 'v1' && c.severity === 'warning');
  check('重排后无错误级冲突', errors.length === 0, errors.map((e) => e.detail).join(' / '));
  check('存在团体拆分警告待知悉', warnings.length >= 1);

  const r1 = engine.confirmVoyage(store, 'v1', '主管', [], conflicts);
  check('未知悉警告不能确认', r1.ok === false);

  const r2 = engine.confirmVoyage(store, 'v1', '主管', warnings.map((w) => w.id), conflicts);
  check('全部知悉后确认成功', r2.ok === true);
  check('航次状态 confirmed', s.voyages.find((v) => v.id === 'v1').status === 'confirmed');

  // 确认后再制造一个错误（封有住客舱）—— 复核出现错误，确认记录必须立即自动失效
  const occ = engine.cabinOccupancy(s, 'v1');
  const target = s.cabins.find((c) => (occ.get(c.id)?.length ?? 0) > 0);
  engine.setCabinStatus(store, target.id, 'sealed', '客房部');
  conflicts = engine.revalidate(s);
  check('确认后新产生错误级冲突', engine.blockingConflicts(conflicts, 'v1').length > 0);

  // Store 的 afterChange 会立即执行失效清扫（此处直接调引擎模拟该统一入口）
  const invalidatedIds = engine.sweepInvalidations(store, '系统');
  check('失效清扫命中 v1', invalidatedIds.includes('v1'));
  const conf1 = s.confirmations['v1'];
  check('原确认记录保留但已标记 invalidated', !!conf1 && !!conf1.invalidated);
  check('失效记录含触发冲突与原因', conf1.invalidated.conflictIds.length > 0 && conf1.invalidated.reason.includes('错误级冲突'));
  check('航次状态变为 invalidated', s.voyages.find((v) => v.id === 'v1').status === 'invalidated');
  check('失效已写入操作链（CONFIRM_INVALIDATED 事件）', store.events.some((e) => e.type === 'CONFIRM_INVALIDATED' && e.payload.voyageId === 'v1'));
  check('失效后确认不再有效（isConfirmationValid=false）', engine.isConfirmationValid(s, 'v1') === false);

  // 幂等：再次清扫不应重复追加失效事件
  const evCountBefore = store.events.filter((e) => e.type === 'CONFIRM_INVALIDATED').length;
  engine.sweepInvalidations(store, '系统');
  const evCountAfter = store.events.filter((e) => e.type === 'CONFIRM_INVALIDATED').length;
  check('失效清扫幂等（不重复入链）', evCountBefore === evCountAfter);

  // 解除冲突后可重新确认：先解封
  engine.setCabinStatus(store, target.id, 'normal', '客房部');
  // 旧确认已失效，需重新走确认流程
  conflicts = engine.revalidate(s);
  check('解封后无错误级冲突', engine.blockingConflicts(conflicts, 'v1').length === 0);
  const r3 = engine.confirmVoyage(store, 'v1', '主管', warnings.map((w) => w.id), conflicts);
  check('解除后重新确认成功', r3.ok === true);
  const conf2 = s.confirmations['v1'];
  check('重新确认产生新的有效确认记录', !!conf2 && !conf2.invalidated);
}

// ===========================================================================
// 场景 8：集合点单点超容（只有一个集合点在用也必须报超容）
// ===========================================================================
group('场景 8｜单点超容：全船旅客归集到同一集合点且超过其容量');
{
  // 新增一个容量为 1 的集合点 + 1 艘足够大的救生艇 + 2 间归属它的舱 + 1 个新航次
  engine.appendEvent(store, '系统', 'STATION_ADD', { station: { id: 'sSolo', name: 'S 单点集合点', deck: '9', capacity: 1 }, ts: Date.now() });
  engine.appendEvent(store, '系统', 'BOAT_ADD', { boat: { id: 'bSolo', name: '救生艇 S 号', stationId: 'sSolo', capacity: 20 }, ts: Date.now() });
  const soloCabs = [
    { id: 'cS1', number: 901, deck: '9', beds: 2, maxOccupancy: 2, accessible: false, stationId: 'sSolo', status: 'normal', version: 0 },
    { id: 'cS2', number: 902, deck: '9', beds: 2, maxOccupancy: 2, accessible: false, stationId: 'sSolo', status: 'normal', version: 0 },
  ];
  for (const cabin of soloCabs) engine.appendEvent(store, '系统', 'CABIN_ADD', { cabin, ts: Date.now() });
  engine.appendEvent(store, '系统', 'VOYAGE_ADD', {
    voyage: { id: 'vSolo', code: 'DP-SOLO', name: '单点超容演练', departureTs: Date.parse('2026-10-01T09:00:00+08:00'), arrivalTs: Date.parse('2026-10-03T09:00:00+08:00'), status: 'active' },
    ts: Date.now(),
  });
  // 2 名旅客直接住入同一舱（同属 sSolo，单点归集 2 人 > 容量 1）
  for (const [i, cabId] of ['cS1', 'cS1'].entries()) {
    const pid = `sp${i}`;
    engine.appendEvent(store, '系统', 'PASSENGER_ADD', { passenger: { id: pid, name: `单点客${i}`, age: 30 + i, voyageId: 'vSolo', cabinId: null, status: 'booked' }, ts: Date.now() });
    engine.appendEvent(store, '客服·小周', 'PROPOSAL_APPLY', {
      proposal: { id: `prop_sp${i}`, by: '客服·小周', ts: Date.now(), note: '入住', edits: [{ cabinId: cabId, baseVersion: i, add: [pid], remove: [] }] },
      ts: Date.now(), note: '入住',
    });
  }
  conflicts = engine.revalidate(s);
  const full = conflicts.find((c) => c.rule === 'STATION_IMBALANCE' && c.stationId === 'sSolo' && c.detail.includes('超过容量'));
  check('唯一在用集合点超容也报 STATION_IMBALANCE 错误', !!full, conflicts.filter(c=>c.voyageId==='vSolo').map(c=>c.detail).join(' / '));
  check('单点超容冲突指明集合点', full && full.severity === 'error');
  check('单点超容时不能确认', engine.confirmVoyage(store, 'vSolo', '主管', [], conflicts).ok === false);
}

// ===========================================================================
// 场景 9：集合点没有救生艇但已有旅客 → 艇位不足
// ===========================================================================
group('场景 9｜无艇有客：集合点未配救生艇却已归集旅客');
{
  engine.appendEvent(store, '系统', 'STATION_ADD', { station: { id: 'sNoBoat', name: 'N 无艇集合点', deck: '8', capacity: 40 }, ts: Date.now() });
  engine.appendEvent(store, '系统', 'CABIN_ADD', {
    cabin: { id: 'cN1', number: 801, deck: '8', beds: 2, maxOccupancy: 2, accessible: false, stationId: 'sNoBoat', status: 'normal', version: 0 },
    ts: Date.now(),
  });
  engine.appendEvent(store, '系统', 'VOYAGE_ADD', {
    voyage: { id: 'vNoBoat', code: 'DP-NOBOAT', name: '无艇有客演练', departureTs: Date.parse('2026-11-01T09:00:00+08:00'), arrivalTs: Date.parse('2026-11-03T09:00:00+08:00'), status: 'active' },
    ts: Date.now(),
  });
  const pid = 'np0';
  engine.appendEvent(store, '系统', 'PASSENGER_ADD', { passenger: { id: pid, name: '无艇旅客', age: 40, voyageId: 'vNoBoat', cabinId: null, status: 'booked' }, ts: Date.now() });
  engine.appendEvent(store, '客服·小周', 'PROPOSAL_APPLY', {
    proposal: { id: 'prop_np0', by: '客服·小周', ts: Date.now(), note: '入住', edits: [{ cabinId: 'cN1', baseVersion: 0, add: [pid], remove: [] }] },
    ts: Date.now(), note: '入住',
  });
  conflicts = engine.revalidate(s);
  const noBoat = conflicts.find((c) => c.rule === 'BOAT_OVERCAP' && c.stationId === 'sNoBoat');
  check('无艇但有客 → BOAT_OVERCAP 错误（艇位 0）', !!noBoat && noBoat.detail.includes('未配置任何救生艇'), conflicts.filter(c=>c.voyageId==='vNoBoat').map(c=>c.detail).join(' / '));
  check('无艇冲突为错误级', noBoat && noBoat.severity === 'error');
  check('无艇时不能确认', engine.confirmVoyage(store, 'vNoBoat', '主管', [], conflicts).ok === false);

  // 解除：补一艘艇后冲突消失
  engine.appendEvent(store, '系统', 'BOAT_ADD', { boat: { id: 'bN1', name: '救生艇 N 号', stationId: 'sNoBoat', capacity: 20 }, ts: Date.now() });
  conflicts = engine.revalidate(s);
  check('补配救生艇后无艇冲突消失', !conflicts.some((c) => c.rule === 'BOAT_OVERCAP' && c.stationId === 'sNoBoat'));
}

// ===========================================================================
// 场景 10：时间重叠并复用同舱 → 周转冲突
// ===========================================================================
group('场景 10｜重叠复用：与 v1 时间完全重叠的航次复用同一批舱室');
{
  const v1 = s.voyages.find((v) => v.id === 'v1');
  engine.appendEvent(store, '系统', 'VOYAGE_ADD', {
    voyage: { id: 'vOverlap', code: 'DP-OVL', name: '重叠排班演练', departureTs: v1.departureTs + 3600_000, arrivalTs: v1.arrivalTs, status: 'active' },
    ts: Date.now(),
  });
  // 取 v1 在住的两间舱，各放 1 名新航次旅客（直接落 PROPOSAL_APPLY，基准版本读取当前）
  const occV1 = engine.cabinOccupancy(s, 'v1');
  const reuseCabins = [...occV1.keys()].slice(0, 2);
  reuseCabins.forEach((cid, i) => {
    const pid = `op${i}`;
    engine.appendEvent(store, '系统', 'PASSENGER_ADD', { passenger: { id: pid, name: `重叠客${i}`, age: 35, voyageId: 'vOverlap', cabinId: null, status: 'booked' }, ts: Date.now() });
    const ver = s.cabins.find((c) => c.id === cid).version;
    engine.appendEvent(store, '客服·小钱', 'PROPOSAL_APPLY', {
      proposal: { id: `prop_op${i}`, by: '客服·小钱', ts: Date.now(), note: '重叠航次复用', edits: [{ cabinId: cid, baseVersion: ver, add: [pid], remove: [] }] },
      ts: Date.now(), note: '重叠航次复用',
    });
  });
  conflicts = engine.revalidate(s);
  const overlaps = conflicts.filter((c) => c.rule === 'TURNAROUND' && c.voyagePair?.includes('v1') && c.voyagePair?.includes('vOverlap'));
  check('时间重叠复用同舱 → TURNAROUND 错误', overlaps.length === reuseCabins.length, `期望 ${reuseCabins.length} 条，实际 ${overlaps.length}`);
  check('重叠冲突文案标明“时间重叠”', overlaps.every((c) => c.detail.includes('时间重叠')));
  check('重叠冲突指明舱室与双方旅客', overlaps.every((c) => !!c.cabinId && (c.passengerIds?.length ?? 0) >= 2));
  check('重叠冲突挂在后航次并阻止确认', engine.blockingConflicts(conflicts, 'vOverlap').some((c) => c.rule === 'TURNAROUND'));
  // 同一对航次同一舱只报一次（不重复）
  const ids = new Set(overlaps.map((c) => c.id));
  check('冲突 ID 稳定且无重复', ids.size === overlaps.length);
}

// ===========================================================================
// 场景 7：刷新 / 重放持久化 —— 方案与操作链仍在
// ===========================================================================
group('场景 7｜持久化：事件链落盘，重放后方案、裁定记录、确认全部一致');
{
  const path = join(outDir, 'events.json');
  const adapter = fileAdapter(path);
  adapter.save(store.events);
  const reloaded = engine.replay(adapter.load());
  const r2 = reloaded.state;
  check('事件链全部落盘并重放', reloaded.events.length === store.events.length);
  check('重放后舱室分配一致', JSON.stringify(r2.passengers.map((p) => [p.id, p.cabinId])) === JSON.stringify(s.passengers.map((p) => [p.id, p.cabinId])));
  check('重放后舱室版本号一致', (() => {
    const ok = JSON.stringify(r2.cabins.map((c) => [c.id, c.version])) === JSON.stringify(s.cabins.map((c) => [c.id, c.version]));
    if (!ok) for (const c of s.cabins) { const rc = r2.cabins.find((x) => x.id === c.id); if (c.version !== rc.version) console.log(`    DIFF ${c.id} live=${c.version} replay=${rc.version}`); }
    return ok;
  })());
  check('重放后裁定记录一致', r2.arbitrations.length === s.arbitrations.length);
  check('重放后确认记录一致', JSON.stringify(r2.confirmations) === JSON.stringify(s.confirmations));
  const reconf = engine.revalidate(r2);
  check('重放后复核结果一致（冲突数相同）', reconf.length === engine.revalidate(s).length);
}

// ---------------------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------------------
console.log(`\n========================================`);
console.log(`通过 ${passed} 项，失败 ${failures.length} 项`);
if (failures.length) {
  for (const f of failures) console.log(`  ✗ ${f.name} —— ${f.detail}`);
  process.exit(1);
}
console.log('全部验收通过 ✅');
