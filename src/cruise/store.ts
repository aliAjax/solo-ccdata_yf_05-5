// 持久化与订阅 Store
// 浏览器：localStorage（事件链为唯一事实源，刷新后重放恢复方案与操作链），跨标签页 storage 事件实时同步
// Node：文件持久化（由 fileAdapter 注入）
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
import type { CabinEditProposal, Conflict, DomainEvent, EventStore } from './types';

const STORAGE_KEY = 'cruise-desk-events-v1';
const SESSION_KEY = 'cruise-desk-agent-v1';

export interface PersistenceAdapter {
  load(): DomainEvent[] | null;
  save(events: DomainEvent[]): void;
}

export const localStorageAdapter: PersistenceAdapter = {
  load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      return JSON.parse(raw) as DomainEvent[];
    } catch {
      return null;
    }
  },
  save(events) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(events));
  },
};

export class DeskStore {
  private store: EventStore;
  private conflicts: Conflict[] = [];
  private listeners = new Set<() => void>();
  private adapter: PersistenceAdapter | null;
  /** 每次提交递增，供 useSyncExternalStore 作为快照（事件数组 push 不改引用） */
  revision = 0;

  constructor(adapter: PersistenceAdapter | null = null, seed?: () => EventStore) {
    this.adapter = adapter;
    const events = adapter?.load();
    if (events && events.length) {
      this.store = replay(events);
    } else if (seed) {
      this.store = seed();
      this.persist();
    } else {
      this.store = emptyStore();
    }
    // 启动自愈：旧数据下已确认航次若命中当前规则（含新增校验），确认立即失效
    this.sweep('系统');
    this.conflicts = revalidate(this.store.state);
  }

  private persist() {
    this.adapter?.save(this.store.events);
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

  conflictsForVoyage(voyageId: string): Conflict[] {
    return this.conflicts.filter((c) => c.voyageId === voyageId);
  }

  /** 任意领域写操作的统一入口：追加事件 → 确认失效清扫 → 落盘 → 全量复核 → 通知 */
  commit(by: string, type: string, payload: Record<string, unknown>): DomainEvent {
    const ev = appendEvent(this.store, by, type, { ts: Date.now(), ...payload });
    this.afterChange();
    return ev;
  }

  /** 提交舱室修改提案：无并发直接生效；命中过期版本则进入裁定队列，两份修改都保留 */
  submitProposal(by: string, proposal: Omit<CabinEditProposal, 'id' | 'ts'>) {
    const result = dispatchCabinProposal(this.store, by, proposal);
    this.afterChange();
    return result;
  }

  resolveArbitration(id: string, decision: 'apply' | 'discard', by: string, note: string, force: boolean) {
    resolveArbitration(this.store, id, decision, by, note, force);
    this.afterChange();
  }

  /** 自动分配（先落事件，再持久化、全量复核、通知） */
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

  private afterChange() {
    // 任何写操作后：先做确认失效清扫（可能追加 CONFIRM_INVALIDATED 事件），再持久化、全量复核
    this.sweep('系统');
    this.persist();
    this.conflicts = revalidate(this.store.state);
    this.emit();
  }

  private sweep(by: string) {
    const invalidated = sweepInvalidations(this.store, by);
    if (invalidated.length) this.persist();
  }

  /** 用外部事件链替换（跨标签页同步） */
  replaceWithEvents(events: DomainEvent[]) {
    this.store = replay(events);
    this.sweep('系统');
    this.conflicts = revalidate(this.store.state);
    this.emit();
  }

  reset(seed?: () => EventStore) {
    this.store = seed ? seed() : emptyStore();
    this.sweep('系统');
    this.persist();
    this.conflicts = revalidate(this.store.state);
    this.emit();
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

/** 跨标签页：另一个客服的修改经 storage 事件实时进入本界面 */
export function bindCrossTab(store: DeskStore): () => void {
  const onStorage = (e: StorageEvent) => {
    if (e.key !== STORAGE_KEY || !e.newValue) return;
    try {
      const events = JSON.parse(e.newValue) as DomainEvent[];
      store.replaceWithEvents(events);
    } catch {
      /* ignore */
    }
  };
  window.addEventListener('storage', onStorage);
  return () => window.removeEventListener('storage', onStorage);
}
