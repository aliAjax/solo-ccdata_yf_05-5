// 跨标签页事件同步与合并
//
// 要解决的问题：两个页面同时改舱时，localStorage 里只有一条“全量事件链”，
// 后保存的页面会覆盖先保存页面的事件。这里改为：
//   1) 每个事件带全局身份（来源客户端 origin + 该客户端单调序号 cseq，或显式 ekey）；
//   2) 同步时做本地链 ∪ 远端链的并集，而不是整链替换；
//   3) 合并后按时间确定性排序、重新编号，并按舱室版本重放：
//      过期的直接生效提案（PROPOSAL_APPLY）转成待人工裁定（PROPOSAL_RAISE），
//      双方原始修改都保留；裁定号由提案 id 确定性派生，重复同步不会产生第二条；
//   4) 同一航次的 CONFIRM_INVALIDATED 去重；
//   5) 同一份输入永远得到同一条规范化链（幂等），刷新/重开页面结果一致。
import { replay } from './engine';
import type { DomainEvent, EventStore } from './types';

export interface Envelope {
  format: 2;
  /** 数据代次：重置演示数据会换 epoch；不同 epoch 不做并集（重置即有意清空历史） */
  epoch: string;
  events: DomainEvent[];
}

// ---------------------------------------------------------------------------
// 事件身份
// ---------------------------------------------------------------------------

function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const obj = v as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

/** FNV-1a 32 位，给没有身份的旧事件派生稳定身份 */
function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/** 事件全局身份键。同一事件无论被同步多少次，键不变 */
export function eventKey(e: DomainEvent): string {
  if (e.ekey) return e.ekey;
  if (e.origin && e.cseq != null) return `${e.origin}#${e.cseq}`;
  // 旧版（v1）事件：按内容派生
  return `legacy#${fnv1a(stableStringify({ by: e.by, type: e.type, ts: e.ts, payload: e.payload }))}`;
}

// ---------------------------------------------------------------------------
// 合并：并集 + 确定性排序
// ---------------------------------------------------------------------------

function cseqOrdinal(e: DomainEvent): number {
  if (typeof e.cseq === 'number') return e.cseq;
  if (typeof e.cseq === 'string') return Number.parseInt(fnv1a(e.cseq), 36);
  return 0;
}

function compareEvents(a: DomainEvent, b: DomainEvent): number {
  if (a.ts !== b.ts) return a.ts - b.ts;
  const oa = a.origin ?? '~legacy';
  const ob = b.origin ?? '~legacy';
  if (oa !== ob) return oa < ob ? -1 : 1;
  return cseqOrdinal(a) - cseqOrdinal(b);
}

/** 多批事件按身份并集（任一副本保留，内容相同） */
export function unionEvents(...chains: DomainEvent[][]): DomainEvent[] {
  const byKey = new Map<string, DomainEvent>();
  for (const chain of chains) {
    for (const e of chain) {
      const k = eventKey(e);
      if (!byKey.has(k)) byKey.set(k, e);
    }
  }
  return [...byKey.values()].sort(compareEvents);
}

// ---------------------------------------------------------------------------
// 规范化：重放裁定
// ---------------------------------------------------------------------------

interface CabinVer {
  version: number;
  lastEditedBy?: string;
}

type NormEvent = DomainEvent;

/**
 * 按合并后的统一顺序重走一遍版本历史，识别过期提案。
 * 规则与单页乐观锁一致：
 *  - 直接生效的 PROPOSAL_APPLY（无 arbitrationId）若任一编辑舱的基准版本
 *    与重放当时的版本不符，则该提案在合并视图中属于“后到且过期”，
 *    转成 PROPOSAL_RAISE（concurrency），原始提案与编辑明细原样保留；
 *  - 经人工裁定的 APPLY（带 arbitrationId）始终按重放生效；
 *  - 每个航次只保留第一条 CONFIRM_INVALIDATED。
 */
