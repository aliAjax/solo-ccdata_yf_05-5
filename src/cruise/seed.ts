// 演示种子数据：航次、舱室、救生艇、集合点、团体、旅客
import { appendEvent, emptyStore, uid } from './engine';
import type {
  Cabin,
  Group,
  Lifeboat,
  MusterStation,
  Passenger,
  Voyage,
} from './types';
import type { EventStore } from './types';

const TS = {
  v1dep: Date.parse('2026-09-18T09:00:00+08:00'),
  v1arr: Date.parse('2026-09-20T10:00:00+08:00'),
  v2dep: Date.parse('2026-09-20T14:00:00+08:00'), // 与 v1 仅隔 4 小时（不足 6 小时周转）
  v2arr: Date.parse('2026-09-22T18:00:00+08:00'),
};

function cabin(
  id: string,
  number: number,
  deck: string,
  beds: number,
  maxOccupancy: number,
  stationId: string,
  accessible = false,
): Cabin {
  return { id, number, deck, beds, maxOccupancy, accessible, stationId, status: 'normal', version: 0 };
}

export function buildSeedStore(autoAssignV1 = true): EventStore {
  const store = emptyStore();
  const sys = '系统';

  const voyages: Voyage[] = [
    { id: 'v1', code: 'DP-0918', name: '东海明珠号·上海—济州', departureTs: TS.v1dep, arrivalTs: TS.v1arr, status: 'active' },
    { id: 'v2', code: 'DP-0920', name: '东海明珠号·济州—福冈', departureTs: TS.v2dep, arrivalTs: TS.v2arr, status: 'active' },
  ];
  for (const voyage of voyages) appendEvent(store, sys, 'VOYAGE_ADD', { voyage, ts: Date.now() });

  const stations: MusterStation[] = [
    { id: 'sA', name: 'A 集合点（1 甲板）', deck: '1', capacity: 44 },
    { id: 'sB', name: 'B 集合点（2 甲板）', deck: '2', capacity: 44 },
    { id: 'sC', name: 'C 集合点（3 甲板）', deck: '3', capacity: 20 },
  ];
  for (const station of stations) appendEvent(store, sys, 'STATION_ADD', { station, ts: Date.now() });

  const boats: Lifeboat[] = [
    { id: 'b1', name: '救生艇 1 号', stationId: 'sA', capacity: 18 },
    { id: 'b2', name: '救生艇 2 号', stationId: 'sA', capacity: 18 },
    { id: 'b3', name: '救生艇 3 号', stationId: 'sB', capacity: 18 },
    { id: 'b4', name: '救生艇 4 号', stationId: 'sB', capacity: 18 },
    { id: 'b5', name: '救生艇 5 号', stationId: 'sC', capacity: 20 },
  ];
  for (const boat of boats) appendEvent(store, sys, 'BOAT_ADD', { boat, ts: Date.now() });

  const cabins: Cabin[] = [
    // 1 甲板 → A 集合点；101/102 为无障碍舱；102 床位 4 但禁住人数 3
    cabin('c101', 101, '1', 2, 2, 'sA', true),
    cabin('c102', 102, '1', 4, 3, 'sA', true),
    cabin('c103', 103, '1', 4, 4, 'sA'),
    cabin('c104', 104, '1', 4, 4, 'sA'),
    cabin('c105', 105, '1', 2, 2, 'sA'),
    cabin('c106', 106, '1', 3, 3, 'sA'),
    cabin('c107', 107, '1', 2, 2, 'sA'),
    cabin('c108', 108, '1', 2, 2, 'sA'),
    // 2 甲板 → B 集合点；201 为无障碍舱
    cabin('c201', 201, '2', 2, 2, 'sB', true),
    cabin('c202', 202, '2', 4, 4, 'sB'),
    cabin('c203', 203, '2', 4, 4, 'sB'),
    cabin('c204', 204, '2', 4, 4, 'sB'),
    cabin('c205', 205, '2', 2, 2, 'sB'),
    cabin('c206', 206, '2', 3, 3, 'sB'),
    cabin('c207', 207, '2', 2, 2, 'sB'),
    cabin('c208', 208, '2', 2, 2, 'sB'),
    // 3 甲板 → C 集合点
    cabin('c301', 301, '3', 2, 2, 'sC'),
    cabin('c302', 302, '3', 2, 2, 'sC'),
    cabin('c303', 303, '3', 2, 2, 'sC'),
    cabin('c304', 304, '3', 2, 2, 'sC'),
  ];
  for (const c of cabins) appendEvent(store, sys, 'CABIN_ADD', { cabin: c, ts: Date.now() });

  const groups: Group[] = [
    { id: 'g1', name: '张家家庭团', voyageId: 'v1' },
    { id: 'g2', name: '摄影小团', voyageId: 'v1' },
    { id: 'g3', name: '陈家亲友团', voyageId: 'v1' },
    { id: 'g5', name: '赵家父子行', voyageId: 'v1' },
    { id: 'g4', name: '釜山观光团', voyageId: 'v2' },
  ];
  for (const group of groups) appendEvent(store, sys, 'GROUP_ADD', { group, ts: Date.now() });

  const mk = (
    id: string,
    name: string,
    age: number,
    voyageId: string,
    extra: Partial<Passenger> = {},
  ): Passenger => ({
    id,
    name,
    age,
    voyageId,
    cabinId: null,
    status: 'booked',
    ...extra,
  });

  const passengers: Passenger[] = [
    // 张家 5 人（含 2 名儿童、1 名无障碍老人）—— 需 101+102 两间，触发团体拆分提示
    mk('p01', '张建国', 45, 'v1', { groupId: 'g1' }),
    mk('p02', '王秀兰', 42, 'v1', { groupId: 'g1' }),
    mk('p03', '张小明', 8, 'v1', { groupId: 'g1' }),
    mk('p04', '张小雨', 6, 'v1', { groupId: 'g1' }),
    mk('p05', '张奶奶', 68, 'v1', { groupId: 'g1', needsAccessible: true }),
    // 摄影小团 3 成人
    mk('p06', '王大山', 35, 'v1', { groupId: 'g2' }),
    mk('p07', '刘洋', 31, 'v1', { groupId: 'g2' }),
    mk('p08', '黄磊', 29, 'v1', { groupId: 'g2' }),
    // 陈家 4 人
    mk('p09', '陈国强', 50, 'v1', { groupId: 'g3' }),
    mk('p10', '陈太太', 48, 'v1', { groupId: 'g3' }),
    mk('p11', '陈思', 17, 'v1', { groupId: 'g3' }),
    mk('p12', '陈小北', 14, 'v1', { groupId: 'g3' }),
    // 赵家父子
    mk('p13', '赵刚', 40, 'v1', { groupId: 'g5' }),
    mk('p14', '赵小宝', 9, 'v1', { groupId: 'g5' }),
    // 散客
    mk('p15', '刘先生', 38, 'v1', { needsAccessible: true }),
    mk('p16', '陈伟', 30, 'v1', { adjacentWithIds: ['p17'] }),
    mk('p17', '林娜', 28, 'v1', { adjacentWithIds: ['p16'] }),
    mk('p18', '钱多多', 55, 'v1'),
    mk('p19', '孙莉', 26, 'v1'),
    mk('p20', '周杰', 33, 'v1'),
    mk('p21', '吴敏', 45, 'v1'),
    mk('p22', '郑浩', 31, 'v1'),
    mk('p23', '冯雪', 27, 'v1'),
    mk('p24', '蒋雯', 36, 'v1'),
    mk('p25', '沈星', 29, 'v1'),
    mk('p26', '韩梅', 52, 'v1'),
    mk('p27', '杨光', 61, 'v1'),
    mk('p28', '杜娟', 34, 'v1'),
    mk('p29', '苏方', 22, 'v1'),
    mk('p30', '范斌', 47, 'v1'),

    // v2 航次（默认不分配，供周转场景演练）
    mk('q01', '周阿美', 30, 'v2', { groupId: 'g4' }),
    mk('q02', '老周', 60, 'v2', { groupId: 'g4' }),
    mk('q03', '老吴', 58, 'v2', { groupId: 'g4' }),
    mk('q04', '吴小童', 12, 'v2', { groupId: 'g4' }),
    mk('q05', '何静', 28, 'v2'),
    mk('q06', '高磊', 33, 'v2'),
    mk('q07', '姚远', 41, 'v2'),
    mk('q08', '梁爽', 25, 'v2'),
    mk('q09', '罗琳', 37, 'v2'),
    mk('q10', '郭涛', 50, 'v2'),
  ];
  for (const passenger of passengers) appendEvent(store, sys, 'PASSENGER_ADD', { passenger, ts: Date.now() });

  if (autoAssignV1) appendEvent(store, sys, 'AUTO_ASSIGN', { voyageId: 'v1', ts: Date.now() });

  void uid;
  return store;
}
