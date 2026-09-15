// 持久化与订阅 Store
// 浏览器：localStorage。事件链为唯一事实源；跨标签页采用“身份并集合并 + 规范化重放”，
// 杜绝两个页面同时提交时后写覆盖先写。
import {
  appendEvent,
  clearAssignment,
  confirmVoyage,
  dispatchCabinProposal,
  emptyStore,
  resolveArbitration,
  revokeConfirmation,
  revalidate,
  replay,
  sweepInvalidations,
} from './engine';
import { canonicalReplay, eventKey, newEpoch, normalize, sameChain, unionEvents, type Envelope } from './sync';
import type { CabinEditProposal, Conflict, DomainEvent, EventStore } from './types';

const STORAGE_KEY = 'cruise-desk-events-v1';
const SESSION_KEY = 'cruise-desk-agent-v1';

/** 旧版持久化是裸事件数组；新版是信封 */
export type StoredDoc = Envelope | DomainEvent[];

export interface PersistenceAdapter {
  load(): StoredDoc | null;
  save(doc: StoredDoc): void;
}

export const localStorageAdapter: PersistenceAdapter = {
  load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? (JSON.parse(raw) as StoredDoc) : null;
    } catch {
      return null;
    }
  },
  save(doc) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(doc));
  },
};

function eventsOf(doc: StoredDoc | null | undefined): DomainEvent[] {
  if (!doc) return [];
  return Array.isArray(doc) ? doc : doc.events;
}
function epochOf(doc: StoredDoc | null | undefined): string | undefined {
  return doc && !Array.isArray(doc) ? doc.epoch : undefined;
}

function makeOrigin(): string {
  // 标签页身份：同源同环境下尽量唯一
  const rand = Math.random().toString(36).slice(2, 8);
  return `tab_${Date.now().toString(36)}_${rand}`;
}

export class DeskStore {
  private store: EventStore;
  private conflicts: Conflict[] = [];
  private listeners = new Set<() => void>();
  private adapter: PersistenceAdapter | null;
  private origin: string;
  /** 每次提交递增，供 useSyncExternalStore 作为快照（事件数组 push 不改引用） */
  revision = 0;

  constructor(adapter: PersistenceAdapter | null = null, seed?: () => EventStore, origin?: string) {
    this.adapter = adapter;
    this.origin = origin ?? makeOrigin();
    const doc = adapter?.load();
    const loaded = eventsOf(doc);

    if (loaded.length) {
      // 规范化重放：对旧数据同样执行一次合并裁定与去重
      this.store = canonicalReplay(loaded);
      this.store.epoch = epochOf(doc) ?? newEpoch();
    } else if (seed) {
      const seeded = seed();
      this.store = canonicalReplay(seeded.events);
      this.store.epoch = newEpoch();
    } else {
      this.store = emptyStore();
      this.store.epoch = newEpoch();
    }
    this.store.origin = this.origin;
    this.store.cseq = this.maxOwnCseq();

    // 启动自愈：旧数据下已确认航次若命中当前规则（含新增校验），确认立即失效
    this.sweep('系统');
    this.persist();
    this.conflicts = revalidate(this.store.state);
  }

  private maxOwnCseq(): number {
    let m = 0;
    for (const e of this.store.events) if (e.origin === this.origin && typeof e.cseq === 'number') m = Math.max(m, e.cseq);
    return m;
  }

  private persist() {
    const doc: Envelope = { format: 2, epoch: this.store.epoch ?? newEpoch(), events: this.store.events };
    this.store.epoch = doc.epoch;
    this.adapter?.save(doc);
  }

  get events(): readonly DomainEvent[] {
    return this.store.events;
  }
  get state() {
    return this.store.state;
  }
  get raw(): EventStore {
    return this.store;
  }
  get allConflicts(): Conflict[] {
    return this.conflicts;
  }
  get tabOrigin(): string {
    return this.origin;
  }

  conflictsForVoyage(voyageId: string): Conflict[] {
    return this.conflicts.filter((c) => c.voyageId === voyageId);
  }

  /** 任意领域写操作的统一入口：读-改-写合并 → 失效清扫 → 落盘 → 全量复核 → 通知 */
  commit(by: string, type: string, payload: Record<string, unknown>): DomainEvent {
    const ev = appendEvent(this.store, by, type, { ts: Date.now(), ...payload });
    this.afterChange();
    return ev;
  }

  /** 提交舱室修改提案：无并发直接生效；命中过期版本则进入裁定队列，两份修改都保留 */
  submitProposal(by: string, proposal: Omit<CabinEditProposal, 'id' | 'ts'>) {
    const result = dispatchCabinProposal(this.store, by, proposal);
    this.afterChange();
    // 跨标签读-改-写可能把本端刚“直接生效”的提案重新识别为过期并降级为待裁定
    if (result.ok && result.proposalId) {
      const mergedArb = this.store.state.arbitrations.find(
        (a) => a.status === 'pending' && a.id === `arb_merge_${result.proposalId}`,
      );
      if (mergedArb) {
        return { ok: false, arbitrationId: mergedArb.id, reason: 'concurrent', demotedBySync: true };
      }
    }
    return result;
  }

