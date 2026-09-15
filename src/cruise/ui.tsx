// 界面层共享：单例 DeskStore、React 订阅 Hook、格式化与派生数据
import { useSyncExternalStore } from 'react';
import { DeskStore, localStorageAdapter, currentAgent, setCurrentAgent, bindCrossTab } from './store';
import { buildSeedStore } from './seed';
import { cabinOccupancy, stationLoads } from './engine';
import type { AppState, Cabin, Conflict, Passenger } from './types';

export const desk = new DeskStore(
  typeof window === 'undefined' ? null : localStorageAdapter,
  () => buildSeedStore(true),
);

if (typeof window !== 'undefined') {
  bindCrossTab(desk);
}

export function useDesk(): {
  state: AppState;
  conflicts: Conflict[];
  events: typeof desk.events;
  store: DeskStore;
  revision: number;
} {
  const revision = useSyncExternalStore(
    (cb) => desk.subscribe(cb),
    () => desk.revision,
    () => 0,
  );
  return {
    state: desk.state,
    conflicts: desk.allConflicts,
    events: desk.events,
    store: desk,
    revision,
  };
}

export { currentAgent, setCurrentAgent };

// ---------------------------------------------------------------------------
// 格式化与派生
// ---------------------------------------------------------------------------

export function fmtTs(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function cabinLabel(c: Cabin): string {
  return `${c.deck} 甲板 · ${c.number}`;
}

export function paxName(state: AppState, id?: string): string {
  if (!id) return '—';
  return state.passengers.find((p) => p.id === id)?.name ?? id;
}

export interface CabinView {
  cabin: Cabin;
  inside: Passenger[];
  conflicts: Conflict[];
}

export function cabinViews(state: AppState, conflicts: Conflict[], voyageId: string): CabinView[] {
  const occ = cabinOccupancy(state, voyageId);
  return state.cabins.map((cabin) => ({
    cabin,
    inside: occ.get(cabin.id) ?? [],
    conflicts: conflicts.filter(
      (cf) => cf.cabinId === cabin.id || cf.cabinIds?.includes(cabin.id),
    ),
  }));
}

export function voyageConflicts(conflicts: Conflict[], voyageId: string): Conflict[] {
  return conflicts.filter((c) => c.voyageId === voyageId);
}

export function loads(state: AppState, voyageId: string) {
  return stationLoads(state, voyageId);
}

export const SEVERITY_DOT: Record<string, string> = {
  error: '● 错误',
  warning: '▲ 警告',
};