export function normalize(events: DomainEvent[]): DomainEvent[] {
  const merged = unionEvents(events);
  const versions = new Map<string, CabinVer>();
  const out: NormEvent[] = [];
  const invalidatedVoyages = new Set<string>();

  const ver = (cabinId: string): CabinVer => {
    let v = versions.get(cabinId);
    if (!v) {
      v = { version: 0 };
      versions.set(cabinId, v);
    }
    return v;
  };

  for (const e of merged) {
    const p = e.payload as Record<string, unknown>;

    if (e.type === 'CABIN_ADD') {
      const cabin = p.cabin as { id: string; version?: number };
      versions.set(cabin.id, { version: cabin.version ?? 0 });
      out.push(e);
      continue;
    }

    if (e.type === 'CABIN_STATUS') {
      const v = ver(p.cabinId as string);
      v.version += 1;
      v.lastEditedBy = (p.by as string) ?? e.by;
      out.push(e);
      continue;
    }

    if (e.type === 'CABIN_UPDATE') {
      const v = ver(p.id as string);
      v.version += 1;
      v.lastEditedBy = (p.by as string) ?? e.by;
      out.push(e);
      continue;
    }

    if (e.type === 'PROPOSAL_APPLY' && !p.arbitrationId) {
      // 客服直接提交并在其本地生效的提案 —— 合并时重新判定是否过期
      const proposal = p.proposal as {
        id: string;
        by: string;
        ts: number;
        note: string;
        forceOverMaxOccupancy?: boolean;
        edits: { cabinId: string; baseVersion: number; add: string[]; remove: string[] }[];
      };
      const stale = proposal.edits
        .filter((ed) => ver(ed.cabinId).version !== ed.baseVersion)
        .map((ed) => {
          const cv = ver(ed.cabinId);
          return {
            cabinId: ed.cabinId,
            baseVersion: ed.baseVersion,
            currentVersion: cv.version,
            currentEditor: cv.lastEditedBy,
          };
        });

      if (stale.length > 0) {
        // 过期：不静默覆盖，转成待裁定，原始修改完整保留；裁定号确定性派生（重复同步幂等）
        const arbId = `arb_merge_${proposal.id}`;
        const raised: DomainEvent = {
          id: e.id,
          ts: e.ts,
          by: e.by,
          type: 'PROPOSAL_RAISE',
          origin: e.origin,
          cseq: e.cseq,
          ekey: e.ekey,
          payload: {
            arbitration: {
              id: arbId,
              proposal,
              raisedTs: e.ts,
              status: 'pending',
              kind: 'concurrency',
              stale,
            },
          },
        };
        out.push(raised);
        continue;
      }

      // 未过期：生效，推进版本
      for (const ed of proposal.edits) {
        const v = ver(ed.cabinId);
        v.version += 1;
        v.lastEditedBy = proposal.by;
      }
      out.push(e);
      continue;
    }

    if (e.type === 'PROPOSAL_APPLY' && p.arbitrationId) {
      // 人工裁定应用：提案已在重放更早位置（可能是规范化出的 RAISE）入队
      const proposal = p.proposal as { edits: { cabinId: string }[] };
      for (const ed of proposal.edits) ver(ed.cabinId).version += 1;
      out.push(e);
      continue;
    }

    if (e.type === 'CONFIRM_INVALIDATED') {
      const voyageId = p.voyageId as string;
      if (invalidatedVoyages.has(voyageId)) continue; // 同航次只保留第一条
      invalidatedVoyages.add(voyageId);
      out.push(e);
      continue;
    }

    out.push(e);
  }

  // 重新顺序编号（跨客户端的数字 id 可能撞号；编号仅用于展示与 seq 基准）
  return out.map((e, i) => ({ ...e, id: i + 1 }));
}

// ---------------------------------------------------------------------------
// 规范化重放：得到与事件链一致的现场
// ---------------------------------------------------------------------------

export function canonicalReplay(events: DomainEvent[]): EventStore {
  return replay(normalize(events));
}

export function sameChain(a: DomainEvent[], b: DomainEvent[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (eventKey(a[i]) !== eventKey(b[i])) return false;
    if (a[i].type !== b[i].type) return false;
  }
  return true;
}

export function newEpoch(): string {
  return `ep_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
