/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 数据库名：gbbrinepond
 * - v1：建立全部表与 pondId+date 复合索引
 * - v2：新增 evapMm 字段并写入升级迁移逻辑，旧记录自动补齐默认值
 * - v3：新增泵房泵位账（泵组 / 泵位时段 / 泵房抄表），走水计划增加泵位归属，
 *        旧计划按池系反推泵组，推不出来的留只读
 * 纯前端应用：不依赖任何后端服务或外部接口。
 */
import Dexie, { type Table } from 'dexie';
import type { Pond } from '../types/pond';
import type { Gate } from '../types/gate';
import type { Observation } from '../types/observation';
import type { Assay } from '../types/assay';
import type { Schedule, ScheduleState } from '../types/schedule';
import type { PumpUnit, PumpSlot, PumpMeter } from '../types/pump';
import { estimateEvapMm } from './brine';
import { nowIso, uuid } from './id';
import { seedDatabase } from './seed';

/** 数据库名 */
export const DB_NAME = 'gbbrinepond';

/** 当前数据结构版本号（每次调整字段结构必须 +1 并补迁移） */
export const DB_SCHEMA_VERSION = 3;

/** 数据行结构修订号 */
export const ROW_REVISION = 3;

class BrinePondDatabase extends Dexie {
  ponds!: Table<Pond, string>;
  gates!: Table<Gate, string>;
  observations!: Table<Observation, string>;
  assays!: Table<Assay, string>;
  schedules!: Table<Schedule, string>;
  pumpUnits!: Table<PumpUnit, string>;
  pumpSlots!: Table<PumpSlot, string>;
  pumpMeters!: Table<PumpMeter, string>;

