/**
 * 走水编排状态管理（Solid 原生能力）
 * 用 createStore 维护走水顺序与状态推进；出卤完成后回写池阶段与实际密度。
 * 泵位账归泵房（pumpStore / db 的泵组·泵位·时段·抄表）：调度员放行前先看空泵位，
 * 容量不够按池排队顺延并把差额写在计划上；泵房停泵 / 改派泵位会把计划退回待排。
 */
import { createRoot, createSignal } from 'solid-js';
import { createStore } from 'solid-js/store';
import { liveQuery } from 'dexie';
import type { Schedule, ScheduleDraft, ScheduleState } from '../types/schedule';
import { SCHEDULE_STATE_FLOW } from '../types/schedule';
import {
  advanceScheduleState,
  db,
  deferSchedule,
  initDatabase,
  putSchedule,
  reassignScheduleSlot,
  releaseScheduleToPosition,
  removeSchedule,
  reorderSchedules,
  returnScheduleToQueue,
} from '../utils/db';
import { availablePositions, releaseCapacity } from '../utils/pump';
import { nowIso, uuid } from '../utils/id';
import { usePondStore } from './pondStore';
import { usePumpStore } from './pumpStore';

/** 走水编排筛选条件 */
export interface ScheduleFilters {
  keyword: string;
  seriesName: string | 'all';
  state: ScheduleState | 'all';
}

const EMPTY_FILTERS: ScheduleFilters = { keyword: '', seriesName: 'all', state: 'all' };

interface ScheduleState_ {
  rows: Schedule[];
  loading: boolean;
  error: string;
  lastMessage: string;
}

