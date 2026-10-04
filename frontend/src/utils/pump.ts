/**
 * 泵位 / 对账纯逻辑（无 Solid、无 Dexie 依赖，便于复用与核对）
 * - 泵位空闲与容量判断（放行前看哪个泵位空着、容量够不够）
 * - 按池排队顺延的差额计算（差多少方写在计划上）
 * - 按池对账：计划量之和 vs 泵房抄表净量，超容差摆出数字等泵房复核
 */
import type { Schedule } from '../types/schedule';
import type { PumpPosition } from '../types/pumpPosition';
import type { PumpSlot } from '../types/pumpSlot';
import type { PumpMeterReading } from '../types/pumpMeterReading';

/** 按池对账容差（m³）：|计划量之和 − 抄表净量| 超过该值即摆出来等泵房复核 */
export const RECONCILE_TOLERANCE_M3 = 50;

/** 对账状态：平（容差内）/ 超差（等泵房复核）/ 缺抄表（泵房还没抄） */
export type ReconcileStatus = '平' | '超差' | '缺抄表';

export interface ReconcileItem {
  pondId: string
  seriesName: string
  /** 已放行计划量之和（待排不计入，还没占用泵位） */
  planVolumeM3: number
  /** 泵房抄表净量之和 */
  netVolumeM3: number
  /** 差额 = 计划 − 抄表（正：抄表偏少；负：抄表偏多） */
  diffM3: number
  toleranceM3: number
  status: ReconcileStatus
  scheduleCount: number
  readingCount: number
}

/** 占用中的时段状态（已完成的历史占用不再挡泵位，出卤完的照旧留底） */
const ACTIVE_SLOT_STATES: ReadonlySet<PumpSlot['state']> = new Set(['已排', '走水中']);

/** 该泵位在某日是否已被占用（同一泵位同一天只放一条） */
export function isPositionBusy(slots: PumpSlot[], positionId: string, date: string): boolean {
  return slots.some((slot) => slot.positionId === positionId && slot.planDate === date && ACTIVE_SLOT_STATES.has(slot.state));
}

export interface AvailablePosition extends PumpPosition {
  /** 用该泵位放行时的容量差额（m³），0 表示容量够 */
  shortfallM3: number
}

/**
 * 放行前查泵位：某日某池系下，空着（当日无占用）且在运行的泵位，
 * 按「容量够的优先、容量大的优先、编号靠前」排序，并标注各自差额。
 */
export function availablePositions(
  positions: PumpPosition[],
  slots: PumpSlot[],
  seriesName: string,
  date: string,
  volumeM3: number,
  seriesNameOfPosition: (positionId: string) => string,
): AvailablePosition[] {
  return positions
    .filter((position) => position.status === '运行')
    .filter((position) => seriesNameOfPosition(position.id) === seriesName)
    .filter((position) => !isPositionBusy(slots, position.id, date))
    .map((position) => ({ ...position, shortfallM3: Math.max(0, Math.round((volumeM3 - position.capacityM3) * 10) / 10) }))
    .sort((a, b) => {
      const fit = Number(a.shortfallM3 === 0) - Number(b.shortfallM3 === 0);
      if (fit !== 0) return -fit;
      if (b.capacityM3 !== a.capacityM3) return b.capacityM3 - a.capacityM3;
      return a.code.localeCompare(b.code, 'zh-Hans-CN');
    });
}

/**
 * 容量够不够：空着的泵位里只要有一个容量 ≥ 计划量即可放行；
 * 否则按池排队顺延，差额取空泵位中容量缺口的最小值（差多少方）。
 */
export function releaseCapacity(positions: AvailablePosition[]): { canRelease: boolean; minShortfallM3: number } {
  if (positions.length === 0) return { canRelease: false, minShortfallM3: 0 };
  const enough = positions.some((position) => position.shortfallM3 === 0);
  const minShortfall = positions.reduce((min, item) => Math.min(min, item.shortfallM3), positions[0].shortfallM3);
  return { canRelease: enough, minShortfallM3: Math.round(minShortfall * 10) / 10 };
}

/**
 * 按池对账：把已放行计划（非待排）与泵房抄表按池汇总比对。
 * 有计划无抄表 → 缺抄表；两边都有且差额超容差 → 超差（等泵房复核，数字原样摆出）。
 */