  constructor() {
    super(DB_NAME);

    // ---------- v1：建立全部表与 pondId+date 复合索引 ----------
    this.version(1).stores({
      ponds: 'id, code, seriesName, stage, status, createdAt',
      gates: 'id, fromPondId, toPondId, state',
      observations: 'id, pondId, date, [pondId+date], densityGcm3',
      assays: 'id, pondId, date, [pondId+date], verdict',
      schedules: 'id, pondId, planDate, state, orderIndex',
    });

    // ---------- v2：新增 evapMm 字段，并为旧记录补齐默认值 ----------
    this.version(2)
      .stores({
        ponds: 'id, code, seriesName, stage, status, createdAt, updatedAt',
        gates: 'id, fromPondId, toPondId, state, openingPct',
        observations: 'id, pondId, date, [pondId+date], densityGcm3, evapMm',
        assays: 'id, pondId, date, [pondId+date], verdict, verdictManual',
        schedules: 'id, pondId, planDate, state, orderIndex',
      })
      .upgrade(async (tx) => {
        // 迁移 1：补齐 revision / createdAt / updatedAt
        const tables = [
          tx.table('ponds'),
          tx.table('gates'),
          tx.table('observations'),
          tx.table('assays'),
          tx.table('schedules'),
        ];
        for (const table of tables) {
          await table.toCollection().modify((row: Record<string, unknown>) => {
            row.revision = ROW_REVISION;
            if (typeof row.createdAt !== 'string') row.createdAt = nowIso();
            if (typeof row.updatedAt !== 'string') row.updatedAt = row.createdAt;
          });
        }
        // 迁移 2：卤水观测新增 evapMm，旧记录按密度/温度/水位/风力经验公式补齐
        await tx.table('observations').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.evapMm === 'number' && Number.isFinite(row.evapMm)) return;
          row.evapMm = estimateEvapMm(
            typeof row.densityGcm3 === 'number' ? row.densityGcm3 : 1.02,
            typeof row.tempC === 'number' ? row.tempC : 25,
            typeof row.levelCm === 'number' ? row.levelCm : 40,
            typeof row.windLevel === 'number' ? row.windLevel : 2,
          );
        });
        // 迁移 3：化验记录补齐人工覆盖标记
        await tx.table('assays').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.verdictManual !== 'boolean') row.verdictManual = false;
        });
        // 迁移 4：走水编排补齐排序序号（按计划日期兜底生成）
        await tx.table('schedules').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.orderIndex !== 'number') {
            const date = typeof row.planDate === 'string' ? row.planDate : '2026-01-01';
            row.orderIndex = Number(date.replace(/-/g, '')) || 1;
          }
        });
      });

    // ---------- v3：泵房泵位账 + 走水计划泵位归属，旧计划按池系反推 ----------
    this.version(DB_SCHEMA_VERSION)
      .stores({
        ponds: 'id, code, seriesName, stage, status, createdAt, updatedAt',
        gates: 'id, fromPondId, toPondId, state, openingPct',
        observations: 'id, pondId, date, [pondId+date], densityGcm3, evapMm',
        assays: 'id, pondId, date, [pondId+date], verdict, verdictManual',
        schedules: 'id, pondId, planDate, state, orderIndex, pumpUnitId, pumpSlotId',
        pumpUnits: 'id, code, seriesName, status',
        pumpSlots: 'id, pumpUnitId, positionCode, date, status',
        pumpMeters: 'id, pondId, date',
      })
      .upgrade(async (tx) => {
        const stamp = nowIso();
        const pondTable = tx.table('ponds');
        const scheduleTable = tx.table('schedules');
        const unitTable = tx.table('pumpUnits');
        const slotTable = tx.table('pumpSlots');

        const ponds = await pondTable.toArray();
        const schedules = await scheduleTable.toArray();
        const units = await unitTable.toArray();
        const slots = await slotTable.toArray();

        // 迁移 5：为每个尚无泵组的池系补建一个在用泵组（按池系反推的落脚点）
        const unitIdBySeries = new Map<string, string>();
        units.forEach((unit: PumpUnit) => {
          if (!unitIdBySeries.has(unit.seriesName)) unitIdBySeries.set(unit.seriesName, unit.id);
        });
        const seriesList = Array.from(new Set(ponds.map((pond: Pond) => pond.seriesName)));
        for (const seriesName of seriesList) {
          if (unitIdBySeries.has(seriesName)) continue;
          const id = uuid('pumpunit');
          await unitTable.put({
            id,
            code: `${seriesName}泵组`,
            seriesName,
            status: '在用',
            note: 'v3 升级时按池系补建',
            createdAt: stamp,
            updatedAt: stamp,
            revision: ROW_REVISION,
          });
          unitIdBySeries.set(seriesName, id);
        }

        // 迁移 6：为泵组在其走水计划日期上补建泵位时段（容量按当日计划量兜底），
        // 让旧计划能按池系反推到泵位；没有走水计划的泵组不补时段。
        const unitDates = new Map<string, Set<string>>();
        schedules.forEach((row: Schedule) => {
          const pond = ponds.find((item: Pond) => item.id === row.pondId);
          const unitId = pond === undefined ? undefined : unitIdBySeries.get(pond.seriesName);
          if (unitId === undefined) return;
          if (!unitDates.has(unitId)) unitDates.set(unitId, new Set());
          unitDates.get(unitId)!.add(row.planDate);
        });
        for (const [unitId, dates] of unitDates) {
          for (const date of dates) {
            const exists = slots.some((slot: PumpSlot) => slot.pumpUnitId === unitId && slot.date === date);
            if (exists) continue;
            const dayVolume = schedules
              .filter((row: Schedule) => {
                const pond = ponds.find((item: Pond) => item.id === row.pondId);
                return pond !== undefined && unitIdBySeries.get(pond.seriesName) === unitId && row.planDate === date;
              })
              .reduce((acc, row) => acc + (typeof row.volumeM3 === 'number' ? row.volumeM3 : 0), 0);
            slots.push({
              id: uuid('pumpslot'),
              pumpUnitId: unitId,
              positionCode: '1#',
              date,
              capacityM3: Math.max(2000, dayVolume + 500),
              status: '在用',
              note: 'v3 升级时按计划日期补建',
              createdAt: stamp,
              updatedAt: stamp,
              revision: ROW_REVISION,
            });
          }
        }
        if (slots.length > 0) await slotTable.bulkPut(slots);

        // 迁移 7：为旧走水计划按池系反推泵组与泵位时段；推不出来的留只读
        for (const row of schedules) {
          if (typeof row.pumpUnitId === 'string' && row.pumpUnitId !== '') continue;
          const pond = ponds.find((item: Pond) => item.id === row.pondId);
          const unitId = pond === undefined ? undefined : unitIdBySeries.get(pond.seriesName);
          if (unitId === undefined) {
            row.pumpReadonly = true;
            continue;
          }
          row.pumpUnitId = unitId;
          row.pumpReadonly = false;
          // 已出卤的计划保持原样（历史归属即可），其余尝试挂到计划日期当天的在用泵位时段
          if (row.state !== '已出卤') {
            const slot = slots.find(
              (item: PumpSlot) => item.pumpUnitId === unitId && item.date === row.planDate && item.status === '在用',
            );
            if (slot !== undefined) row.pumpSlotId = slot.id;
          }
        }
        await scheduleTable.bulkPut(schedules);
      });
  }
}

