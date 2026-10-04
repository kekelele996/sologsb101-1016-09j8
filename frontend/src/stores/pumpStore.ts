/**
 * 泵房账状态管理（Solid 原生能力）
 * 泵组、泵位、泵位时段与抄表净量都归泵房；调度室（/schedules）只读这些数据。
 * 通过 Dexie liveQuery 订阅四张泵房表，与 pondStore / scheduleStore 跨表联动。
 */
import { createMemo, createRoot } from 'solid-js';
import { createStore } from 'solid-js/store';
import { liveQuery } from 'dexie';
import type { PumpGroup, PumpGroupDraft } from '../types/pumpGroup';
import type { PumpPosition, PumpPositionDraft } from '../types/pumpPosition';
import type { PumpSlot } from '../types/pumpSlot';
import type { PumpMeterReading, PumpMeterReadingDraft } from '../types/pumpMeterReading';
import {
  activatePumpPosition,
  db,
  deactivatePumpPosition,
  initDatabase,
  putPumpGroup,
  putPumpMeterReading,
  putPumpPosition,
  removePumpGroup,
  removePumpMeterReading,
  removePumpPosition,
} from '../utils/db';
import { nowIso, uuid } from '../utils/id';

interface PumpState {
  groups: PumpGroup[];
  positions: PumpPosition[];
  slots: PumpSlot[];
  readings: PumpMeterReading[];
  loading: boolean;
  error: string;
  lastMessage: string;
}

