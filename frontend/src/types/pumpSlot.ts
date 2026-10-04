/**
 * 泵位时段（PumpSlot）
 * 泵房占用账：某个泵位在某个日期 / 时段被一条走水计划占用。
 * 「调度员放行前先看哪个泵位空着」—— 查询同一日期同一泵位是否已有占用即知空闲。
 * 泵房停泵或改派泵位时，靠该泵位排的计划（占用记录）退回「待排」等调度员重排；
 * 已出卤计划的历史占用照旧保留。
 */

/** 占用状态：已排（计划占用） / 已确认（走水中） / 已完成（已出卤，历史照旧） */
export type PumpSlotState = '已排' | '走水中' | '已完成';

export const PUMP_SLOT_STATE_OPTIONS: PumpSlotState[] = ['已排', '走水中', '已完成'];

export interface PumpSlot {
  id: string
  /** 占用的泵位 */
  positionId: string
  /** 冗余字段：泵位所属池系，便于按池对账与按池系排队，不依赖泵位在线 */
  seriesName: string
  /** 占用日期（同计划 planDate，泵位空闲按「同一日期」判定） */
  planDate: string
  /** 槽次：同一泵位同一天可排多个时段，越小越早 */
  slotIndex: number
  /** 该时段放水量（m³），取计划量，受泵位容量约束 */
  volumeM3: number
  /** 占用对应的走水计划（泵房停泵 / 改派时据此把计划退回待排） */
  scheduleId: string
  /** 占用状态随走水计划同步：已排 → 走水中 → 已完成 */
  state: PumpSlotState
  createdAt: string
  updatedAt: string
  revision: number
}

/** 泵房改派泵位 / 新增占用的草稿（无计划时也可登记泵房自用占用，本系统暂不开放） */
export interface PumpSlotDraft {
  positionId: string
  seriesName: string
  planDate: string
  slotIndex: number
  volumeM3: number
  state: PumpSlotState
}