export const db = new BrinePondDatabase();

/* ------------------------------ 初始化与播种 ------------------------------ */

let initPromise: Promise<void> | null = null;

/**
 * 打开数据库并在首屏自动播种演示数据（幂等：仅当主表为空时播种）。
 * 多次调用共用同一个 Promise，避免并发重复播种。
 */
export function initDatabase(): Promise<void> {
  if (initPromise === null) {
    initPromise = (async (): Promise<void> => {
      await db.open();
      // 首屏自动播种演示数据：仅当主表为空时执行（幂等）
      if ((await db.ponds.count()) === 0) {
        await seedDatabase();
      }
    })();
  }
  return initPromise;
}

/* -------------------------------- 蒸发池 -------------------------------- */

export async function listPonds(): Promise<Pond[]> {
  const rows = await db.ponds.toArray();
  return rows.sort((a, b) => a.seriesName.localeCompare(b.seriesName, 'zh-Hans-CN') || a.code.localeCompare(b.code));
}

export async function putPond(row: Pond): Promise<void> {
  await db.ponds.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION });
}

/** 删除蒸发池，并级联清理相关闸门、观测、化验、走水计划与泵房抄表 */
export async function removePond(id: string): Promise<void> {
  await db.transaction(
    'rw',
    [db.ponds, db.gates, db.observations, db.assays, db.schedules, db.pumpMeters],
    async () => {
      const gates = await db.gates.toArray();
      const related = gates
        .filter((gate) => gate.fromPondId === id || gate.toPondId === id)
        .map((gate) => gate.id);
      if (related.length > 0) await db.gates.bulkDelete(related);
      await db.observations.where('pondId').equals(id).delete();
      await db.assays.where('pondId').equals(id).delete();
      await db.schedules.where('pondId').equals(id).delete();
      await db.pumpMeters.where('pondId').equals(id).delete();
      await db.ponds.delete(id);
    },
  );
}

/* -------------------------------- 闸门 -------------------------------- */

export async function listGates(): Promise<Gate[]> {
  return db.gates.toArray();
}

export async function putGate(row: Gate): Promise<void> {
  await db.gates.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION });
}

/** 就地调整开度：同步推导闸门状态 */
export async function updateGateOpening(id: string, openingPct: number, state: Gate['state']): Promise<void> {
  await db.gates.update(id, { openingPct, state, updatedAt: nowIso() });
}

export async function removeGate(id: string): Promise<void> {
  await db.gates.delete(id);
}

/* ------------------------------ 卤水日观测 ------------------------------ */

export async function listObservations(): Promise<Observation[]> {
  const rows = await db.observations.toArray();
  return rows.sort((a, b) => a.date.localeCompare(b.date));
}

