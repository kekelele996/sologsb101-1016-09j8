/**
 * 泵房泵位账状态管理（Solid 原生能力）
 * 用 createStore 维护泵组、泵位时段与泵房抄表；通过 Dexie liveQuery 订阅全量数据。
 * 停泵 / 改派的「退回待排」逻辑在 utils/db.ts 事务内完成，本 store 只做数据订阅与 CRUD。
 */
import { createMemo, createRoot, createSignal } from 'solid-js';
import { createStore } from 'solid-js/store';
import { liveQuery } from 'dexie';
import type { PumpMeter, PumpSlot, PumpUnit, PumpUnitStatus, PumpSlotStatus } from '../types/pump';
import {
  db,
  initDatabase,
  putPumpMeter,
  putPumpSlot,
  putPumpUnit,
  removePumpMeter,
  removePumpSlot,
  removePumpUnit,
  setPumpSlotStatus,
  setPumpUnitStatus,
} from '../utils/db';
import { nowIso, uuid } from '../utils/id';

interface PumpState {
  units: PumpUnit[];
  slots: PumpSlot[];
  meters: PumpMeter[];
  loading: boolean;
  error: string;
  lastMessage: string;
}

function createPumpStore() {
  const [state, setState] = createStore<PumpState>({
    units: [],
    slots: [],
    meters: [],
    loading: true,
    error: '',
    lastMessage: '',
  });
  const [revision, setRevision] = createSignal(0);

  // 建库必须放在 liveQuery 外（与 pondStore / scheduleStore 一致），否则采集不到可观测性集合。
  void initDatabase();

  liveQuery(async () => {
    const [units, slots, meters] = await Promise.all([
      db.pumpUnits.toArray(),
      db.pumpSlots.toArray(),
      db.pumpMeters.toArray(),
    ]);
    return { units, slots, meters };
  }).subscribe({
    next: ({ units, slots, meters }) => {
      setState({
        units: [...units].sort((a, b) => a.seriesName.localeCompare(b.seriesName, 'zh-Hans-CN') || a.code.localeCompare(b.code)),
        slots: [...slots].sort((a, b) => a.date.localeCompare(b.date) || a.positionCode.localeCompare(b.positionCode)),
        meters: [...meters].sort((a, b) => b.date.localeCompare(a.date)),
        loading: false,
        error: '',
      });
    },
    error: (err: unknown) => {
      setState({ loading: false, error: err instanceof Error ? err.message : '读取泵房泵位账失败' });
    },
  });

  function setMessage(message: string): void {
    setState('lastMessage', message);
  }

  /* ------------------------------ 派生查询 ------------------------------ */

  const unitById = createMemo<Record<string, PumpUnit>>(() => {
    const result: Record<string, PumpUnit> = {};
    state.units.forEach((unit) => {
      result[unit.id] = unit;
    });
    return result;
  });

  const slotById = createMemo<Record<string, PumpSlot>>(() => {
    const result: Record<string, PumpSlot> = {};
    state.slots.forEach((slot) => {
      result[slot.id] = slot;
    });
    return result;
  });

  function slotsOfUnit(unitId: string): PumpSlot[] {
    return state.slots.filter((slot) => slot.pumpUnitId === unitId);
  }

  /** 某池系下在用的泵组（按池系反推泵组时取第一个） */
  function unitsOfSeries(seriesName: string): PumpUnit[] {
    return state.units.filter((unit) => unit.seriesName === seriesName);
  }

  /** 某池系下在用的泵组（优先在用，否则取第一个） */
  function activeUnitOfSeries(seriesName: string): PumpUnit | undefined {
    const list = unitsOfSeries(seriesName);
    return list.find((unit) => unit.status === '在用') ?? list[0];
  }

  /** 某池系下所有在用泵位时段（放行时选泵位用），按日期排序 */
  function activeSlotsOfSeries(seriesName: string): PumpSlot[] {
    const unitIds = new Set(unitsOfSeries(seriesName).map((unit) => unit.id));
    return state.slots.filter((slot) => unitIds.has(slot.pumpUnitId) && slot.status === '在用');
  }

  /* ------------------------------ 泵组 CRUD ------------------------------ */

  async function createUnit(draft: { code: string; seriesName: string; status: PumpUnitStatus; note: string }): Promise<PumpUnit> {
    const stamp = nowIso();
    const row: PumpUnit = {
      id: uuid('pumpunit'),
      code: draft.code.trim() || '未命名泵组',
      seriesName: draft.seriesName.trim() || '未分配池系',
      status: draft.status,
      note: draft.note.trim(),
      createdAt: stamp,
      updatedAt: stamp,
      revision: 3,
    };
    await putPumpUnit(row);
    setRevision(revision() + 1);
    setState('lastMessage', `已新建泵组：${row.code}`);
    return row;
  }

  async function updateUnit(unitId: string, draft: { code: string; seriesName: string; status: PumpUnitStatus; note: string }): Promise<void> {
    const existing = state.units.find((unit) => unit.id === unitId);
    if (existing === undefined) return;
    await putPumpUnit({
      ...existing,
      code: draft.code.trim() || existing.code,
      seriesName: draft.seriesName.trim() || existing.seriesName,
      status: draft.status,
      note: draft.note.trim(),
    });
    setRevision(revision() + 1);
    setState('lastMessage', '泵组已更新');
  }

  async function setUnitStatus(unitId: string, status: PumpUnitStatus): Promise<void> {
    await setPumpUnitStatus(unitId, status);
    setRevision(revision() + 1);
    setState('lastMessage', status === '停用' ? '泵组已停用，靠它排的计划已退回待排' : '泵组已启用');
  }

  async function deleteUnit(unitId: string): Promise<void> {
    await removePumpUnit(unitId);
    setRevision(revision() + 1);
    setState('lastMessage', '泵组已删除，靠它排的计划已退回待排');
  }

  /* ------------------------------ 泵位时段 CRUD ------------------------------ */

  async function createSlot(draft: {
    pumpUnitId: string;
    positionCode: string;
    date: string;
    capacityM3: number;
    status: PumpSlotStatus;
    note: string;
  }): Promise<PumpSlot> {
    const stamp = nowIso();
    const row: PumpSlot = {
      id: uuid('pumpslot'),
      pumpUnitId: draft.pumpUnitId,
      positionCode: draft.positionCode.trim() || '1#',
      date: draft.date,
      capacityM3: draft.capacityM3,
      status: draft.status,
      note: draft.note.trim(),
      createdAt: stamp,
      updatedAt: stamp,
      revision: 3,
    };
    await putPumpSlot(row);
    setRevision(revision() + 1);
    setState('lastMessage', `已新建泵位时段：${row.date} ${row.positionCode}`);
    return row;
  }

  async function updateSlot(
    slotId: string,
    draft: { pumpUnitId: string; positionCode: string; date: string; capacityM3: number; status: PumpSlotStatus; note: string },
  ): Promise<void> {
    const existing = state.slots.find((slot) => slot.id === slotId);
    if (existing === undefined) return;
    await putPumpSlot({
      ...existing,
      pumpUnitId: draft.pumpUnitId,
      positionCode: draft.positionCode.trim() || existing.positionCode,
      date: draft.date,
      capacityM3: draft.capacityM3,
      status: draft.status,
      note: draft.note.trim(),
    });
    setRevision(revision() + 1);
    setState('lastMessage', '泵位时段已更新');
  }

  async function setSlotStatus(slotId: string, status: PumpSlotStatus): Promise<void> {
    await setPumpSlotStatus(slotId, status);
    setRevision(revision() + 1);
    setState('lastMessage', status === '停用' ? '泵位时段已停用，靠它排的计划已退回待排' : '泵位时段已启用');
  }

  async function deleteSlot(slotId: string): Promise<void> {
    await removePumpSlot(slotId);
    setRevision(revision() + 1);
    setState('lastMessage', '泵位时段已删除，靠它排的计划已退回待排');
  }

  /* ------------------------------ 泵房抄表 CRUD ------------------------------ */

  async function createMeter(draft: { pondId: string; date: string; netVolumeM3: number; note: string }): Promise<PumpMeter> {
    const stamp = nowIso();
    const row: PumpMeter = {
      id: uuid('meter'),
      pondId: draft.pondId,
      date: draft.date,
      netVolumeM3: draft.netVolumeM3,
      note: draft.note.trim(),
      createdAt: stamp,
      updatedAt: stamp,
      revision: 3,
    };
    await putPumpMeter(row);
    setRevision(revision() + 1);
    setState('lastMessage', `已抄录泵房净量：${row.date} ${row.netVolumeM3} m³`);
    return row;
  }

  async function updateMeter(
    meterId: string,
    draft: { pondId: string; date: string; netVolumeM3: number; note: string },
  ): Promise<void> {
    const existing = state.meters.find((meter) => meter.id === meterId);
    if (existing === undefined) return;
    await putPumpMeter({
      ...existing,
      pondId: draft.pondId,
      date: draft.date,
      netVolumeM3: draft.netVolumeM3,
      note: draft.note.trim(),
    });
    setRevision(revision() + 1);
    setState('lastMessage', '泵房抄表已更新');
  }

  async function deleteMeter(meterId: string): Promise<void> {
    await removePumpMeter(meterId);
    setRevision(revision() + 1);
    setState('lastMessage', '泵房抄表已删除');
  }

  return {
    state,
    revision,
    setMessage,
    unitById,
    slotById,
    slotsOfUnit,
    unitsOfSeries,
    activeUnitOfSeries,
    activeSlotsOfSeries,
    createUnit,
    updateUnit,
    setUnitStatus,
    deleteUnit,
    createSlot,
    updateSlot,
    setSlotStatus,
    deleteSlot,
    createMeter,
    updateMeter,
    deleteMeter,
  };
}

const store = createRoot(createPumpStore);

export function usePumpStore() {
  return store;
}
