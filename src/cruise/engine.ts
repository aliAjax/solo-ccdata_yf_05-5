// 核心领域引擎：事件溯源 reducer、规则复核、自动分配、并发改舱裁定
import type {
  AppState,
  Cabin,
  CabinEditProposal,
  Conflict,
  DomainEvent,
  EventStore,
  Lifeboat,
  MusterStation,
  Passenger,
  RuleCode,
  RulesConfig,
  Voyage,
} from './types';

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

let seqCounter = 0;
export function uid(prefix: string): string {
  seqCounter += 1;
  return `${prefix}_${Date.now().toString(36)}_${seqCounter.toString(36)}`;
}

export const RULE_LABEL: Record<RuleCode, string> = {
  OVERSOLD: '超售',
  UNASSIGNED: '旅客未分配舱位',
  CABIN_OVERCAP: '舱室超员（超过禁住人数）',
  CHILD_ALONE: '儿童陪同缺失',
  BOAT_OVERCAP: '救生艇超员',
  STATION_IMBALANCE: '集合点失衡',
  TURNAROUND: '清洁周转不足',
  SEALED_OCCUPIED: '封舱仍有住客',
  ACCESS_NEED: '无障碍需求未满足',
  GROUP_SPLIT: '团体被拆分',
  ADJACENCY: '相邻需求未满足',
};

export const RULE_DESC: Record<RuleCode, string> = {
  OVERSOLD: '已排定旅客人数超过可住床位总数（按禁住人数、扣除封舱）',
  UNASSIGNED: '仍有旅客没有安排任何舱位，登船清单不可确认',
  CABIN_OVERCAP: '舱内人数超过禁住人数（安全定员）；强制入住不能突破物理床位',
  CHILD_ALONE: '有未满成人年龄的儿童同住时，舱内必须有适龄成人陪同',
  BOAT_OVERCAP: '集合点归集旅客（含冗余）超过该点救生艇总定员',
  STATION_IMBALANCE: '集合点超过容量，或各点负载率差异超过阈值',
  TURNAROUND: '同一舱室连续两个航次间隔不足最少清洁周转时间',
  SEALED_OCCUPIED: '舱室处于临时封舱状态，不能安排旅客',
  ACCESS_NEED: '有无障碍需求的旅客必须安排在无障碍舱室',
  GROUP_SPLIT: '同一团体应安排在同一舱室（无合适舱位时给出拆分告警）',
  ADJACENCY: '提出相邻需求的旅客必须安排在同甲板、舱号相邻的舱室',
};

function byId<T extends { id: string }>(arr: T[], id: string | null | undefined): T | undefined {
  if (id == null) return undefined;
  return arr.find((x) => x.id === id);
}

function clone<T>(v: T): T {
  return structuredClone(v);
}

export const DEFAULT_CONFIG: RulesConfig = {
  boatCapacityMargin: 0.1,
  stationImbalanceRatio: 0.35,
  minTurnaroundMs: 6 * 3600 * 1000, // 两航次间至少 6 小时清洁周转
  childAgeMax: 18,
  escortAgeMin: 18,
  adjacencyCabinGap: 2, // 同甲板舱号差 <= 2 视为相邻（如 101 与 103）
};

export function emptyState(config: Partial<RulesConfig> = {}): AppState {
  return {
    voyages: [],
    stations: [],
    boats: [],
    cabins: [],
    groups: [],
    passengers: [],
    arbitrations: [],
    confirmations: {},
    config: { ...DEFAULT_CONFIG, ...config },
    seq: 0,
  };
}

export function emptyStore(): EventStore {
  return { events: [], state: emptyState() };
}

// ---------------------------------------------------------------------------
// 舱位视图
// ---------------------------------------------------------------------------

export function voyagePassengers(state: AppState, voyageId: string): Passenger[] {
  return state.passengers.filter((p) => p.voyageId === voyageId && p.status !== 'removed');
}

/** 每舱旅客映射 */
export function cabinOccupancy(
  state: AppState,
  voyageId: string,
): Map<string, Passenger[]> {
  const map = new Map<string, Passenger[]>();
  for (const p of voyagePassengers(state, voyageId)) {
    if (p.cabinId) {
      const arr = map.get(p.cabinId) ?? [];
      arr.push(p);
      map.set(p.cabinId, arr);
    }
  }
  return map;
}

export interface StationLoad {
  station: MusterStation;
  boats: Lifeboat[];
  boatCapacity: number;
  assigned: number;
  ratio: number;
}

export function stationLoads(state: AppState, voyageId: string): StationLoad[] {
  const occ = cabinOccupancy(state, voyageId);
  return state.stations.map((station) => {
    const boats = state.boats.filter((b) => b.stationId === station.id);
    const boatCapacity = boats.reduce((s, b) => s + b.capacity, 0);
    let assigned = 0;
    for (const cabin of state.cabins) {
      if (cabin.stationId === station.id) assigned += occ.get(cabin.id)?.length ?? 0;
    }
    return { station, boats, boatCapacity, assigned, ratio: station.capacity ? assigned / station.capacity : 0 };
  });
}

// ---------------------------------------------------------------------------
// 规则复核：全量，所有操作后重跑 —— 冲突 id 稳定
// ---------------------------------------------------------------------------

