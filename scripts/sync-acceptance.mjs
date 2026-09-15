// 跨标签页同步验收：
// 1) 两个独立页面同时提交同一舱 → 双方事件合并进同一链，先提交不消失，过期提案降级为待裁定且原始修改保留
// 2) 交叉同步：裁定结果与后续操作双向到达，两端现场一致
// 3) 重复同步同一批事件：不产生重复事件/重复裁定
// 4) 刷新/重开页面：事件链、裁定队列、双方操作完全一致
// 运行：node scripts/sync-acceptance.mjs
import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

const outDir = join(tmpdir(), 'cruise-sync');
mkdirSync(outDir, { recursive: true });
execFileSync(
  process.execPath,
  [
    join(root, 'node_modules/typescript/bin/tsc'),
    join(root, 'src/cruise/types.ts'),
    join(root, 'src/cruise/engine.ts'),
    join(root, 'src/cruise/seed.ts'),
    join(root, 'src/cruise/sync.ts'),
    join(root, 'src/cruise/store.ts'),
    '--outDir', outDir, '--module', 'commonjs', '--target', 'es2022',
    '--skipLibCheck', '--ignoreConfig', '--strict', 'false',
  ],
  { stdio: 'inherit' },
);
writeFileSync(join(outDir, 'package.json'), JSON.stringify({ type: 'commonjs' }));
const { DeskStore } = await import(pathToFileURL(join(outDir, 'store.js')).href);
const engine = await import(pathToFileURL(join(outDir, 'engine.js')).href);
const { buildSeedStore } = await import(pathToFileURL(join(outDir, 'seed.js')).href);
const { canonicalReplay, eventKey, normalize, unionEvents } = await import(pathToFileURL(join(outDir, 'sync.js')).href);

let passed = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log('  ✅', name); }
  else { failures.push({ name, detail }); console.log('  ❌', name, detail); }
}
function group(name) { console.log(`\n■ ${name}`); }

// ---------------------------------------------------------------------------
// 共享文件适配器（模拟两个标签页看到的同一个 localStorage key）
// ---------------------------------------------------------------------------
function sharedAdapter(file) {
  return {
    load() {
      if (!existsSync(file)) return null;
      const raw = readFileSync(file, 'utf8');
      return raw ? JSON.parse(raw) : null;
    },
    save(doc) {
      writeFileSync(file, JSON.stringify(doc));
    },
  };
}

const dbFile = join(outDir, 'shared-doc.json');
try { writeFileSync(dbFile, ''); } catch { /* ignore */ }

// 种子：以一个页面的身份落盘初始数据
{
  const bootstrap = new DeskStore(sharedAdapter(dbFile), () => buildSeedStore(true), 'tab_BOOT');
  void bootstrap;
}

function openPage(origin) {
  return new DeskStore(sharedAdapter(dbFile), undefined, origin);
}

// 找一间 2 人舱 X 和一间有空床位的舱 Y
function pickCabins(st) {
  const occ = engine.cabinOccupancy(st.state, 'v1');
  const X = st.state.cabins.find((c) => (occ.get(c.id)?.length ?? 0) === 2);
  const [a1, a2] = occ.get(X.id);
  const Y = st.state.cabins.find((c) => c.id !== X.id && (occ.get(c.id)?.length ?? 0) < c.maxOccupancy);
  return { X, Y, a1, a2 };
}

