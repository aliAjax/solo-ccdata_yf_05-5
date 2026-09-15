// 邮轮舱位分配与救生容量校验台 —— 领域类型

/** 冲突触发规则码 */
export type RuleCode =
  | 'OVERSOLD' // 超售：在船人数超过可住床位
  | 'UNASSIGNED' // 有旅客尚未分配舱位（不能确认登船清单）
  | 'CABIN_OVERCAP' // 舱室超员：超过禁住人数/床位数
  | 'CHILD_ALONE' // 儿童陪同缺失：舱内有儿童却无成年陪同
  | 'BOAT_OVERCAP' // 救生艇超员
  | 'STATION_IMBALANCE' // 集合点失衡（超容量/负载率失衡）
  | 'TURNAROUND' // 清洁周转时间不足
  | 'SEALED_OCCUPIED' // 临时封舱仍有住客
  | 'ACCESS_NEED' // 无障碍需求未满足
  | 'GROUP_SPLIT' // 团体被拆分到不同舱室
  | 'ADJACENCY'; // 相邻需求未满足

export type Severity = 'error' | 'warning';

export interface Conflict {
  /** 稳定 ID：规则+涉及对象，刷新/复核后同一冲突 ID 不变，便于追踪与警告知悉 */
  id: string;
  rule: RuleCode;
  severity: Severity;
  voyageId: string;
  cabinId?: string;
  cabinIds?: string[];
  passengerIds?: string[];
  stationId?: string;
  stationIds?: string[];
  boatId?: string;
  voyagePair?: [string, string];
  detail: string;
}

export interface RulesConfig {
  /** 救生艇按集合点归集所需额外冗余（如 0.10 = 10%） */
  boatCapacityMargin: number;
  /** 集合点负载率最大最小之差超过该值判为失衡（警告） */
  stationImbalanceRatio: number;
  /** 连续两个航次之间最少清洁周转时间（毫秒） */
  minTurnaroundMs: number;
  /** 儿童年龄上限（不含） */
  childAgeMax: number;
  /** 视为可陪同儿童的成人年龄下限（含） */
  escortAgeMin: number;
  /** 同甲板相邻舱室号差阈值（<= 该值视为相邻） */
  adjacencyCabinGap: number;
}

export type VoyageStatus = 'active' | 'confirmed' | 'cancelled';

export interface Voyage {
  id: string;
  code: string;
  name: string;
  departureTs: number;
  arrivalTs: number;
  status: VoyageStatus;
}

export interface MusterStation {
  id: string;
  name: string;
  deck: string;
  capacity: number;
}

export interface Lifeboat {
  id: string;
  name: string;
  stationId: string;
  /** 核定定员 */
  capacity: number;
}

export type CabinStatus = 'normal' | 'locked' | 'sealed';

export interface Cabin {
  id: string;
  /** 舱室号（数值部分参与相邻判定，如 101） */
  number: number;
  deck: string;
  beds: number;
  /** 禁住人数（消防/安全定员，通常 <= 床位数） */
  maxOccupancy: number;
  accessible: boolean;
  stationId: string;
  status: CabinStatus;
  /** 乐观锁版本：每次影响该舱的修改 +1，用于并发改舱裁定 */
  version: number;
  lastEditedBy?: string;
}

export interface Group {
  id: string;
  name: string;
  voyageId: string;
}

export type PassengerStatus = 'booked' | 'checkedin' | 'removed';

export interface Passenger {
  id: string;
  name: string;
  age: number;
  groupId?: string;
  needsAccessible?: boolean;
  /** 需要相邻的旅客 ID 列表 */
  adjacentWithIds?: string[];
  voyageId: string;
  cabinId: string | null;
  status: PassengerStatus;
}

/** 一次针对单个舱室的人员增删（换舱 = 源舱 remove + 目标舱 add） */
export interface CabinEdit {
  cabinId: string;
  baseVersion: number;
  add: string[];
  remove: string[];
}

export interface CabinEditProposal {
  id: string;
  by: string;
  ts: number;
  note: string;
  edits: CabinEdit[];
  /** 人工强制时允许超过禁住人数（仍不允许超过物理床位） */
  forceOverMaxOccupancy?: boolean;
}

export type ArbitrationStatus = 'pending' | 'applied' | 'discarded' | 'custom';

export interface Arbitration {
  id: string;
  proposal: CabinEditProposal;
  raisedTs: number;
  status: ArbitrationStatus;
  /** concurrency=两人同改一舱；force=客服申请超禁住人数，待主管强制批准 */
  kind: 'concurrency' | 'force';
  /** 后提交方命中的过期版本明细：舱室 -> (提案基准版本, 当前版本, 最后修改人) */
  stale: { cabinId: string; baseVersion: number; currentVersion: number; currentEditor?: string }[];
  resolvedBy?: string;
  resolvedTs?: number;
  resolutionNote?: string;
}

export interface Confirmation {
  voyageId: string;
  by: string;
  ts: number;
  acknowledgedWarningIds: string[];
}

export interface AppState {
  voyages: Voyage[];
  stations: MusterStation[];
  boats: Lifeboat[];
  cabins: Cabin[];
  groups: Group[];
  passengers: Passenger[];
  arbitrations: Arbitration[];
  confirmations: Record<string, Confirmation>;
  config: RulesConfig;
  seq: number;
}

/** 操作链上的一个事件 */
export interface DomainEvent {
  id: number;
  ts: number;
  by: string;
  type: string;
  payload: unknown;
}

export interface EventStore {
  events: DomainEvent[];
  state: AppState;
}