function conflictId(parts: (string | number | undefined)[]): string {
  return parts.filter((p) => p !== undefined).join('|');
}

function adjacent(c1: Cabin, c2: Cabin, cfg: RulesConfig): boolean {
  return c1.deck === c2.deck && Math.abs(c1.number - c2.number) <= cfg.adjacencyCabinGap;
}

/** 复核单个航次（周转规则需全部航次，在调用处合并） */
export function revalidateVoyage(state: AppState, voyageId: string): Conflict[] {
  const cfg = state.config;
  const conflicts: Conflict[] = [];
  const voyage = byId(state.voyages, voyageId);
  if (!voyage) return conflicts;
  const pax = voyagePassengers(state, voyageId);
  const occ = cabinOccupancy(state, voyageId);

  // --- 舱级规则 ---
  for (const cabin of state.cabins) {
    const inside = occ.get(cabin.id) ?? [];
    const ids = inside.map((p) => p.id);

    if (cabin.status === 'sealed' && inside.length > 0) {
      conflicts.push({
        id: conflictId(['SEALED_OCCUPIED', voyageId, cabin.id]),
        rule: 'SEALED_OCCUPIED',
        severity: 'error',
        voyageId,
        cabinId: cabin.id,
        passengerIds: ids,
        detail: `封舱 ${cabin.deck}-${cabin.number} 仍有 ${inside.length} 名住客，封舱不得安排住客`,
      });
    }

    if (inside.length > cabin.maxOccupancy) {
      conflicts.push({
        id: conflictId(['CABIN_OVERCAP', voyageId, cabin.id]),
        rule: 'CABIN_OVERCAP',
        severity: 'error',
        voyageId,
        cabinId: cabin.id,
        passengerIds: ids,
        detail: `舱 ${cabin.deck}-${cabin.number} 住 ${inside.length} 人，超过禁住人数 ${cabin.maxOccupancy}（物理床位 ${cabin.beds}）`,
      });
    } else if (inside.length > cabin.beds) {
      // 理论上床位>=禁住人数，这是物理兜底
      conflicts.push({
        id: conflictId(['CABIN_OVERCAP_BED', voyageId, cabin.id]),
        rule: 'CABIN_OVERCAP',
        severity: 'error',
        voyageId,
        cabinId: cabin.id,
        passengerIds: ids,
        detail: `舱 ${cabin.deck}-${cabin.number} 住 ${inside.length} 人，超过物理床位 ${cabin.beds}`,
      });
    }

    if (inside.length > 0) {
      const hasChild = inside.some((p) => p.age < cfg.childAgeMax);
      const hasAdult = inside.some((p) => p.age >= cfg.escortAgeMin);
      if (hasChild && !hasAdult) {
        conflicts.push({
          id: conflictId(['CHILD_ALONE', voyageId, cabin.id]),
          rule: 'CHILD_ALONE',
          severity: 'error',
          voyageId,
          cabinId: cabin.id,
          passengerIds: ids,
          detail: `舱 ${cabin.deck}-${cabin.number} 有儿童但无 ${cfg.escortAgeMin} 岁以上陪同人：${inside
            .map((p) => `${p.name}(${p.age})`)
            .join('、')}`,
        });
      }
    }

    for (const p of inside) {
      if (p.needsAccessible && !cabin.accessible) {
        conflicts.push({
          id: conflictId(['ACCESS_NEED', voyageId, p.id]),
          rule: 'ACCESS_NEED',
          severity: 'error',
          voyageId,
          cabinId: cabin.id,
          passengerIds: [p.id],
          detail: `旅客 ${p.name} 需要无障碍舱室，但 ${cabin.deck}-${cabin.number} 不是无障碍舱`,
        });
      }
    }
  }

  // --- 相邻需求（按旅客对） ---
  for (const p of pax) {
    if (!p.adjacentWithIds?.length || !p.cabinId) continue;
    const pc = byId(state.cabins, p.cabinId)!;
    for (const otherId of p.adjacentWithIds) {
      const other = byId(pax, otherId);
      if (!other || !other.cabinId) continue;
      // 只从较小 id 一侧产出，避免重复
      if (p.id > other.id) continue;
      const oc = byId(state.cabins, other.cabinId)!;
      if (pc.id !== oc.id && !adjacent(pc, oc, cfg)) {
        conflicts.push({
          id: conflictId(['ADJACENCY', voyageId, [p.id, other.id].sort().join('~')]),
          rule: 'ADJACENCY',
          severity: 'warning',
          voyageId,
          cabinIds: [pc.id, oc.id],
          passengerIds: [p.id, other.id],
          detail: `${p.name}(${pc.deck}-${pc.number}) 与 ${other.name}(${oc.deck}-${oc.number}) 有相邻需求，但舱室不相邻（同甲板舱号差须 ≤ ${cfg.adjacencyCabinGap}）`,
        });
      }
    }
  }

  // --- 团体拆分（每组一条） ---
  const groupsOnVoyage = state.groups.filter((g) => g.voyageId === voyageId);
  for (const g of groupsOnVoyage) {
    const members = pax.filter((p) => p.groupId === g.id);
    const cabinsSet = new Set(members.map((m) => m.cabinId).filter(Boolean));
    if (cabinsSet.size > 1) {
      conflicts.push({
        id: conflictId(['GROUP_SPLIT', voyageId, g.id]),
        rule: 'GROUP_SPLIT',
        severity: 'warning',
        voyageId,
        cabinIds: [...cabinsSet] as string[],
        passengerIds: members.map((m) => m.id),
        detail: `团体「${g.name}」${members.length} 人被拆分到 ${cabinsSet.size} 间舱：${[...cabinsSet]
          .map((cid) => {
            const c = byId(state.cabins, cid)!;
            return `${c.deck}-${c.number}`;
          })
          .join('、')}`,
      });
    }
  }

  // --- 救生艇超员（按集合点聚合，含冗余；无艇但已有旅客同样报错） ---
  const loads = stationLoads(state, voyageId);
  for (const load of loads) {
    const required = Math.ceil(load.assigned * (1 + cfg.boatCapacityMargin));
    if (load.assigned > 0 && load.boatCapacity === 0) {
      conflicts.push({
        id: conflictId(['BOAT_NONE', voyageId, load.station.id]),
        rule: 'BOAT_OVERCAP',
        severity: 'error',
        voyageId,
        stationId: load.station.id,
        detail: `集合点 ${load.station.name} 已归集 ${load.assigned} 名旅客，但未配置任何救生艇，艇位为 0，无可用救生容量`,
      });
    } else if (load.boatCapacity > 0 && required > load.boatCapacity) {
      conflicts.push({
        id: conflictId(['BOAT_OVERCAP', voyageId, load.station.id]),
        rule: 'BOAT_OVERCAP',
        severity: 'error',
        voyageId,
        stationId: load.station.id,
        detail: `集合点 ${load.station.name} 归集 ${load.assigned} 人，含 ${Math.round(
          cfg.boatCapacityMargin * 100,
        )}% 冗余需 ${required} 个艇位，救生艇定员仅 ${load.boatCapacity}（${load.boats
          .map((b) => `${b.name}×${b.capacity}`)
          .join('、')}）`,
      });
    }
  }

  // --- 集合点超容（单点在用也必须检查）与多点负载率失衡 ---
  const usedLoads = loads.filter((l) => l.assigned > 0);
  for (const load of usedLoads) {
    if (load.assigned > load.station.capacity) {
      conflicts.push({
        id: conflictId(['STATION_FULL', voyageId, load.station.id]),
        rule: 'STATION_IMBALANCE',
        severity: 'error',
        voyageId,
        stationId: load.station.id,
        detail: `集合点 ${load.station.name} 归集 ${load.assigned} 人，超过容量 ${load.station.capacity}（唯一在用集合点同样不得超容）`,
      });
    }
  }
  if (usedLoads.length >= 2) {
    const ratios = usedLoads.map((l) => l.ratio);
    const spread = Math.max(...ratios) - Math.min(...ratios);
    if (spread > cfg.stationImbalanceRatio) {
      const hi = usedLoads.reduce((a, b) => (b.ratio > a.ratio ? b : a));
      const lo = usedLoads.reduce((a, b) => (b.ratio < a.ratio ? b : a));
      conflicts.push({
        id: conflictId(['STATION_SPREAD', voyageId]),
        rule: 'STATION_IMBALANCE',
        severity: 'warning',
        voyageId,
        stationIds: [hi.station.id, lo.station.id],
        detail: `集合点负载率差异 ${(spread * 100).toFixed(0)}% 超阈值 ${(
          cfg.stationImbalanceRatio * 100
        ).toFixed(0)}%：${hi.station.name} ${(hi.ratio * 100).toFixed(0)}% vs ${lo.station.name} ${(
          lo.ratio * 100
        ).toFixed(0)}%，建议调拨`,
      });
    }
  }

  // --- 未分配 / 超售 ---
  const usableBeds = state.cabins
    .filter((c) => c.status !== 'sealed')
    .reduce((s, c) => s + Math.min(c.beds, c.maxOccupancy), 0);
  const unassignedPax = pax.filter((p) => !p.cabinId);
  if (unassignedPax.length > 0) {
    conflicts.push({
      id: conflictId(['UNASSIGNED', voyageId]),
      rule: 'UNASSIGNED',
      severity: 'error',
      voyageId,
      passengerIds: unassignedPax.map((p) => p.id),
      detail: `航次 ${voyage.code} 有 ${unassignedPax.length} 名旅客尚未分配舱位：${unassignedPax
        .slice(0, 5)
        .map((p) => p.name)
        .join('、')}${unassignedPax.length > 5 ? ' 等' : ''}`,
    });
  }
  if (pax.length > usableBeds) {
    conflicts.push({
      id: conflictId(['OVERSOLD', voyageId]),
      rule: 'OVERSOLD',
      severity: 'error',
      voyageId,
      passengerIds: unassignedPax.map((p) => p.id),
      detail: `航次 ${voyage.code} 超售：已排定 ${pax.length} 人，可住床位（按禁住人数、扣除封舱）仅 ${usableBeds} 张，缺口 ${pax.length - usableBeds} 张`,
    });
  }

  return conflicts;
}

