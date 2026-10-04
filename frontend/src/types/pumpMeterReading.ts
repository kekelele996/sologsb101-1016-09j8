/**
 * 泵房抄表（PumpMeterReading）
 * 泵房账：按「池 + 日期」抄录起止表底，净量 = 止底 − 起底。
 * 调度室只能看，不能改抄表；按池对账时计划量之和与抄表净量比容差。
 */

export interface PumpMeterReading {
  id: string
  /** 抄表日期 YYYY-MM-DD（一般取走水当日） */
  date: string
  /** 送水目标蒸发池（按池对账的池维度） */
  pondId: string
  /** 冗余：池系，按池系汇总时不依赖池台账在线 */
  seriesName: string
  /** 实际供水泵位 */
  positionId: string
  /** 起表读数 */
  startReading: number
  /** 止表读数 */
  endReading: number
  /** 抄表净量（m³），由泵房写入；调度员不可改 */
  netVolumeM3: number
  /** 抄表员 */
  reader: string
  /** 泵房复核备注；对账超差、等泵房复核时写在这里 */
  note: string
  createdAt: string
  updatedAt: string
  revision: number
}

/** 新建 / 编辑抄表的表单草稿（泵房使用） */
export interface PumpMeterReadingDraft {
  date: string
  pondId: string
  seriesName: string
  positionId: string
  startReading: number
  endReading: number
  netVolumeM3: number
  reader: string
  note: string
}