export function reconcileByPond(
  schedules: Schedule[],
  readings: PumpMeterReading[],
  seriesNameOf: (pondId: string) => string,
  toleranceM3 = RECONCILE_TOLERANCE_M3,
): ReconcileItem[] {
  const planByPond = new Map<string, { volume: number; count: number }>();
  schedules
    .filter((row) => row.state !== '待排')
    .forEach((row) => {
      const acc = planByPond.get(row.pondId) ?? { volume: 0, count: 0 };
      acc.volume += row.volumeM3;
      acc.count += 1;
      planByPond.set(row.pondId, acc);
    });
  const meterByPond = new Map<string, { net: number; count: number }>();
  readings.forEach((row) => {
    const acc = meterByPond.get(row.pondId) ?? { net: 0, count: 0 };
    acc.net += row.netVolumeM3;
    acc.count += 1;
    meterByPond.set(row.pondId, acc);
  });

  const pondIds = Array.from(new Set([...planByPond.keys(), ...meterByPond.keys()]));
  return pondIds
    .map((pondId) => {
      const plan = planByPond.get(pondId) ?? { volume: 0, count: 0 };
      const meter = meterByPond.get(pondId) ?? { net: 0, count: 0 };
      const diff = Math.round((plan.volume - meter.net) * 10) / 10;
      let status: ReconcileStatus;
      if (plan.count > 0 && meter.count === 0) status = '缺抄表';
      else if (Math.abs(diff) > toleranceM3) status = '超差';
      else status = '平';
      return {
        pondId,
        seriesName: readings.find((row) => row.pondId === pondId)?.seriesName ?? seriesNameOf(pondId),
        planVolumeM3: Math.round(plan.volume * 10) / 10,
        netVolumeM3: Math.round(meter.net * 10) / 10,
        diffM3: diff,
        toleranceM3,
        status,
        scheduleCount: plan.count,
        readingCount: meter.count,
      };
    })
    .sort((a, b) => {
      const weight = (s: ReconcileStatus): number => (s === '超差' ? 0 : s === '缺抄表' ? 1 : 2);
      return weight(a.status) - weight(b.status) || a.seriesName.localeCompare(b.seriesName, 'zh-Hans-CN');
    });
}

/**
 * v3 升级反推：为旧走水计划按池系补泵位归属。
 * 贪心：每条计划在同池系运行泵位中，优先当日空闲且容量够的，其次当日空闲的；
 * 当日同池系泵位全被占（如同池同日多条）则推不出来，留给只读。
 * 返回 scheduleId → { positionId, slotIndex }（推不出的不在表中）。
 */
export function inferSlotBindings(
  schedules: Schedule[],
  positions: PumpPosition[],
  seriesNameOfPond: (pondId: string) => string,
  seriesNameOfPosition: (positionId: string) => string,
): Map<string, { positionId: string; slotIndex: number }> {
  const occupied = new Set<string>();
  const slotCount = new Map<string, number>();
  const result = new Map<string, { positionId: string; slotIndex: number }>();
  const ordered = [...schedules]
    .filter((row) => row.state !== '待排')
    .sort((a, b) => a.planDate.localeCompare(b.planDate) || a.orderIndex - b.orderIndex);

  for (const schedule of ordered) {
    const series = seriesNameOfPond(schedule.pondId);
    const candidates = positions
      .filter((position) => position.status === '运行' && seriesNameOfPosition(position.id) === series)
      .filter((position) => !occupied.has(`${schedule.planDate}|${position.id}`))
      .sort((a, b) => {
        const fitA = a.capacityM3 >= schedule.volumeM3 ? 1 : 0;
        const fitB = b.capacityM3 >= schedule.volumeM3 ? 1 : 0;
        if (fitA !== fitB) return fitB - fitA;
        if (b.capacityM3 !== a.capacityM3) return b.capacityM3 - a.capacityM3;
        return a.code.localeCompare(b.code, 'zh-Hans-CN');
      });
    const chosen = candidates[0];
    if (chosen === undefined) continue;
    const key = `${schedule.planDate}|${chosen.id}`;
    occupied.add(key);
    const nextIndex = (slotCount.get(key) ?? 0) + 1;
    slotCount.set(key, nextIndex);
    result.set(schedule.id, { positionId: chosen.id, slotIndex: nextIndex });
  }
  return result;
}