/**
 * 清洁周转 / 时间重叠：对全部航次两两检查（不再只看时间相邻航次）。
 * 同一舱室被两个航次复用，且两航次区间重叠或前航次到港至后航次出发间隔不足最少周转时间，即报错。
 */
export function revalidateTurnaround(state: AppState): Conflict[] {
  const cfg = state.config;
  const out: Conflict[] = [];
  const active = state.voyages.filter((v) => v.status !== 'cancelled');
  if (active.length < 2) return out;

  for (let i = 0; i < active.length; i++) {
    for (let j = i + 1; j < active.length; j++) {
      // 每对航次只检查一次；按出发时间（并列按 id）定向为 a→b
      const [a, b] =
        active[i].departureTs < active[j].departureTs ||
        (active[i].departureTs === active[j].departureTs && active[i].id < active[j].id)
          ? [active[i], active[j]]
          : [active[j], active[i]];

      const overlap = b.departureTs < a.arrivalTs; // 航次区间重叠（船舶不可能同时开两班，属排班冲突）
      const gap = b.departureTs - a.arrivalTs; // 重叠时为负
      if (!overlap && gap >= cfg.minTurnaroundMs) continue;

      const paxA = voyagePassengers(state, a.id);
      const paxB = voyagePassengers(state, b.id);
      for (const cabin of state.cabins) {
        const inA = paxA.filter((p) => p.cabinId === cabin.id);
        const inB = paxB.filter((p) => p.cabinId === cabin.id);
        if (!inA.length || !inB.length) continue;
        out.push({
          id: conflictId(['TURNAROUND', cabin.id, a.id, b.id]),
          rule: 'TURNAROUND',
          severity: 'error',
          voyageId: b.id,
          voyagePair: [a.id, b.id],
          cabinId: cabin.id,
          passengerIds: [...inA.map((p) => p.id), ...inB.map((p) => p.id)],
          detail: overlap
            ? `舱 ${cabin.deck}-${cabin.number} 在时间重叠的 ${a.code}(${new Date(a.departureTs).toLocaleString('zh-CN')} 出发) 与 ${b.code}(${new Date(
                b.departureTs,
              ).toLocaleString('zh-CN')} 出发) 中被同时复用（${inA.length} 人 / ${inB.length} 人），无清洁周转窗口`
            : `舱 ${cabin.deck}-${cabin.number} 在 ${a.code}(${new Date(a.arrivalTs).toLocaleString('zh-CN')}) 与 ${b.code}(${new Date(
                b.departureTs,
              ).toLocaleString('zh-CN')}) 间仅 ${(gap / 3600000).toFixed(1)} 小时，不足 ${(
                cfg.minTurnaroundMs / 3600000
              ).toFixed(0)} 小时清洁周转`,
        });
      }
    }
  }
  return out;
}