function createPumpStore() {
  const [state, setState] = createStore<PumpState>({
    groups: [],
    positions: [],
    slots: [],
    readings: [],
    loading: true,
    error: '',
    lastMessage: '',
  });

  void initDatabase();

  liveQuery(async () => {
    const [groups, positions, slots, readings] = await Promise.all([
      db.pumpGroups.toArray(),
      db.pumpPositions.toArray(),
      db.pumpSlots.toArray(),
      db.pumpMeterReadings.toArray(),
    ]);
    return { groups, positions, slots, readings };
  }).subscribe({
    next: ({ groups, positions, slots, readings }) => {
      setState({
        groups: [...groups].sort((a, b) => a.seriesName.localeCompare(b.seriesName, 'zh-Hans-CN') || a.code.localeCompare(b.code)),
        positions: [...positions].sort((a, b) => a.code.localeCompare(b.code, 'zh-Hans-CN')),
        slots: [...slots].sort((a, b) => a.planDate.localeCompare(b.planDate) || a.slotIndex - b.slotIndex),
        readings: [...readings].sort((a, b) => a.date.localeCompare(b.date) || b.updatedAt.localeCompare(a.updatedAt)),
        loading: false,
        error: '',
      });
    },
    error: (err: unknown) => {
      setState({ loading: false, error: err instanceof Error ? err.message : '读取泵房账失败' });
    },
  });

  function setMessage(message: string): void {
    setState('lastMessage', message);
  }

  const groupById = createMemo(() => new Map(state.groups.map((group) => [group.id, group])));
  const positionById = createMemo(() => new Map(state.positions.map((position) => [position.id, position])));

  function groupOf(positionId: string): PumpGroup | null {
    const position = positionById().get(positionId);
    return position === undefined ? null : (groupById().get(position.groupId) ?? null);
  }

  /** 泵位归属池系（经泵组反查） */
  function seriesOfPosition(positionId: string): string {
    return groupOf(positionId)?.seriesName ?? '';
  }

  function positionsOfGroup(groupId: string): PumpPosition[] {
    return state.positions.filter((position) => position.groupId === groupId);
  }

  function positionsOfSeries(seriesName: string): PumpPosition[] {
    const groupIds = new Set(state.groups.filter((group) => group.seriesName === seriesName).map((group) => group.id));
    return state.positions.filter((position) => groupIds.has(position.groupId));
  }

  /* -------------------------------- 泵组 -------------------------------- */

  async function createGroup(draft: PumpGroupDraft): Promise<PumpGroup> {
    const stamp = nowIso();
    const row: PumpGroup = {
      id: uuid('group'),
      code: draft.code.trim() || '未编号泵组',
      name: draft.name.trim() || draft.code.trim() || '未命名泵组',
      seriesName: draft.seriesName.trim() || '未分配池系',
      master: draft.master.trim(),
      status: draft.status,
      createdAt: stamp,
      updatedAt: stamp,
      revision: 3,
    };
    await putPumpGroup(row);
    setState('lastMessage', `已新建泵组：${row.name}`);
    return row;
  }

  async function updateGroup(groupId: string, draft: PumpGroupDraft): Promise<void> {
    const existing = state.groups.find((row) => row.id === groupId);
    if (existing === undefined) return;
    await putPumpGroup({
      ...existing,
      code: draft.code.trim() || existing.code,
      name: draft.name.trim() || existing.name,
      seriesName: draft.seriesName.trim() || existing.seriesName,
      master: draft.master.trim(),
      status: draft.status,
    });
    setState('lastMessage', '泵组已更新');
  }

  async function deleteGroup(groupId: string): Promise<void> {
    await removePumpGroup(groupId);
    setState('lastMessage', '泵组及其泵位已删除，活动计划已退回待排');
  }

  /* -------------------------------- 泵位 -------------------------------- */

  async function createPosition(draft: PumpPositionDraft): Promise<PumpPosition> {
    const stamp = nowIso();
    const row: PumpPosition = {
      id: uuid('pos'),
      groupId: draft.groupId,
      code: draft.code.trim() || '未编号泵位',
      capacityM3: draft.capacityM3,
      status: draft.status,
      note: draft.note.trim(),
      createdAt: stamp,
      updatedAt: stamp,
      revision: 3,
    };
    await putPumpPosition(row);
    setState('lastMessage', `已新建泵位：${row.code}，容量 ${row.capacityM3} m³`);
    return row;
  }

  async function updatePosition(positionId: string, draft: PumpPositionDraft): Promise<void> {
    const existing = state.positions.find((row) => row.id === positionId);
    if (existing === undefined) return;
    await putPumpPosition({
      ...existing,
      groupId: draft.groupId,
      code: draft.code.trim() || existing.code,
      capacityM3: draft.capacityM3,
      status: draft.status,
      note: draft.note.trim(),
    });
    setState('lastMessage', '泵位已更新');
  }

  /** 泵房停泵：活动计划退回待排等调度员重排（已出卤的照旧） */
  async function stopPosition(positionId: string): Promise<void> {
    await deactivatePumpPosition(positionId);
    setState('lastMessage', '泵位已停用，靠它排的活动计划已退回待排，等调度员重排');
  }

  async function startPosition(positionId: string): Promise<void> {
    await activatePumpPosition(positionId);
    setState('lastMessage', '泵位已恢复运行');
  }

  async function deletePosition(positionId: string): Promise<void> {
    await removePumpPosition(positionId);
    setState('lastMessage', '泵位已删除，活动计划已退回待排');
  }

  /* -------------------------------- 抄表 -------------------------------- */

  async function createReading(draft: PumpMeterReadingDraft): Promise<PumpMeterReading> {
    const stamp = nowIso();
    const net = Math.round((draft.endReading - draft.startReading) * 10) / 10;
    const row: PumpMeterReading = {
      id: uuid('reading'),
      date: draft.date,
      pondId: draft.pondId,
      seriesName: draft.seriesName,
      positionId: draft.positionId,
      startReading: draft.startReading,
      endReading: draft.endReading,
      netVolumeM3: net,
      reader: draft.reader.trim(),
      note: draft.note.trim(),
      createdAt: stamp,
      updatedAt: stamp,
      revision: 3,
    };
    await putPumpMeterReading(row);
    setState('lastMessage', `已抄表：净量 ${net} m³`);
    return row;
  }

  async function updateReading(readingId: string, draft: PumpMeterReadingDraft): Promise<void> {
    const existing = state.readings.find((row) => row.id === readingId);
    if (existing === undefined) return;
    await putPumpMeterReading({
      ...existing,
      date: draft.date,
      pondId: draft.pondId,
      seriesName: draft.seriesName,
      positionId: draft.positionId,
      startReading: draft.startReading,
      endReading: draft.endReading,
      netVolumeM3: Math.round((draft.endReading - draft.startReading) * 10) / 10,
      reader: draft.reader.trim(),
      note: draft.note.trim(),
    });
    setState('lastMessage', '抄表已更新（调度室无权修改）');
  }

  async function deleteReading(readingId: string): Promise<void> {
    await removePumpMeterReading(readingId);
    setState('lastMessage', '抄表记录已删除');
  }

  return {
    state,
    setMessage,
    groupById,
    positionById,
    groupOf,
    seriesOfPosition,
    positionsOfGroup,
    positionsOfSeries,
    createGroup,
    updateGroup,
    deleteGroup,
    createPosition,
    updatePosition,
    stopPosition,
    startPosition,
    deletePosition,
    createReading,
    updateReading,
    deleteReading,
  };
}

const store = createRoot(createPumpStore);

export function usePumpStore() {
  return store;
}