// ===========================================================================
group('场景 1｜两个独立页面同时提交同一舱：并集合并，过期方降级待裁定');
{
  const pageA = openPage('tab_A');
  const pageB = openPage('tab_B');
  const { X, Y, a1, a2 } = pickCabins(pageA);
  // 真实标签页进程隔离：B 页持有的是自己加载时的版本号。这里提前快照原始数字，
  // 避免同进程测试里 A 就地修改共享 cabin 对象污染 B 的基准版本
  const baseVersion = X.version;
  const yBaseVersion = Y.version;

  // 客服小周在 A 页：a1 从 X 换到 Y（先提交）
  const rA = pageA.submitProposal('客服·小周', {
    by: '客服·小周', note: `A 页：${a1.name} X→Y`,
    edits: [
      { cabinId: X.id, baseVersion, add: [], remove: [a1.id] },
      { cabinId: Y.id, baseVersion: yBaseVersion, add: [a1.id], remove: [] },
    ],
  });
  check('A 页提案直接生效', rA.ok === true);

  // 客服小钱在 B 页（未收到 storage 事件，仍持 v0）：a2 从 X 换到 Y
  const rB = pageB.submitProposal('客服·小钱', {
    by: '客服·小钱', note: `B 页：${a2.name} X→Y`,
    edits: [
      { cabinId: X.id, baseVersion, add: [], remove: [a2.id] },
      { cabinId: Y.id, baseVersion: yBaseVersion, add: [a2.id], remove: [] },
    ],
  });
  // B 本地 dispatch 时还没合并，判定为 ok；afterChange 的读-改-写会将其降级为裁定
  check('B 页本地受理（未硬失败）', rB.ok === true || rB.reason === 'concurrent');

  // B 页在 RMW 合并后必须拿到 A 的事件
  const bKeys = pageB.events.map(eventKey);
  const aApply = pageB.events.find((e) => e.type === 'PROPOSAL_APPLY' && e.origin === 'tab_A');
  const bRaised = pageB.events.find((e) => e.type === 'PROPOSAL_RAISE' && e.origin === 'tab_B');
  check('先提交的 A 操作没有消失（在合并链中）', !!aApply);
  check('A 事件来自 tab_A、B 事件来自 tab_B，身份不撞', bKeys.filter((k) => k === eventKey(aApply)).length === 1);
  check('B 的过期提案被降级为 PROPOSAL_RAISE（未静默覆盖 A）', !!bRaised);

  // 裁定队列：恰好 1 单，pending，并发类型，原始修改完整保留
  const pending = pageB.state.arbitrations.filter((a) => a.status === 'pending');
  check('合并后生成 1 个待人工裁定', pending.length === 1, `实际 ${pending.length}`);
  const arb = pending[0];
  check('裁定类型为 concurrency', arb && arb.kind === 'concurrency');
  check('裁定记录过期舱与版本（基准 v0 当前 v1）',
    arb && arb.stale.some((z) => z.cabinId === X.id && z.baseVersion === 0 && z.currentVersion === 1 && z.currentEditor === '客服·小周'));
  const edits = arb?.proposal.edits ?? [];
  check('裁定单保留 B 的原始修改（移出 a2 / 调入 a2）',
    edits.some((e) => e.cabinId === X.id && e.remove.includes(a2.id)) &&
    edits.some((e) => e.cabinId === Y.id && e.add.includes(a2.id)));
  check('裁定单提案人是 B 页客服小钱', arb?.proposal.by === '客服·小钱');

  // 现场：A 已生效，B 未被自动应用
  const cabinOf = (st, id) => st.passengers.find((p) => p.id === id).cabinId;
  check('A 的换舱已落地（a1 在 Y）', cabinOf(pageB.state, a1.id) === Y.id);
  check('B 的换舱未被静默落地（a2 仍在 X）', cabinOf(pageB.state, a2.id) === X.id);

  // 持久层里也是同一条合并链（没有谁覆盖谁）
  const disk = sharedAdapter(dbFile).load();
  check('落盘文档为 v2 信封且同时含 A/B 两页事件', disk.format === 2 && disk.events.some((e) => e.origin === 'tab_A') && disk.events.some((e) => e.origin === 'tab_B'));
  check('落盘链中先提交操作是 APPLY、后到操作是 RAISE',
    disk.events.some((e) => e.type === 'PROPOSAL_APPLY' && e.origin === 'tab_A') &&
    disk.events.some((e) => e.type === 'PROPOSAL_RAISE' && e.origin === 'tab_B'));

  // 把场景对象留给后续场景
  globalThis.__ctx = { pageA, pageB, X, Y, a1, a2, arbId: arb?.id };
}

// ===========================================================================
group('场景 2｜交叉同步：A 页裁定应用 → B 页收到；B 页新操作 → A 页收到');
{
  const { pageA, pageB, X, Y, a2, arbId } = globalThis.__ctx;
  const disk = () => sharedAdapter(dbFile).load();

  // 主管在 A 页应用 B 的裁定（rebase 后落地）
  pageA.mergeRemote(disk()); // A 先拉齐合并视图（含 RAISE）
  const beforePending = pageA.state.arbitrations.filter((a) => a.status === 'pending').length;
  pageA.resolveArbitration(arbId, 'apply', '主管', '两份换舱都有效', false);
  check('A 页看到待裁定并完成应用', beforePending >= 1 && pageA.state.arbitrations.find((a) => a.id === arbId)?.status === 'applied');
  check('裁定应用后 a2 到 Y（双方修改都保留）', pageA.state.passengers.find((p) => p.id === a2.id).cabinId === Y.id);

  // B 页通过 storage 事件拿到 A 页的文档
  const changed = pageB.mergeRemote(disk());
  check('B 页交叉同步后发生变更', changed === true);
  check('B 页看到裁定已 applied', pageB.state.arbitrations.find((a) => a.id === arbId)?.status === 'applied');
  check('B 页现场与 A 页一致（a2 在 Y）', pageB.state.passengers.find((p) => p.id === a2.id).cabinId === Y.id);
  check('两端事件链签名一致', pageA.chainSignature() === pageB.chainSignature());

  // 反向：B 页锁定一间与本操作无关的舱 Z，A 页同步
  const Z = pageB.state.cabins.find((c) => c.id !== X.id && c.id !== Y.id);
  pageB.commit('客服·小钱', 'CABIN_STATUS', { cabinId: Z.id, status: 'locked', by: '客服·小钱' });
  const changed2 = pageA.mergeRemote(disk());
  check('A 页交叉同步收到 B 页锁舱', changed2 === true && pageA.state.cabins.find((c) => c.id === Z.id).status === 'locked');
  check('两端事件链签名再次一致', pageA.chainSignature() === pageB.chainSignature());
  check('锁舱事件来源标注为 tab_B', pageA.events.some((e) => e.type === 'CABIN_STATUS' && e.origin === 'tab_B'));

  globalThis.__ctx = { ...globalThis.__ctx, Z };
}

