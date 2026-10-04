/**
 * 走水编排（Schedule）
 * 按日期排序的走水与出卤计划，可通过拖拽调整先后顺序。
 */

/** 走水状态：待排 / 已排 / 走水中 / 已出卤 */
export type ScheduleState = '待排' | '已排' | '走水中' | '已出卤'

export const SCHEDULE_STATE_OPTIONS: ScheduleState[] = ['待排', '已排', '走水中', '已出卤']

/** 状态推进顺序 */
export const SCHEDULE_STATE_FLOW: ScheduleState[] = ['待排', '已排', '走水中', '已出卤']

export interface Schedule {
  id: string
  /** 所属蒸发池 */
  pondId: string
  /** 计划走水日期 YYYY-MM-DD */
  planDate: string
  /** 目标密度（g/cm³） */
  targetDensity: number
  /** 计划量（m³） */
  volumeM3: number
  /** 调度员 */
  operator: string
  /** 走水状态 */
  state: ScheduleState
  /** 手工拖拽后的排序序号，越小越先走水 */
  orderIndex: number
  /** 挂接的泵组（泵房泵位账）——v3 起 */
  pumpUnitId?: string
  /** 挂接的泵位时段——v3 起；放行时选定，停泵 / 改派后清空 */
  pumpSlotId?: string
  /** 容量不足时的顺延差量（m³）：计划量超出泵位可用容量的部分——v3 起 */
  shortfallM3?: number
  /** 只读标记：旧数据升级按池系反推不到泵组的计划留只读，不可挂接泵位——v3 起 */
  pumpReadonly?: boolean
  createdAt: string
  updatedAt: string
  revision: number
}

/** 新建 / 编辑走水编排的表单草稿 */
export interface ScheduleDraft {
  pondId: string
  planDate: string
  targetDensity: number
  volumeM3: number
  operator: string
  state: ScheduleState
  orderIndex: number
  pumpUnitId?: string
  pumpSlotId?: string
  shortfallM3?: number
  pumpReadonly?: boolean
}