export async function listObservationsByPond(pondId: string): Promise<Observation[]> {
  const rows = await db.observations.where('pondId').equals(pondId).toArray();
  return rows.sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * 写入卤水日观测：同池同日仅保留一条（存在即覆盖原记录）。
 * evapMm 若未显式给出，则按经验公式自动估算。
 */
export async function upsertObservation(row: Observation): Promise<Observation> {
  const evapMm =
    Number.isFinite(row.evapMm) && row.evapMm > 0
      ? row.evapMm
      : estimateEvapMm(row.densityGcm3, row.tempC, row.levelCm, row.windLevel);
  const existing = await db.observations.where('[pondId+date]').equals([row.pondId, row.date]).first();
  const next: Observation = {
    ...row,
    id: existing === undefined ? row.id : existing.id,
    evapMm,
    createdAt: existing === undefined ? row.createdAt : existing.createdAt,
    updatedAt: nowIso(),
    revision: ROW_REVISION,
  };
  await db.observations.put(next);
  return next;
}

export async function removeObservation(id: string): Promise<void> {
  await db.observations.delete(id);
}

/* ------------------------------ 离子组分分析 ------------------------------ */

export async function listAssays(): Promise<Assay[]> {
  const rows = await db.assays.toArray();
  return rows.sort((a, b) => a.date.localeCompare(b.date));
}

export async function listAssaysByPond(pondId: string): Promise<Assay[]> {
  const rows = await db.assays.where('pondId').equals(pondId).toArray();
  return rows.sort((a, b) => a.date.localeCompare(b.date));
}

export async function putAssay(row: Assay): Promise<void> {
  await db.assays.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION });
}

export async function removeAssay(id: string): Promise<void> {
  await db.assays.delete(id);
}

/* ------------------------------ 走水编排 ------------------------------ */

export async function listSchedules(): Promise<Schedule[]> {
  const rows = await db.schedules.toArray();
  return rows.sort((a, b) => a.orderIndex - b.orderIndex || a.planDate.localeCompare(b.planDate));
}

export async function putSchedule(row: Schedule): Promise<void> {
  await db.schedules.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION });
}

export async function removeSchedule(id: string): Promise<void> {
  await db.schedules.delete(id);
}

/** 按给定 id 顺序重写排序序号（拖拽排序后调用） */
export async function reorderSchedules(orderedIds: string[]): Promise<void> {
  await db.transaction('rw', db.schedules, async () => {
    for (let index = 0; index < orderedIds.length; index += 1) {
      await db.schedules.update(orderedIds[index], { orderIndex: index + 1, updatedAt: nowIso() });
    }
  });
}

/**
 * 出卤完成回写：把蒸发池推进到下一阶段，并把最新一次观测的密度对齐到实际密度。
 */
export async function applyDischarge(scheduleId: string, actualDensity: number): Promise<void> {
  await db.transaction('rw', db.ponds, db.schedules, db.observations, async () => {
    const schedule = await db.schedules.get(scheduleId);
    if (!schedule) return;
    await db.schedules.update(scheduleId, { state: '已出卤', updatedAt: nowIso() });
    const pond = await db.ponds.get(schedule.pondId);
    if (!pond) return;
    const nextStage: Pond['stage'] = pond.stage === '钠盐' ? '钾盐' : pond.stage === '钾盐' ? '锂盐' : '锂盐';
    await db.ponds.update(pond.id, { stage: nextStage, updatedAt: nowIso() });
    const list = await db.observations.where('pondId').equals(pond.id).toArray();
    if (list.length === 0) return;
    const latest = list.reduce((acc, item) => (item.date > acc.date ? item : acc));
    const density = actualDensity > 0 ? actualDensity : latest.densityGcm3;
    await db.observations.update(latest.id, {
      densityGcm3: density,
      evapMm: estimateEvapMm(density, latest.tempC, latest.levelCm, latest.windLevel),
      updatedAt: nowIso(),
    });
  });
}

/** 推进走水状态 */
export async function advanceScheduleState(scheduleId: string, next: ScheduleState, actualDensity: number): Promise<void> {
  if (next === '已出卤') {
    await applyDischarge(scheduleId, actualDensity);
    return;
  }
  await db.schedules.update(scheduleId, { state: next, updatedAt: nowIso() });
}