/** 全量复核（每次操作后调用） */
export function revalidate(state: AppState): Conflict[] {
  const all: Conflict[] = [];
  for (const v of state.voyages) all.push(...revalidateVoyage(state, v.id));
  all.push(...revalidateTurnaround(state));
  return all;
}

/** 阻塞确认登船清单的冲突：error 必须解除；warning 需逐条知悉 */
export function blockingConflicts(conflicts: Conflict[], voyageId: string): Conflict[] {
  return conflicts.filter((c) => c.voyageId === voyageId && c.severity === 'error');
}

// ---------------------------------------------------------------------------
// 自动分配：团体优先、无障碍、相邻需求、禁住人数、封舱/锁舱
// ---------------------------------------------------------------------------

export interface AssignResult {
  assigned: number;
  unassigned: string[];
}

/** 为指定航次分配（先清空再重排，不动其他航次） */
export function autoAssign(state: AppState, voyageId: string, options: { lockRespect?: boolean } = {}): AssignResult {
  const cfg = state.config;
  const lockRespect = options.lockRespect ?? true;
  const pax = voyagePassengers(state, voyageId);
  for (const p of pax) p.cabinId = null;

  const available = (): Cabin[] =>
    state.cabins.filter((c) => c.status !== 'sealed' && (!lockRespect || c.status !== 'locked'));

  const freeBeds = (c: Cabin, occ: Map<string, Passenger[]>): number =>
    c.maxOccupancy - (occ.get(c.id)?.length ?? 0);

  const occ = cabinOccupancy(state, voyageId); // 此刻全空
  const unassigned: string[] = [];

  // 1) 团体（大团优先）整体装入
  const groups = state.groups.filter((g) => g.voyageId === voyageId);
  const groupedIds = new Set<string>();
  const sortedGroups = groups
    .map((g) => ({ g, members: pax.filter((p) => p.groupId === g.id) }))
    .sort((a, b) => b.members.length - a.members.length);

  const place = (people: Passenger[], cabin: Cabin) => {
    for (const p of people) {
      p.cabinId = cabin.id;
      groupedIds.add(p.id);
      const arr = occ.get(cabin.id) ?? [];
      arr.push(p);
      occ.set(cabin.id, arr);
    }
  };

  for (const { g, members } of sortedGroups) {
    if (!members.length) continue;
    members.forEach((m) => groupedIds.add(m.id));
    const needAccess = members.some((m) => m.needsAccessible);
    // 同舱优先：找一间装得下的
    let target = available()
      .filter((c) => (!needAccess || c.accessible) && freeBeds(c, occ) >= members.length)
      // 含儿童的团体优先配可陪同（团体通常自带成人，这里只保证床型）
      .sort((a, b) => a.beds - b.beds)[0];
    if (target) {
      place(members, target);
    } else {
      // 拆单：按相邻顺序装入尽量少的舱，且相邻需求尽量满足
      let queue = [...members];
      const cabins = available()
        .filter((c) => !needAccess || c.accessible)
        .sort((a, b) => a.deck.localeCompare(b.deck) || a.number - b.number);
      for (const c of cabins) {
        if (!queue.length) break;
        const take = queue.splice(0, Math.max(0, freeBeds(c, occ)));
        if (take.length) place(take, c);
      }
      for (const m of queue) unassigned.push(m.id);
      void g;
    }
  }

  // 2) 散客：无障碍客人先配；再处理相邻需求对；最后普通填充
  const singles = pax.filter((p) => !groupedIds.has(p.id));
  const needAccess = singles.filter((p) => p.needsAccessible);
  const rest = singles.filter((p) => !p.needsAccessible);

  const putOne = (p: Passenger, candidates: Cabin[]): boolean => {
    const c = candidates.find((x) => freeBeds(x, occ) > 0);
    if (!c) return false;
    p.cabinId = c.id;
    occ.get(c.id)?.push(p) ?? occ.set(c.id, [p]);
    return true;
  };

  for (const p of needAccess) {
    if (!putOne(p, available().filter((c) => c.accessible))) unassigned.push(p.id);
  }

  // 相邻需求：把请求人和伙伴放同甲板相邻空舱（伙伴若是散客）
  for (const p of rest) {
    if (p.cabinId || !p.adjacentWithIds?.length) continue;
    const partners = p.adjacentWithIds
      .map((id) => rest.find((q) => q.id === id && !q.cabinId))
      .filter((x): x is Passenger => !!x);
    const team = [p, ...partners];
    const cabins = available().sort((a, b) => a.deck.localeCompare(b.deck) || a.number - b.number);
    // 先尝试同舱
    let home = cabins.find((c) => freeBeds(c, occ) >= team.length);
    if (home) {
      place(team, home);
      continue;
    }
    // 再尝试相邻舱链
    let placed = false;
    for (const c of cabins) {
      if (freeBeds(c, occ) < 1) continue;
      const neighbor = cabins.find(
        (n) => n.id !== c.id && adjacent(c, n, cfg) && freeBeds(n, occ) >= team.length - 1,
      );
      if (neighbor) {
        place([p], c);
        place(partners, neighbor);
        placed = true;
        break;
      }
    }
    if (!placed) {
      if (!putOne(p, cabins)) unassigned.push(p.id);
    }
  }

  // 儿童散客：必须落入已有成人或与另一成人同配的舱 —— 简化为把儿童排在成人之后合舱
  const adults = rest.filter((p) => !p.cabinId && p.age >= cfg.escortAgeMin);
  const children = rest.filter((p) => !p.cabinId && p.age < cfg.childAgeMax);
  for (const a of adults) {
    // 尽量填进已有成人的舱以“捎带”后续儿童
    const cabins = available().sort((x, y) => {
      const ax = occ.get(x.id)?.length ?? 0;
      const ay = occ.get(y.id)?.length ?? 0;
      return ay - ax || x.deck.localeCompare(y.deck) || x.number - y.number;
    });
    if (!putOne(a, cabins)) unassigned.push(a.id);
  }
  for (const ch of children) {
    // 优先有成人的未满舱
    const good = available().filter((c) => {
      const inside = occ.get(c.id) ?? [];
      return freeBeds(c, occ) > 0 && inside.some((q) => q.age >= cfg.escortAgeMin);
    });
    if (!putOne(ch, good)) {
      // 退而求其次占个空舱，复核会报 CHILD_ALONE 由客服处置
      if (!putOne(ch, available())) unassigned.push(ch.id);
    }
  }

  // 3) 其余散客兜底
  for (const p of rest) {
    if (p.cabinId) continue;
    if (!putOne(p, available())) unassigned.push(p.id);
  }

  return { assigned: pax.length - unassigned.length, unassigned };
}