function createScheduleStore() {
  const [state, setState] = createStore<ScheduleState_>({
    rows: [],
    loading: true,
    error: '',
    lastMessage: '',
  });
  const [filters, setFilters] = createSignal<ScheduleFilters>({ ...EMPTY_FILTERS });
  const [draggingId, setDraggingId] = createSignal<string | null>(null);

  // 同 observationStore：建库必须放在 querier 外，否则 liveQuery 采集不到可观测性集合，
  // 数据库变更后不会重查 —— 走水计划条数与拖拽后的顺序都不会原地刷新。
  void initDatabase();

  liveQuery(async () => {
    return db.schedules.toArray();
  }).subscribe({
    next: (list) => {
      setState('rows', [...list].sort((a, b) => a.orderIndex - b.orderIndex || a.planDate.localeCompare(b.planDate)));
      setState('loading', false);
      setState('error', '');
    },
    error: (err: unknown) => {
      setState({ loading: false, error: err instanceof Error ? err.message : '读取走水编排失败' });
    },
  });

  function patchFilters(patch: Partial<ScheduleFilters>): void {
    setFilters({ ...filters(), ...patch });
  }

  function resetFilters(): void {
    setFilters({ ...EMPTY_FILTERS });
  }

  function setMessage(message: string): void {
    setState('lastMessage', message);
  }

  async function createSchedule(draft: ScheduleDraft): Promise<Schedule> {
    const stamp = nowIso();
    const row: Schedule = {
      id: uuid('schedule'),
      pondId: draft.pondId,
      planDate: draft.planDate,
      targetDensity: draft.targetDensity,
      volumeM3: draft.volumeM3,
      operator: draft.operator.trim(),
      // 新建一律先进「待排」池，泵位由放行流程绑定，表单不直接填泵位
      state: '待排',
      orderIndex: draft.orderIndex,
      pumpSlotId: null,
      shortfallM3: 0,
      slotInferred: false,
      legacyReadonly: false,
      createdAt: stamp,
      updatedAt: stamp,
      revision: 3,
    };
    await putSchedule(row);
    setState('lastMessage', `已新建走水计划：${row.planDate}，进入待排队列`);
    return row;
  }

  async function updateSchedule(scheduleId: string, draft: ScheduleDraft): Promise<void> {
    const existing = state.rows.find((row) => row.id === scheduleId);
    if (existing === undefined || existing.legacyReadonly) return;
    const stamp = nowIso();
    await putSchedule({
      ...existing,
      pondId: draft.pondId,
      planDate: draft.planDate,
      targetDensity: draft.targetDensity,
      volumeM3: draft.volumeM3,
      operator: draft.operator.trim(),
      // 泵位归属状态由放行 / 退回 / 泵房联动决定，编辑表单不改它
      state: existing.state,
      orderIndex: draft.orderIndex,
      updatedAt: stamp,
    });
    // 改计划量时同步占用时段的放水量（泵位小幅挪动之外的数据一致性）
    if (existing.pumpSlotId !== null) {
      await db.pumpSlots.update(existing.pumpSlotId, {
        volumeM3: draft.volumeM3,
        planDate: draft.planDate,
        updatedAt: stamp,
      });
    }
    setState('lastMessage', '走水计划已更新');
  }

  async function deleteSchedule(scheduleId: string): Promise<void> {
    await removeSchedule(scheduleId);
    setState('lastMessage', '走水计划已删除');
  }

  /** 放行前查泵位：该计划当日、同池系中空着的运行泵位（带容量差额） */
  function releaseOptions(schedule: Schedule) {
    const pondStore = usePondStore();
    const pumpStore = usePumpStore();
    const pond = pondStore.state.ponds.find((row) => row.id === schedule.pondId);
    const seriesName = pond?.seriesName ?? '';
    return availablePositions(
      pumpStore.state.positions,
      pumpStore.state.slots,
      seriesName,
      schedule.planDate,
      schedule.volumeM3,
      (positionId) => pumpStore.seriesOfPosition(positionId),
    );
  }

  /** 放行：调度员选定空泵位，登记占用，计划 待排 → 已排 */
  async function release(scheduleId: string, positionId: string): Promise<void> {
    const existing = state.rows.find((row) => row.id === scheduleId);
    if (existing === undefined) return;
    const options = releaseOptions(existing);
    const chosen = options.find((option) => option.id === positionId);
    if (chosen === undefined) {
      setState('lastMessage', '该泵位当日已被占用或已停用，请换一个空泵位');
      return;
    }
    if (chosen.shortfallM3 > 0) {
      // 容量不足的初始放行一律走顺延；强行换小泵属于「小幅挪动」，不在放行入口做
      setState('lastMessage', `该泵位容量不足（缺口 ${chosen.shortfallM3} m³），请按池排队顺延`);
      return;
    }
    const pondStore = usePondStore();
    const seriesName = pondStore.state.ponds.find((row) => row.id === existing.pondId)?.seriesName ?? '';
    await releaseScheduleToPosition(scheduleId, chosen.id, seriesName, chosen.shortfallM3);
    setState(
      'lastMessage',
      chosen.shortfallM3 > 0
        ? `已放行到 ${chosen.code}，容量缺口 ${chosen.shortfallM3} m³ 已记在计划上`
        : `已放行到 ${chosen.code}，计划进入「已排」`,
    );
  }

  /** 容量不够：按池排队顺延，差额写在计划上，计划留在待排 */
  async function defer(scheduleId: string): Promise<void> {
    const existing = state.rows.find((row) => row.id === scheduleId);
    if (existing === undefined) return;
    const options = releaseOptions(existing);
    const { canRelease, minShortfallM3 } = releaseCapacity(options);
    if (canRelease) {
      setState('lastMessage', '现有空泵位容量足够，无需顺延，请直接选泵位放行');
      return;
    }
    await deferSchedule(scheduleId, options.length === 0 ? 0 : minShortfallM3);
    setState(
      'lastMessage',
      options.length === 0
        ? '当日该池系没有空泵位，已按池排队顺延（等泵房腾泵位）'
        : `已按池排队顺延，容量缺口 ${minShortfallM3} m³ 已写在计划上`,
    );
  }

  /** 泵房改派泵位 / 调度确认小幅挪动：换泵位不打回计划 */
  async function reassign(scheduleId: string, newPositionId: string): Promise<void> {
    const existing = state.rows.find((row) => row.id === scheduleId);
    if (existing === undefined || existing.pumpSlotId === null) return;
    const pumpStore = usePumpStore();
    const position = pumpStore.state.positions.find((row) => row.id === newPositionId);
    if (position === undefined || position.status !== '运行') {
      setState('lastMessage', '目标泵位不存在或已停用，不能改派');
      return;
    }
    await reassignScheduleSlot(scheduleId, newPositionId, Math.max(0, existing.volumeM3 - position.capacityM3));
    setState('lastMessage', `已小幅挪到 ${position.code}，计划不打回`);
  }

  /** 退回待排：解除泵位归属，等调度员重排（反推归属 / 泵房停泵后的处理入口） */
  async function returnToQueue(scheduleId: string): Promise<void> {
    await returnScheduleToQueue(scheduleId);
    setState('lastMessage', '已退回待排队列，请重新选空泵位放行');
  }

  async function advance(scheduleId: string): Promise<ScheduleState | null> {
    const existing = state.rows.find((row) => row.id === scheduleId);
    if (existing === undefined || existing.legacyReadonly) return null;
    // 待排必须先走「选泵位放行」，不能直接推进到已排（放行前先看哪个泵位空着）
    if (existing.state === '待排') {
      setState('lastMessage', '待排计划请先选空泵位放行；容量不够可按池排队顺延');
      return null;
    }
    const index = SCHEDULE_STATE_FLOW.indexOf(existing.state);
    if (index < 0 || index >= SCHEDULE_STATE_FLOW.length - 1) return null;
    const next = SCHEDULE_STATE_FLOW[index + 1];
    const pondStore = usePondStore();
    const stat = pondStore.statOf(existing.pondId);
    const actualDensity = stat.currentDensity > 0 ? stat.currentDensity : existing.targetDensity;
    await advanceScheduleState(scheduleId, next, actualDensity);
    await pondStore.refreshCounts();
    setState(
      'lastMessage',
      next === '已出卤'
        ? `已出卤：池阶段已推进，实际密度回写为 ${actualDensity} g/cm³，泵位占用留底`
        : `状态已推进为「${next}」`,
    );
    return next;
  }

  /** 拖拽排序：把 fromId 移动到 toId 之前 */
  async function moveBefore(fromId: string, toId: string): Promise<void> {
    if (fromId === toId) return;
    const list = [...state.rows].sort((a, b) => a.orderIndex - b.orderIndex);
    const fromIndex = list.findIndex((row) => row.id === fromId);
    const toIndex = list.findIndex((row) => row.id === toId);
    if (fromIndex < 0 || toIndex < 0) return;
    const [moved] = list.splice(fromIndex, 1);
    list.splice(toIndex, 0, moved);
    await reorderSchedules(list.map((row) => row.id));
    setState('lastMessage', `已调整走水顺序：${moved.planDate} 移动到第 ${toIndex + 1} 位`);
  }

  async function moveToIndex(id: string, targetIndex: number): Promise<void> {
    const list = [...state.rows].sort((a, b) => a.orderIndex - b.orderIndex);
    const fromIndex = list.findIndex((row) => row.id === id);
    if (fromIndex < 0) return;
    const [moved] = list.splice(fromIndex, 1);
    const index = Math.max(0, Math.min(list.length, targetIndex));
    list.splice(index, 0, moved);
    await reorderSchedules(list.map((row) => row.id));
    setState('lastMessage', `已把 ${moved.planDate} 调整到第 ${index + 1} 位`);
  }

  return {
    state,
    filters,
    patchFilters,
    resetFilters,
    draggingId,
    setDraggingId,
    setMessage,
    createSchedule,
    updateSchedule,
    deleteSchedule,
    releaseOptions,
    release,
    defer,
    reassign,
    returnToQueue,
    advance,
    moveBefore,
    moveToIndex,
  };
}

const store = createRoot(createScheduleStore);

export function useScheduleStore() {
  return store;
}
