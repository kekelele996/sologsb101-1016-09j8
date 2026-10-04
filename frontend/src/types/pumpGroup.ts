/**
 * 泵组（PumpGroup）
 * 泵房台账的顶层：一组泵归属于一个池系，泵位在泵组下编排。
 * 「泵组、泵位、泵位时段与抄表净量都归泵房」，调度室只读。
 */

/** 泵组运行状态：运行 / 停用 */
export type PumpGroupStatus = '运行' | '停用';

export const PUMP_GROUP_STATUS_OPTIONS: PumpGroupStatus[] = ['运行', '停用'];

export interface PumpGroup {
  id: string
  /** 泵组编号，如 北-1# */
  code: string
  /** 泵组名称 */
  name: string
  /** 归属池系（与 Pond.seriesName 对应，决定它能为哪条池排队） */
  seriesName: string
  /** 泵房值班长 / 负责人 */
  master: string
  /** 运行状态 */
  status: PumpGroupStatus
  createdAt: string
  updatedAt: string
  revision: number
}

/** 新建 / 编辑泵组的表单草稿 */
export interface PumpGroupDraft {
  code: string
  name: string
  seriesName: string
  master: string
  status: PumpGroupStatus
}