// ---------------------------------------------------------------------------
// 事件 / reducer（事件溯源：操作链 + 状态全部由事件重放得到，刷新后仍在）
// ---------------------------------------------------------------------------

type AnyPayload = Record<string, unknown>;

export function nextId(state: AppState): number {
  state.seq += 1;
  return state.seq;
}

function upsert<T extends { id: string }>(arr: T[], item: T): void {
  const i = arr.findIndex((x) => x.id === item.id);
  if (i >= 0) arr[i] = item;
  else arr.push(item);
}

/** 应用一个事件到状态（纯函数语义：调用前由 dispatch 负责克隆） */
function apply(state: AppState, type: string, payload: AnyPayload): void {
  switch (type) {
    case 'VOYAGE_ADD':
    case 'VOYAGE_UPDATE':
      upsert(state.voyages, payload.voyage as Voyage);
      break;
    case 'STATION_ADD':
      upsert(state.stations, payload.station as MusterStation);
      break;
    case 'BOAT_ADD':
      upsert(state.boats, payload.boat as Lifeboat);
      break;
    case 'CABIN_ADD':
      upsert(state.cabins, payload.cabin as Cabin);
      break;
    case 'CABIN_UPDATE': {
      const c = byId(state.cabins, payload.id as string);
      if (c) {
        const patch = payload.patch as Partial<Pick<Cabin, 'beds' | 'maxOccupancy' | 'stationId' | 'accessible' | 'deck' | 'number'>>;
        Object.assign(c, patch);
        // 资料（定员/集合点等）变更同样令并发编辑面板失效
        c.version += 1;
        c.lastEditedBy = payload.by as string;
      }
      break;
    }
    case 'CABIN_STATUS': {
      const c = byId(state.cabins, payload.cabinId as string);
      if (c) {
        c.status = payload.status as Cabin['status'];
        c.version += 1;
        c.lastEditedBy = payload.by as string;
      }
      break;
    }
    case 'GROUP_ADD':
      upsert(state.groups, payload.group as AppState['groups'][number]);
      break;
    case 'PASSENGER_ADD':
      upsert(state.passengers, payload.passenger as Passenger);
      break;
    case 'PASSENGER_REMOVE': {
      const p = byId(state.passengers, payload.passengerId as string);
      if (p) {
        p.status = 'removed';
        p.cabinId = null;
      }
      break;
    }
    case 'ASSIGNMENT_CLEAR':
      for (const p of state.passengers) {
        if (p.voyageId === payload.voyageId && p.status !== 'removed') p.cabinId = null;
      }
      break;
    case 'AUTO_ASSIGN': {
      autoAssign(state, payload.voyageId as string);
      for (const c of state.cabins) {
        // 自动分配不递增人工编辑版本，仅记录
      }
      break;
    }
    case 'PROPOSAL_APPLY': {
      const proposal = payload.proposal as CabinEditProposal;
      const paxMap = new Map(state.passengers.map((p) => [p.id, p]));
      const forced = new Set<string>();
      for (const edit of proposal.edits) {
        const cabin = byId(state.cabins, edit.cabinId);
        if (!cabin) continue;
        for (const id of edit.remove) {
          const p = paxMap.get(id);
          if (p && p.cabinId === cabin.id) p.cabinId = null;
        }
        for (const id of edit.add) {
          const p = paxMap.get(id);
          if (p) p.cabinId = cabin.id;
        }
        cabin.version += 1;
        cabin.lastEditedBy = proposal.by;
        if (proposal.forceOverMaxOccupancy) forced.add(cabin.id);
      }
      const arb = state.arbitrations.find((a) => a.id === payload.arbitrationId);
      if (arb) {
        arb.status = 'applied';
        arb.resolvedBy = payload.by as string;
        arb.resolvedTs = payload.ts as number;
        arb.resolutionNote = payload.note as string;
      }
      break;
    }
    case 'PROPOSAL_DISCARD': {
      const arb = state.arbitrations.find((a) => a.id === payload.arbitrationId);
      if (arb) {
        arb.status = 'discarded';
        arb.resolvedBy = payload.by as string;
        arb.resolvedTs = payload.ts as number;
        arb.resolutionNote = payload.note as string;
      }
      break;
    }
    case 'PROPOSAL_RAISE': {
      state.arbitrations.push(payload.arbitration as AppState['arbitrations'][number]);
      break;
    }
    case 'CONFIRM': {
      state.confirmations[payload.voyageId as string] = payload.confirmation as AppState['confirmations'][string];
      const v = byId(state.voyages, payload.voyageId as string);
      if (v) v.status = 'confirmed';
      break;
    }
    case 'CONFIRM_REVOKE': {
      delete state.confirmations[payload.voyageId as string];
      const v = byId(state.voyages, payload.voyageId as string);
      if (v) v.status = 'active';
      break;
    }
    case 'CONFIRM_INVALIDATED': {
      // 确认后出现新的错误级冲突：确认记录立即失效（原确认保留作审计凭据）
      const conf = state.confirmations[payload.voyageId as string];
      if (conf) {
        conf.invalidated = {
          by: payload.by as string,
          ts: payload.ts as number,
          reason: payload.reason as string,
          conflictIds: payload.conflictIds as string[],
        };
      }
      const v = byId(state.voyages, payload.voyageId as string);
      if (v && v.status === 'confirmed') v.status = 'invalidated';
      break;
    }
    case 'CONFIG_UPDATE':
      state.config = { ...state.config, ...(payload.patch as Partial<RulesConfig>) };
      break;
    case 'RESET':
      // 重置由 store 直接替换，不走这里
      break;
  }
}