// ===========================================================================
group('场景 3｜重复同步同一批事件：幂等，无重复记录');
{
  const { pageA, pageB } = globalThis.__ctx;
  const disk = () => sharedAdapter(dbFile).load();
  const doc = disk();
  const eventCount = pageA.events.length;
  const arbCount = pageA.state.arbitrations.length;
  const sig = pageA.chainSignature();
  const rev0 = pageA.revision;

  const c1 = pageA.mergeRemote(doc);
  const c2 = pageA.mergeRemote(doc);
  const c3 = pageA.mergeRemote(doc);
  check('重复同步三次均报告“无变化”', c1 === false && c2 === false && c3 === false);
  check('事件数不增加', pageA.events.length === eventCount);
  check('裁定数不增加（不生成重复裁定）', pageA.state.arbitrations.length === arbCount);
  check('链签名不变', pageA.chainSignature() === sig);
  check('无变化时不通知订阅者', pageA.revision === rev0);

  // 规范化本身幂等：normalize(normalize(x)) ≡ normalize(x)
  const once = normalize(pageB.events);
  const twice = normalize(once);
  check('规范化重放幂等（事件键与类型序列相同）',
    once.length === twice.length && once.every((e, i) => eventKey(e) === eventKey(twice[i]) && e.type === twice[i].type));
  // 同一事件在链中只出现一次
  const keys = twice.map(eventKey);
  check('无重复事件身份', new Set(keys).size === keys.length);
}

// ===========================================================================
group('场景 4｜刷新 / 重新打开页面：链、裁定队列、双方操作一致');
{
  const { pageA, X, Y, a1, a2, arbId, Z } = globalThis.__ctx;
  const pageC = openPage('tab_C_FRESH'); // 模拟刷新后新开的页面（新 origin）

  check('新页面事件数与原页面一致', pageC.events.length === pageA.events.length);
  check('新页面链签名与原页面一致', pageC.chainSignature() === pageA.chainSignature());
  check('双方操作都在（A 的 APPLY、B 的 RAISE、A 的裁定 APPLY、B 的锁舱）',
    pageC.events.some((e) => e.origin === 'tab_A' && e.type === 'PROPOSAL_APPLY') &&
    pageC.events.some((e) => e.origin === 'tab_B' && e.type === 'PROPOSAL_RAISE') &&
    pageC.events.some((e) => e.origin === 'tab_B' && e.type === 'CABIN_STATUS'));
  check('裁定记录恢复（applied，含原始 B 修改）',
    pageC.state.arbitrations.find((a) => a.id === arbId)?.status === 'applied' &&
    pageC.state.arbitrations.find((a) => a.id === arbId)?.proposal.by === '客服·小钱');
  const cabinOf = (st, id) => st.passengers.find((p) => p.id === id).cabinId;
  check('现场恢复：a1、a2 都在 Y', cabinOf(pageC.state, a1.id) === Y.id && cabinOf(pageC.state, a2.id) === Y.id);
  check('锁舱状态恢复', pageC.state.cabins.find((c) => c.id === Z.id).status === 'locked');
  check('X 舱版本号两端一致', pageC.state.cabins.find((c) => c.id === X.id).version === pageA.state.cabins.find((c) => c.id === X.id).version);

  // 事件 id 连续编号且与 seq 对齐
  const ids = pageC.events.map((e) => e.id);
  check('事件 id 从 1 连续编号', ids.every((id, i) => id === i + 1));
  check('state.seq 与事件数对齐', pageC.state.seq === pageC.events.length);

  // 新页面提交操作使用新 origin，与历史身份不撞
  const before = pageC.events.length;
  pageC.commit('客房部', 'CABIN_STATUS', { cabinId: X.id, status: 'locked', by: '客房部' });
  const newEv = pageC.events[pageC.events.length - 1];
  check('新页面操作带新 origin 且链仅增加 1 条', pageC.events.length === before + 1 && newEv.origin === 'tab_C_FRESH');
  check('合并旧链后无重复裁定', pageC.state.arbitrations.length === pageA.state.arbitrations.length);
}