/* ------------------------------ 泵房泵位账 ------------------------------ */

export async function listPumpUnits(): Promise<PumpUnit[]> {
  const rows = await db.pumpUnits.toArray();
  return rows.sort((a, b) => a.seriesName.localeCompare(b.seriesName, 'zh-Hans-CN') || a.code.localeCompare(b.code));
}

export async function putPumpUnit(row: PumpUnit): Promise<void> {
  await db.pumpUnits.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION });
}

/**
 * 停用 / 启用泵组。
 * 停用时靠它排的计划（未出卤）退回待排等调度员重排，已出卤的照旧；
 * 小幅挪动（改编号 / 备注）不打回计划，只有停用才退回。
 */
export async function setPumpUnitStatus(unitId: string, status: PumpUnit['status']): Promise<void> {
  await db.transaction('rw', db.pumpUnits, db.pumpSlots, db.schedules, async () => {
    await db.pumpUnits.update(unitId, { status, updatedAt: nowIso() });
    if (status !== '停用') return;
    const slots = await db.pumpSlots.where('pumpUnitId').equals(unitId).toArray();
    for (const slot of slots) {
      await returnPlansForSlot(slot.id);
    }
  });
}

/** 删除泵组：先把靠它排的计划退回待排，再级联删除其下泵位时段 */
export async function removePumpUnit(unitId: string): Promise<void> {
  await db.transaction('rw', db.pumpUnits, db.pumpSlots, db.schedules, async () => {
    const slots = await db.pumpSlots.where('pumpUnitId').equals(unitId).toArray();
    for (const slot of slots) {
      await returnPlansForSlot(slot.id);
      await db.pumpSlots.delete(slot.id);
    }
    await db.pumpUnits.delete(unitId);
  });
}

export async function listPumpSlots(): Promise<PumpSlot[]> {
  const rows = await db.pumpSlots.toArray();
  return rows.sort((a, b) => a.date.localeCompare(b.date) || a.positionCode.localeCompare(b.positionCode));
}

export async function putPumpSlot(row: PumpSlot): Promise<void> {
  await db.pumpSlots.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION });
}

/**
 * 停用 / 启用泵位时段。
 * 停用时靠它排的计划（未出卤）退回待排等调度员重排，已出卤的照旧；
 * 小幅挪动（改日期 / 容量 / 泵位号）不打回计划，只有停用才退回。
 */
export async function setPumpSlotStatus(slotId: string, status: PumpSlot['status']): Promise<void> {
  await db.transaction('rw', db.pumpSlots, db.schedules, async () => {
    await db.pumpSlots.update(slotId, { status, updatedAt: nowIso() });
    if (status === '停用') await returnPlansForSlot(slotId);
  });
}

/** 删除泵位时段：靠它排的计划退回待排，再删除时段 */
export async function removePumpSlot(slotId: string): Promise<void> {
  await db.transaction('rw', db.pumpSlots, db.schedules, async () => {
    await returnPlansForSlot(slotId);
    await db.pumpSlots.delete(slotId);
  });
}

/** 泵房抄表归泵房录入；调度员在走水页只读，不可改 */
export async function listPumpMeters(): Promise<PumpMeter[]> {
  const rows = await db.pumpMeters.toArray();
  return rows.sort((a, b) => a.date.localeCompare(b.date));
}

export async function putPumpMeter(row: PumpMeter): Promise<void> {
  await db.pumpMeters.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION });
}

export async function removePumpMeter(id: string): Promise<void> {
  await db.pumpMeters.delete(id);
}

/**
 * 把挂接在某泵位时段上的未出卤计划退回待排（清空泵位与差量）。
 * 已出卤的计划保持原样（历史归属不动）。
 */
async function returnPlansForSlot(slotId: string): Promise<void> {
  const schedules = await db.schedules.where('pumpSlotId').equals(slotId).toArray();
  for (const row of schedules) {
    if (row.state === '已出卤') continue;
    await db.schedules.update(row.id, {
      state: '待排',
      pumpSlotId: undefined,
      shortfallM3: 0,
      updatedAt: nowIso(),
    });
  }
}