/**
 * 派发舱室修改提案。
 * 并发语义：若任一目标舱的当前 version 与提案 baseVersion 不符，
 * 不覆盖任何一方 —— 两份修改都保留：先到者已落状态，后到者进入裁定队列。
 * 容量语义：超过物理床位硬拒绝；超过禁住人数须主管强制（force），进入裁定队列。
 */
export function dispatchCabinProposal(
  store: EventStore,
  by: string,
  proposal: Omit<CabinEditProposal, 'id' | 'ts'>,
): { ok: boolean; arbitrationId?: string; reason?: string } {
  const ts = Date.now();
  // 投影每间舱调整后人数，做物理床位与禁住人数校验
  const projected = new Map<string, number>();
  for (const edit of proposal.edits) {
    const cabin = store.state.cabins.find((c) => c.id === edit.cabinId);
    if (!cabin) return { ok: false, reason: `舱室 ${edit.cabinId} 不存在` };
    if (cabin.status === 'sealed') return { ok: false, reason: `舱 ${cabin.deck}-${cabin.number} 已临时封舱` };
    const current = store.state.passengers.filter((p) => p.cabinId === cabin.id && p.status !== 'removed').length;
    const adds = edit.add.filter((id) => {
      const p = store.state.passengers.find((x) => x.id === id);
      return p && p.cabinId !== cabin.id;
    }).length;
    const removes = edit.remove.filter((id) => {
      const p = store.state.passengers.find((x) => x.id === id);
      return p && p.cabinId === cabin.id;
    }).length;
    const after = current + adds - removes;
    projected.set(cabin.id, after);
    if (after > cabin.beds) {
      return {
        ok: false,
        reason: `舱 ${cabin.deck}-${cabin.number} 调整后 ${after} 人，超过物理床位 ${cabin.beds}，不可提交`,
      };
    }
  }

  // 禁住人数：未勾选强制 → 直接拒绝；勾选强制 → 进裁定队列等主管批准
  const overMax = proposal.edits.filter((e) => {
    const cabin = store.state.cabins.find((c) => c.id === e.cabinId)!;
    return (projected.get(cabin.id) ?? 0) > cabin.maxOccupancy;
  });
  if (overMax.length && !proposal.forceOverMaxOccupancy) {
    const detail = overMax
      .map((e) => {
        const cabin = store.state.cabins.find((c) => c.id === e.cabinId)!;
        return `${cabin.deck}-${cabin.number} 将达 ${projected.get(cabin.id)} 人（禁住 ${cabin.maxOccupancy}）`;
      })
      .join('；');
    return { ok: false, reason: `超过禁住人数，需主管强制批准：${detail}` };
  }

  const stale: AppState['arbitrations'][number]['stale'] = [];
  for (const edit of proposal.edits) {
    const cabin = store.state.cabins.find((c) => c.id === edit.cabinId)!;
    if (cabin.version !== edit.baseVersion) {
      stale.push({
        cabinId: cabin.id,
        baseVersion: edit.baseVersion,
        currentVersion: cabin.version,
        currentEditor: cabin.lastEditedBy,
      });
    }
  }

  const full: CabinEditProposal = { ...proposal, id: uid('prop'), ts };

  if (stale.length > 0 || overMax.length > 0) {
    // 并发冲突 或 超禁住强制：修改原样保留进裁定队列，绝不静默覆盖、不自动超员
    const arbitration: AppState['arbitrations'][number] = {
      id: uid('arb'),
      proposal: full,
      raisedTs: ts,
      status: 'pending',
      kind: stale.length > 0 ? 'concurrency' : 'force',
      stale,
    };
    appendEvent(store, by, 'PROPOSAL_RAISE', { arbitration });
    return {
      ok: false,
      arbitrationId: arbitration.id,
      reason: stale.length > 0 ? 'concurrent' : 'needs_force_approval',
    };
  }

  // 无冲突：直接生效
  appendEvent(store, by, 'PROPOSAL_APPLY', { proposal: full, ts, note: proposal.note });
  return { ok: true, arbitrationId: undefined };
}

