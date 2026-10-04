/**
 * 泵房泵位账业务逻辑
 * - 泵位时段占用容量与剩余容量
 * - 计划挂接泵位的差量（顺延方量）
 * - 按池对账：计划量之和 vs 泵房抄表净量
 * 全部为纯函数，供 pumpStore / scheduleStore / 页面复用。
 */
import type { PumpMeter, PumpSlot } from '../types/pump';
import type { Schedule, ScheduleState } from '../types/schedule';

/** 计入泵位占用容量的计划状态：已排 / 走水中为已占用，待排为排队不占容量 */
export const SLOT_COMMITTED_STATES: readonly ScheduleState[] = ['已排', '走水中'];

/** 对账容差（m³）：计划量与抄表净量差值超过该值即列出等泵房复核 */
export const RECONCILE_TOLERANCE_M3 = 100;

/** 泵位时段已占用容量（m³）：挂接在该时段且已放行（已排 / 走水中）的计划量之和 */
export function slotCommittedM3(slot: Pick<PumpSlot, 'id'>, schedules: Schedule[]): number {
  return schedules
    .filter((row) => row.pumpSlotId === slot.id && SLOT_COMMITTED_STATES.includes(row.state))
    .reduce((acc, row) => acc + row.volumeM3, 0);
}

/** 泵位时段剩余可用容量（m³） */
export function slotAvailableM3(slot: PumpSlot, schedules: Schedule[]): number {
  return Math.max(0, slot.capacityM3 - slotCommittedM3(slot, schedules));
}

/**
 * 泵位时段对某条计划的可用容量（m³）。
 * 改派 / 放行时把计划自身已占用的部分扣除，避免同一条计划重复计入。
 */
export function slotAvailableForM3(slot: PumpSlot, schedules: Schedule[], excludeScheduleId?: string): number {
  const committed = schedules
    .filter(
      (row) =>
        row.pumpSlotId === slot.id &&
        row.id !== excludeScheduleId &&
        SLOT_COMMITTED_STATES.includes(row.state),
    )
    .reduce((acc, row) => acc + row.volumeM3, 0);
  return Math.max(0, slot.capacityM3 - committed);
}

/** 计划挂接泵位后的差量（m³）：容量不足时为正，表示顺延的方量 */
export function planShortfallM3(volumeM3: number, slot: PumpSlot, schedules: Schedule[], excludeScheduleId?: string): number {
  return Math.max(0, volumeM3 - slotAvailableForM3(slot, schedules, excludeScheduleId));
}

/** 挂接泵位的判定结果 */
export interface SlotAssignment {
  /** 挂接后的走水状态：容量够则放行（待排→已排），不够则退回待排顺延 */
  state: ScheduleState;
  /** 顺延差量（m³），容量够为 0 */
  shortfallM3: number;
}

/**
 * 把计划挂接到泵位时段：
 * - 容量够：待排 → 已排（放行）；已排 / 走水中改派后仍容量够则保持原状态；
 * - 容量不够：退回待排顺延，差量写入 shortfallM3。
 */
export function assignToSlot(plan: Schedule, slot: PumpSlot, schedules: Schedule[]): SlotAssignment {
  const available = slotAvailableForM3(slot, schedules, plan.id);
  const shortfallM3 = Math.max(0, plan.volumeM3 - available);
  if (shortfallM3 > 0) {
    return { state: '待排', shortfallM3 };
  }
  return { state: plan.state === '待排' ? '已排' : plan.state, shortfallM3: 0 };
}

/** 按池对账结果 */
export interface PondReconcile {
  pondId: string;
  /** 计划量之和（已排 / 走水中 / 已出卤，不含待排） */
  plannedM3: number;
  /** 泵房抄表净量之和 */
  meterM3: number;
  /** 计划量 − 抄表净量 */
  diffM3: number;
  /** 是否超过容差（超过则列出等泵房复核） */
  overTolerance: boolean;
}

/** 按池对账：计划量之和跟泵房抄表净量差过容差就摆出来 */
export function reconcilePond(pondId: string, schedules: Schedule[], meters: PumpMeter[]): PondReconcile {
  const plannedM3 = schedules
    .filter((row) => row.pondId === pondId && row.state !== '待排')
    .reduce((acc, row) => acc + row.volumeM3, 0);
  const meterM3 = meters.filter((row) => row.pondId === pondId).reduce((acc, row) => acc + row.netVolumeM3, 0);
  const diffM3 = Math.round((plannedM3 - meterM3) * 10) / 10;
  return {
    pondId,
    plannedM3,
    meterM3,
    diffM3,
    overTolerance: Math.abs(diffM3) > RECONCILE_TOLERANCE_M3,
  };
}

/** 批量按池对账 */
export function reconcileAll(pondIds: string[], schedules: Schedule[], meters: PumpMeter[]): PondReconcile[] {
  return pondIds.map((pondId) => reconcilePond(pondId, schedules, meters));
}