/* ---------------------------- 整库快照 ---------------------------- */

export interface DatabaseSnapshot {
  name: string;
  schemaVersion: number;
  exportedAt: string;
  ponds: Pond[];
  gates: Gate[];
  observations: Observation[];
  assays: Assay[];
  schedules: Schedule[];
  pumpUnits: PumpUnit[];
  pumpSlots: PumpSlot[];
  pumpMeters: PumpMeter[];
}

export async function exportSnapshot(): Promise<DatabaseSnapshot> {
  const [ponds, gates, observations, assays, schedules, pumpUnits, pumpSlots, pumpMeters] = await Promise.all([
    db.ponds.toArray(),
    db.gates.toArray(),
    db.observations.toArray(),
    db.assays.toArray(),
    db.schedules.toArray(),
    db.pumpUnits.toArray(),
    db.pumpSlots.toArray(),
    db.pumpMeters.toArray(),
  ]);
  return {
    name: DB_NAME,
    schemaVersion: DB_SCHEMA_VERSION,
    exportedAt: nowIso(),
    ponds,
    gates,
    observations,
    assays,
    schedules,
    pumpUnits,
    pumpSlots,
    pumpMeters,
  };
}

export async function importSnapshot(snapshot: DatabaseSnapshot): Promise<void> {
  await db.transaction(
    'rw',
    [db.ponds, db.gates, db.observations, db.assays, db.schedules, db.pumpUnits, db.pumpSlots, db.pumpMeters],
    async () => {
      await Promise.all([
        db.ponds.clear(),
        db.gates.clear(),
        db.observations.clear(),
        db.assays.clear(),
        db.schedules.clear(),
        db.pumpUnits.clear(),
        db.pumpSlots.clear(),
        db.pumpMeters.clear(),
      ]);
      await db.ponds.bulkPut(snapshot.ponds.map((row) => ({ ...row, revision: ROW_REVISION })));
      await db.gates.bulkPut(snapshot.gates.map((row) => ({ ...row, revision: ROW_REVISION })));
      await db.observations.bulkPut(snapshot.observations.map((row) => ({ ...row, revision: ROW_REVISION })));
      await db.assays.bulkPut(snapshot.assays.map((row) => ({ ...row, revision: ROW_REVISION })));
      await db.schedules.bulkPut(snapshot.schedules.map((row) => ({ ...row, revision: ROW_REVISION })));
      await db.pumpUnits.bulkPut((snapshot.pumpUnits ?? []).map((row) => ({ ...row, revision: ROW_REVISION })));
      await db.pumpSlots.bulkPut((snapshot.pumpSlots ?? []).map((row) => ({ ...row, revision: ROW_REVISION })));
      await db.pumpMeters.bulkPut((snapshot.pumpMeters ?? []).map((row) => ({ ...row, revision: ROW_REVISION })));
    },
  );
}

export async function resetDatabase(): Promise<void> {
  await db.transaction(
    'rw',
    [db.ponds, db.gates, db.observations, db.assays, db.schedules, db.pumpUnits, db.pumpSlots, db.pumpMeters],
    async () => {
      await Promise.all([
        db.ponds.clear(),
        db.gates.clear(),
        db.observations.clear(),
        db.assays.clear(),
        db.schedules.clear(),
        db.pumpUnits.clear(),
        db.pumpSlots.clear(),
        db.pumpMeters.clear(),
      ]);
    },
  );
  await seedDatabase();
}

export async function countAll(): Promise<Record<string, number>> {
  const [ponds, gates, observations, assays, schedules, pumpUnits, pumpSlots, pumpMeters] = await Promise.all([
    db.ponds.count(),
    db.gates.count(),
    db.observations.count(),
    db.assays.count(),
    db.schedules.count(),
    db.pumpUnits.count(),
    db.pumpSlots.count(),
    db.pumpMeters.count(),
  ]);
  return { ponds, gates, observations, assays, schedules, pumpUnits, pumpSlots, pumpMeters };
}