// ===========================================================================
group('场景 5｜乱序/延迟交叉同步：三页以任意顺序重复送达，最终收敛一致');
{
  // 全新共享文档，避免受前面场景影响
  const f5 = join(outDir, 'shared-doc-3page.json');
  writeFileSync(f5, '');
  const ad5 = sharedAdapter(f5);
  new DeskStore(ad5, () => buildSeedStore(true), 'tab_BOOT5');
  const p1 = new DeskStore(ad5, undefined, 'tab_P1');
  const p2 = new DeskStore(ad5, undefined, 'tab_P2');
  const p3 = new DeskStore(ad5, undefined, 'tab_P3');

  // 三个页面各自“离线”修改互不重叠的舱（用各自的 store 提交；读-改-写都会合并）
  const c1 = p1.state.cabins.find((c) => c.id === 'c105');
  const c2 = p2.state.cabins.find((c) => c.id === 'c107');
  const c3 = p3.state.cabins.find((c) => c.id === 'c205');
  p1.commit('客服·小周', 'CABIN_STATUS', { cabinId: c1.id, status: 'locked', by: '客服·小周' });
  const doc1 = ad5.load(); // P1 提交后的快照
  p2.commit('客服·小钱', 'CABIN_STATUS', { cabinId: c2.id, status: 'sealed', by: '客服·小钱' });
  const doc2 = ad5.load(); // P2 提交后的快照（含 P1）
  p3.commit('主管', 'CABIN_STATUS', { cabinId: c3.id, status: 'locked', by: '主管' });
  const doc3 = ad5.load(); // P3 提交后的快照（含 P1+P2）

  // 让一个“离群”页面只看到 doc1，再以乱序重复收到 doc3、doc1、doc2、doc3
  const lonerFile = join(outDir, `empty-loner-${Math.random().toString(36).slice(2)}.json`);
  const loner = new DeskStore(sharedAdapter(lonerFile), undefined, 'tab_LONER');
  check('离群页初始无三页的锁舱事件',
    !loner.events.some((e) => e.origin === 'tab_P1' || e.origin === 'tab_P2' || e.origin === 'tab_P3'));
  loner.mergeRemote(doc1);
  const changed3 = loner.mergeRemote(doc3); // 跳过 doc2 直接看全量
  check('收到全量快照发生变更', changed3 === true);
  const n1 = loner.events.length;
  loner.mergeRemote(doc1); // 旧快照重复送达
  loner.mergeRemote(doc2);
  const changedAgain = loner.mergeRemote(doc3); // 重复
  check('旧/重复快照不再产生变更', changedAgain === false && loner.events.length === n1);

  // 三页与离群页最终签名一致，三方操作都在（模拟 storage 广播：每页都收到最终全量快照）
  p1.mergeRemote(doc3);
  p2.mergeRemote(doc3);
  const sig = p3.chainSignature();
  check('四方（P1/P2/P3/离群）链签名收敛一致',
    p1.chainSignature() === sig && p2.chainSignature() === sig && loner.chainSignature() === sig,
    `p1=${p1.chainSignature() === sig} p2=${p2.chainSignature() === sig} loner=${loner.chainSignature() === sig}`);
  check('三方操作无一丢失（三把锁/封）',
    loner.state.cabins.find((c) => c.id === 'c105').status === 'locked' &&
    loner.state.cabins.find((c) => c.id === 'c107').status === 'sealed' &&
    loner.state.cabins.find((c) => c.id === 'c205').status === 'locked');
  check('事件身份全局唯一（无任一页事件覆盖另一页）',
    new Set(loner.events.map(eventKey)).size === loner.events.length);
  check('三页各自只对自己的事件盖 origin（可追溯操作来源）',
    loner.events.filter((e) => e.type === 'CABIN_STATUS' && ['c105', 'c107', 'c205'].includes(e.payload.cabinId))
      .every((e) => ['tab_P1', 'tab_P2', 'tab_P3'].includes(e.origin)));
}

// ---------------------------------------------------------------------------
console.log(`\n========================================`);
console.log(`通过 ${passed} 项，失败 ${failures.length} 项`);
if (failures.length) {
  for (const f of failures) console.log(`  ✗ ${f.name} —— ${f.detail}`);
  process.exit(1);
}
console.log('跨标签同步验收全部通过 ✅');
