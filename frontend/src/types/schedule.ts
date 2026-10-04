/**
 * 走水编排（Schedule）
 * 按日期排序的走水与出卤计划，可通过拖拽调整先后顺序。
 * 调度室只管「池 + 目标密度」；泵位归属（pumpSlotId）由放行 / 泵房改派维护，
 * 调度员不能直接改泵房抄表。
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
  /**
   * 泵位时段归属：放行后指向 pumpSlots 一条占用记录；待排 / 被泵房退回时为 null。
   * 调度员只能经「放行 / 改派」改它，不能在表单里直接填写。
   */
  pumpSlotId: string | null
  /** 放行时泵位容量不够的差额（m³），0 表示容量够；差额直接写在计划上 */
  shortfallM3: number
  /** 泵位归属是 v3 升级时按池系反推补上的（只读归属，改动须走退回重排） */
  slotInferred: boolean
  /** 旧数据推不出泵位归属：整条计划留只读，等泵房补泵位后由调度员处理 */
  legacyReadonly: boolean
  createdAt: string
  updatedAt: string
  revision: number
}

/** 新建 / 编辑走水编排的表单草稿（不含泵位归属，泵位走放行 / 改派流程） */
export interface ScheduleDraft {
  pondId: string
  planDate: string
  targetDensity: number
  volumeM3: number
  operator: string
  state: ScheduleState
  orderIndex: number
}
