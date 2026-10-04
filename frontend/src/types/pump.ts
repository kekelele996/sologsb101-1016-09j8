/**
 * 泵房泵位账（Pump）
 * 泵组、泵位时段与泵房抄表净量都归泵房管理；走水计划通过泵位时段挂接到泵组。
 * 调度员在走水编排页只能读泵位与抄表，放行时选择空泵位；抄表净量由泵房录入，调度员不可改。
 */

/** 泵组状态：在用 / 停用 */
export type PumpUnitStatus = '在用' | '停用'

export const PUMP_UNIT_STATUS_OPTIONS: PumpUnitStatus[] = ['在用', '停用']

/** 泵位时段状态：在用 / 停用 */
export type PumpSlotStatus = '在用' | '停用'

export const PUMP_SLOT_STATUS_OPTIONS: PumpSlotStatus[] = ['在用', '停用']

/** 泵组：服务于一个池系的一组泵位 */
export interface PumpUnit {
  id: string
  /** 泵组编号 */
  code: string
  /** 服务池系 */
  seriesName: string
  /** 运行状态 */
  status: PumpUnitStatus
  /** 备注 */
  note: string
  createdAt: string
  updatedAt: string
  revision: number
}

/** 泵位时段：泵组内一个泵位在某日期的可用时段与容量 */
export interface PumpSlot {
  id: string
  /** 所属泵组 */
  pumpUnitId: string
  /** 泵位号（如 1#、2#） */
  positionCode: string
  /** 时段日期 YYYY-MM-DD */
  date: string
  /** 容量（m³） */
  capacityM3: number
  /** 运行状态 */
  status: PumpSlotStatus
  /** 备注 */
  note: string
  createdAt: string
  updatedAt: string
  revision: number
}

/** 泵房抄表：按池、按日期记录的实际走水净量（归泵房录入，调度员只读） */
export interface PumpMeter {
  id: string
  /** 所属蒸发池 */
  pondId: string
  /** 抄表日期 YYYY-MM-DD */
  date: string
  /** 抄表净量（m³） */
  netVolumeM3: number
  /** 备注 */
  note: string
  createdAt: string
  updatedAt: string
  revision: number
}

/** 新建 / 编辑泵组的表单草稿 */
export interface PumpUnitDraft {
  code: string
  seriesName: string
  status: PumpUnitStatus
  note: string
}

/** 新建 / 编辑泵位时段的表单草稿 */
export interface PumpSlotDraft {
  pumpUnitId: string
  positionCode: string
  date: string
  capacityM3: number
  status: PumpSlotStatus
  note: string
}

/** 新建 / 编辑泵房抄表的表单草稿 */
export interface PumpMeterDraft {
  pondId: string
  date: string
  netVolumeM3: number
  note: string
}
