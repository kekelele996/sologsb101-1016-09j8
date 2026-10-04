/**
 * 泵位（PumpPosition）
 * 泵房账：泵组下的一个具体泵位。调度员放行前先看哪个泵位空着、容量够不够。
 * 调度室只读泵位账，停泵 / 改派泵位由泵房在 /pumps 操作。
 */

/** 泵位运行状态：运行 / 停用（停泵后置为停用） */
export type PumpPositionStatus = '运行' | '停用';

export const PUMP_POSITION_STATUS_OPTIONS: PumpPositionStatus[] = ['运行', '停用'];

export interface PumpPosition {
  id: string
  /** 所属泵组 */
  groupId: string
  /** 泵位编号，如 北-1#-2 号位 */
  code: string
  /** 单泵额定容量 / 单次走水上限量（m³），放行时据此判断容量够不够 */
  capacityM3: number
  /** 运行状态；停用的泵位不能挂计划 */
  status: PumpPositionStatus
  /** 泵房备注（检修 / 备用等） */
  note: string
  createdAt: string
  updatedAt: string
  revision: number
}

/** 新建 / 编辑泵位的表单草稿 */
export interface PumpPositionDraft {
  groupId: string
  code: string
  capacityM3: number
  status: PumpPositionStatus
  note: string
}