export function resolveArbitration(
  store: EventStore,
  arbitrationId: string,
  decision: 'apply' | 'discard',
  by: string,
  note: string,
  force = false,
): void {
  const arb = store.state.arbitrations.find((a) => a.id === arbitrationId);
  if (!arb || arb.status !== 'pending') return;
  const ts = Date.now();
  if (decision === 'apply') {
    // 应用时以当前版本重放：封舱需拦截；物理床位仍硬约束
    const proposal = force ? { ...arb.proposal, forceOverMaxOccupancy: true } : arb.proposal;
    for (const edit of proposal.edits) {
      const cabin = store.state.cabins.find((c) => c.id === edit.cabinId)!;
      const current = store.state.passengers.filter(
        (p) => p.cabinId === cabin.id && p.status !== 'removed',
      ).length;
      const addIds = edit.add.filter((id) => {
        const p = store.state.passengers.find((x) => x.id === id);
        return p && p.cabinId !== cabin.id;
      });
      const remCount = edit.remove.filter((id) => {
        const p = store.state.passengers.find((x) => x.id === id);
        return p && p.cabinId === cabin.id;
      }).length;
      const after = current + addIds.length - remCount;
      if (cabin.status === 'sealed') {
        note = `${note}｜应用中止：舱 ${cabin.deck}-${cabin.number} 已封舱`;
        appendEvent(store, by, 'PROPOSAL_DISCARD', { arbitrationId, ts, note });
        return;
      }
      if (after > cabin.beds) {
        note = `${note}｜应用中止：舱 ${cabin.deck}-${cabin.number} 将超物理床位（${after}>${cabin.beds}）`;
        appendEvent(store, by, 'PROPOSAL_DISCARD', { arbitrationId, ts, note });
        return;
      }
      if (after > cabin.maxOccupancy && !force) {
        note = `${note}｜应用中止：超过禁住人数且未勾选强制（如需突破禁住人数请勾选，但仍受物理床位限制）`;
        appendEvent(store, by, 'PROPOSAL_DISCARD', { arbitrationId, ts, note });
        return;
      }
    }
    // 用当前版本作为基准重新落库
    const rebased: CabinEditProposal = {
      ...proposal,
      edits: proposal.edits.map((e) => ({
        ...e,
        baseVersion: store.state.cabins.find((c) => c.id === e.cabinId)!.version,
      })),
    };
    appendEvent(store, by, 'PROPOSAL_APPLY', {
      arbitrationId,
      proposal: rebased,
      ts,
      note: `人工裁定应用（${note}）`,
    });
  } else {
    appendEvent(store, by, 'PROPOSAL_DISCARD', { arbitrationId, ts, note });
  }
}