  resolveArbitration(id: string, decision: 'apply' | 'discard', by: string, note: string, force: boolean) {
    resolveArbitration(this.store, id, decision, by, note, force);
    this.afterChange();
  }

  autoAssign(voyageId: string, by: string) {
    appendEvent(this.store, by, 'AUTO_ASSIGN', { voyageId, ts: Date.now() });
    this.afterChange();
  }

  clearAssignment(voyageId: string, by: string) {
    clearAssignment(this.store, voyageId, by);
    this.afterChange();
  }

  confirm(voyageId: string, by: string, acknowledgedWarningIds: string[]) {
    const res = confirmVoyage(this.store, voyageId, by, acknowledgedWarningIds, this.conflicts);
    if (res.ok) this.afterChange();
    return res;
  }

  revokeConfirm(voyageId: string, by: string) {
    revokeConfirmation(this.store, voyageId, by);
    this.afterChange();
  }

  /**
   * 读-改-写：每次本地提交后，先与持久层最新事件链做并集合并（防止本地基于旧快照覆盖他页写入），
   * 规范化重放（过期直接提案自动转待裁定）、失效清扫，最后落盘。
   */
  private afterChange() {
    this.mergeFromPersistence();
    this.sweep('系统');
    this.persist();
    this.conflicts = revalidate(this.store.state);
    this.emit();
  }

  private adopt(next: EventStore, epoch: string | undefined) {
    next.origin = this.origin;
    next.epoch = epoch;
    next.cseq = Math.max(
      ...next.events.map((e) => (e.origin === this.origin && typeof e.cseq === 'number' ? e.cseq : 0)),
      0,
    );
    this.store = next;
  }

  private sweep(by: string) {
    sweepInvalidations(this.store, by);
  }

  /** 与持久层当前快照合并（本地写后 RMW 用，不发通知） */
  private mergeFromPersistence() {
    const remote = this.adapter?.load() ?? null;
    this.mergeDoc(remote, { silent: true, adoptEpoch: false });
  }

  /**
   * 跨标签页同步入口：合并另一页面写入的文档。
   * - 不同 epoch（对方重置了演示数据）：整体采用对方链与新 epoch；
   * - 同 epoch：本地链 ∪ 远端链，规范化重放；同批事件重复同步幂等。
   * 返回是否发生了实质变化。
   */
  mergeRemote(doc: StoredDoc): boolean {
    return this.mergeDoc(doc, { silent: false, adoptEpoch: true });
  }

  private mergeDoc(remoteDoc: StoredDoc | null, opts: { silent: boolean; adoptEpoch: boolean }): boolean {
    const remoteEvents = eventsOf(remoteDoc);
    const remoteEpoch = epochOf(remoteDoc);
    const localEpoch = this.store.epoch;

    if (remoteEpoch && opts.adoptEpoch && localEpoch && remoteEpoch !== localEpoch) {
      // 显式重置：采用对方代次
      const next = canonicalReplay(remoteEvents);
      this.adopt(next, remoteEpoch);
      this.sweep('系统');
      this.persist();
      this.conflicts = revalidate(this.store.state);
      if (!opts.silent) this.emit();
      return true;
    }

    if (!remoteEvents.length) return false;

    const merged = normalize(unionEvents(this.store.events, remoteEvents));
    if (sameChain(normalize(this.store.events), merged)) return false;

    const next = replay(merged);
    this.adopt(next, localEpoch ?? remoteEpoch);
    this.sweep('系统');
    this.persist();
    this.conflicts = revalidate(this.store.state);
    if (!opts.silent) this.emit();
    return true;
  }

  reset(seed?: () => EventStore) {
    const fresh = seed ? seed() : emptyStore();
    const next = canonicalReplay(fresh.events);
    this.adopt(next, newEpoch()); // 新代次：旧历史不参与并集
    this.sweep('系统');
    this.persist();
    this.conflicts = revalidate(this.store.state);
    this.emit();
  }

  /** 测试/诊断：当前链的规范身份签名 */
  chainSignature(): string {
    return normalize(this.store.events)
      .map((e) => `${eventKey(e)}:${e.type}`)
      .join('|');
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  private emit() {
    this.revision += 1;
    for (const fn of this.listeners) fn();
  }
}

export function currentAgent(): string {
  try {
    return localStorage.getItem(SESSION_KEY) ?? '客服·小周';
  } catch {
    return '客服·小周';
  }
}

export function setCurrentAgent(name: string) {
  try {
    localStorage.setItem(SESSION_KEY, name);
  } catch {
    /* ignore */
  }
}

/** 跨标签页：另一个客服的写入经 storage 事件并集合并进本页（不覆盖、可重复、最终一致） */
export function bindCrossTab(store: DeskStore): () => void {
  const onStorage = (e: StorageEvent) => {
    if (e.key !== STORAGE_KEY || !e.newValue) return;
    try {
      const doc = JSON.parse(e.newValue) as StoredDoc;
      store.mergeRemote(doc);
    } catch {
      /* ignore */
    }
  };
  window.addEventListener('storage', onStorage);
  return () => window.removeEventListener('storage', onStorage);
}