export function appendEvent(store: EventStore, by: string, type: string, payload: AnyPayload): DomainEvent {
  const ts = typeof payload.ts === 'number' ? (payload.ts as number) : Date.now();
  // 事件载荷是不可变快照；apply 必须操作其副本，使 state 与事件链互不共享对象引用
  const snapshot = clone(payload) as AnyPayload;
  const event: DomainEvent = { id: nextId(store.state), ts, by, type, payload: snapshot };
  store.events.push(event);
  apply(store.state, type, clone(snapshot));
  return event;
}

/** 从空状态重放全部事件（刷新恢复 / 持久化加载后校验） */
export function replay(events: DomainEvent[], config?: Partial<RulesConfig>): EventStore {
  const store = emptyStore();
  if (config) store.state.config = { ...store.state.config, ...config };
  for (const e of events) apply(store.state, e.type, clone(e.payload) as AnyPayload);
  store.events = events.map((e) => ({ ...e }));
  store.state.seq = events.reduce((m, e) => Math.max(m, e.id), 0);
  return store;
}

// ---------------------------------------------------------------------------
// 便捷操作
// ---------------------------------------------------------------------------

export function setCabinStatus(store: EventStore, cabinId: string, status: Cabin['status'], by: string): void {
  appendEvent(store, by, 'CABIN_STATUS', { cabinId, status, by, ts: Date.now() });
}

export function autoAssignVoyage(store: EventStore, voyageId: string, by: string): void {
  appendEvent(store, by, 'AUTO_ASSIGN', { voyageId, ts: Date.now() });
}

export function clearAssignment(store: EventStore, voyageId: string, by: string): void {
  appendEvent(store, by, 'ASSIGNMENT_CLEAR', { voyageId, ts: Date.now() });
}

export function confirmVoyage(
  store: EventStore,
  voyageId: string,
  by: string,
  acknowledgedWarningIds: string[],
  conflicts: Conflict[],
): { ok: boolean; reason?: string } {
  const errors = blockingConflicts(conflicts, voyageId);
  if (errors.length) {
    return { ok: false, reason: `仍有 ${errors.length} 项未解除的错误级冲突，不能确认登船清单` };
  }
  const warnings = conflicts.filter((c) => c.voyageId === voyageId && c.severity === 'warning');
  const unack = warnings.filter((w) => !acknowledgedWarningIds.includes(w.id));
  if (unack.length) {
    return { ok: false, reason: `还有 ${unack.length} 项警告未知悉` };
  }
  appendEvent(store, by, 'CONFIRM', {
    voyageId,
    ts: Date.now(),
    confirmation: { voyageId, by, ts: Date.now(), acknowledgedWarningIds },
  });
  return { ok: true };
}

export function revokeConfirmation(store: EventStore, voyageId: string, by: string): void {
  appendEvent(store, by, 'CONFIRM_REVOKE', { voyageId, ts: Date.now() });
}

/**
 * 确认失效清扫：任何已确认航次一旦出现错误级冲突（新产生或原冲突回归），
 * 确认记录立即失效并写入事件链。只在现场提交路径调用；重放时失效事件已在链中，不重复追加。
 * 返回本次失效的航次数。
 */
export function sweepInvalidations(store: EventStore, by = '系统'): string[] {
  const invalidated: string[] = [];
  const all = revalidate(store.state);
  for (const [voyageId, confirmation] of Object.entries(store.state.confirmations)) {
    if (confirmation.invalidated) continue;
    const errors = blockingConflicts(all, voyageId);
    if (!errors.length) continue;
    const reason = `确认后新增/仍有 ${errors.length} 项错误级冲突，登船清单确认自动失效：${errors
      .slice(0, 3)
      .map((c) => RULE_LABEL[c.rule])
      .join('、')}${errors.length > 3 ? ' 等' : ''}`;
    appendEvent(store, by, 'CONFIRM_INVALIDATED', {
      voyageId,
      ts: Date.now(),
      reason,
      conflictIds: errors.map((c) => c.id),
    });
    invalidated.push(voyageId);
  }
  return invalidated;
}

/** 确认记录当前是否有效（未失效） */
export function isConfirmationValid(state: AppState, voyageId: string): boolean {
  const c = state.confirmations[voyageId];
  return !!c && !c.invalidated;
}

export { clone, byId };
