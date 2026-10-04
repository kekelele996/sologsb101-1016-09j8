/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 数据库名：gbbrinepond
 * - v1：建立全部表与 pondId+date 复合索引
 * - v2：新增 evapMm 字段并写入升级迁移逻辑，旧记录自动补齐默认值
 * - v3：接入泵房账（泵组 / 泵位 / 泵位时段 / 抄表净量）；走水计划新增泵位归属，
 *       升级时按池系反推补归属，推不出来的留只读。
 * 纯前端应用：不依赖任何后端服务或外部接口。
 */
import Dexie, { type Table } from 'dexie';
import type { Pond } from '../types/pond';
import type { Gate } from '../types/gate';
import type { Observation } from '../types/observation';
import type { Assay } from '../types/assay';
import type { Schedule } from '../types/schedule';
import type { PumpGroup } from '../types/pumpGroup';
import type { PumpPosition } from '../types/pumpPosition';
import type { PumpSlot } from '../types/pumpSlot';
import type { PumpMeterReading } from '../types/pumpMeterReading';
import { estimateEvapMm } from './brine';
import { inferSlotBindings } from './pump';
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
  pumpGroups!: Table<PumpGroup, string>;
  pumpPositions!: Table<PumpPosition, string>;
  pumpSlots!: Table<PumpSlot, string>;
  pumpMeterReadings!: Table<PumpMeterReading, string>;

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

    // ---------- v3：泵房账接入（泵组 / 泵位 / 泵位时段 / 抄表），计划补泵位归属 ----------
    this.version(DB_SCHEMA_VERSION)
      .stores({
        ponds: 'id, code, seriesName, stage, status, createdAt, updatedAt',
        gates: 'id, fromPondId, toPondId, state, openingPct',
        observations: 'id, pondId, date, [pondId+date], densityGcm3, evapMm',
        assays: 'id, pondId, date, [pondId+date], verdict, verdictManual',
        schedules: 'id, pondId, planDate, state, orderIndex, pumpSlotId',
        pumpGroups: 'id, code, seriesName, status, createdAt, updatedAt',
        pumpPositions: 'id, groupId, code, status, capacityM3, createdAt, updatedAt',
        pumpSlots: 'id, positionId, planDate, state, scheduleId, [positionId+planDate]',
        pumpMeterReadings: 'id, date, pondId, positionId, [pondId+date]',
      })
      .upgrade(async (tx) => {
        const stamp = nowIso();

        // 迁移 1：按池系补泵房账——每个池系一个泵组、两个泵位（一大一小）
        const pondRows = (await tx.table('ponds').toArray()) as Pond[];
        const seriesList = Array.from(new Set(pondRows.map((row) => row.seriesName)));
        const positions: PumpPosition[] = [];
        const groupOfPosition = new Map<string, string>();
        for (const series of seriesList) {
          const groupId = `group-${series}`;
          await tx.table('pumpGroups').put({
            id: groupId,
            code: `${series.slice(0, 1)}泵1#`,
            name: `${series}泵房一组`,
            seriesName: series,
            master: '泵房',
            status: '运行',
            createdAt: stamp,
            updatedAt: stamp,
            revision: ROW_REVISION,
          } satisfies PumpGroup);
          const specs = [
            { suffix: '1', capacity: 1500 },
            { suffix: '2', capacity: 900 },
          ];
          specs.forEach((spec) => {
            const positionId = `pos-${series}-${spec.suffix}`;
            positions.push({
              id: positionId,
              groupId,
              code: `${series.slice(0, 1)}-${spec.suffix}号位`,
              capacityM3: spec.capacity,
              status: '运行',
              note: '升级时按池系补建',
              createdAt: stamp,
              updatedAt: stamp,
              revision: ROW_REVISION,
            });
            groupOfPosition.set(positionId, groupId);
          });
        }
        await tx.table('pumpPositions').bulkPut(positions);

        // 迁移 2：走水计划按池系反推泵位归属
        const scheduleRows = (await tx.table('schedules').toArray()) as Schedule[];
        const seriesOfPond = new Map(pondRows.map((row) => [row.id, row.seriesName]));
        const seriesOfGroup = new Map(seriesList.map((series) => [`group-${series}`, series]));
        const inferred = inferSlotBindings(
          scheduleRows,
          positions,
          (pondId) => seriesOfPond.get(pondId) ?? '',
          (positionId) => seriesOfGroup.get(groupOfPosition.get(positionId) ?? '') ?? '',
        );

        const newSlots: PumpSlot[] = [];
        await tx.table('schedules').toCollection().modify((row: Schedule & Record<string, unknown>) => {
          if (typeof row.shortfallM3 !== 'number') row.shortfallM3 = 0;
          if (typeof row.slotInferred !== 'boolean') row.slotInferred = false;
          if (typeof row.legacyReadonly !== 'boolean') row.legacyReadonly = false;
          if (row.pumpSlotId !== null && typeof row.pumpSlotId === 'string') return;
          row.pumpSlotId = null;
          if (row.state === '待排') return;
          const binding = inferred.get(String(row.id));
          if (binding === undefined) {
            // 推不出来的旧计划：泵位归属留空、整条只读，等泵房补泵位后调度员处理
            row.legacyReadonly = true;
            return;
          }
          const position = positions.find((item) => item.id === binding.positionId);
          if (position === undefined) {
            row.legacyReadonly = true;
            return;
          }
          const slotId = `slot-up-${String(row.id)}`;
          row.pumpSlotId = slotId;
          row.slotInferred = true;
          const volume = typeof row.volumeM3 === 'number' ? row.volumeM3 : 0;
          row.shortfallM3 = Math.max(0, Math.round((volume - position.capacityM3) * 10) / 10);
          newSlots.push({
            id: slotId,
            positionId: position.id,
            seriesName: seriesOfPond.get(String(row.pondId)) ?? '',
            planDate: typeof row.planDate === 'string' ? row.planDate : '',
            slotIndex: binding.slotIndex,
            volumeM3: volume,
            state: row.state === '已出卤' ? '已完成' : (row.state as '已排' | '走水中'),
            scheduleId: String(row.id),
            createdAt: stamp,
            updatedAt: stamp,
            revision: ROW_REVISION,
          });
        });
        if (newSlots.length > 0) await tx.table('pumpSlots').bulkPut(newSlots);
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

/** 删除蒸发池，并级联清理相关闸门、观测、化验、走水计划及其泵位占用 / 抄表 */
export async function removePond(id: string): Promise<void> {
  await db.transaction(
    'rw',
    [db.ponds, db.gates, db.observations, db.assays, db.schedules, db.pumpSlots, db.pumpMeterReadings],
    async () => {
      const gates = await db.gates.toArray();
      const related = gates.filter((gate) => gate.fromPondId === id || gate.toPondId === id).map((gate) => gate.id);
      if (related.length > 0) await db.gates.bulkDelete(related);
      await db.observations.where('pondId').equals(id).delete();
      await db.assays.where('pondId').equals(id).delete();
      const pondSchedules = await db.schedules.where('pondId').equals(id).toArray();
      const slotIds = pondSchedules.map((row) => row.pumpSlotId).filter((slotId): slotId is string => slotId !== null);
      if (slotIds.length > 0) await db.pumpSlots.bulkDelete(slotIds);
      await db.schedules.where('pondId').equals(id).delete();
      await db.pumpMeterReadings.where('pondId').equals(id).delete();
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
  await db.transaction('rw', db.schedules, db.pumpSlots, async () => {
    const existing = await db.schedules.get(id);
    if (existing !== undefined && existing.pumpSlotId !== null) {
      await db.pumpSlots.delete(existing.pumpSlotId);
    }
    await db.schedules.delete(id);
  });
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
 * 放行：调度员选定空泵位后，登记泵位时段占用并把计划推进为「已排」。
 * 差额（容量不够但仍强行登记的情形）直接写在计划上。
 */
export async function releaseScheduleToPosition(
  scheduleId: string,
  positionId: string,
  seriesName: string,
  shortfallM3: number,
): Promise<void> {
  await db.transaction('rw', db.schedules, db.pumpSlots, async () => {
    const schedule = await db.schedules.get(scheduleId);
    if (!schedule || schedule.pumpSlotId !== null) return;
    const stamp = nowIso();
    const sameDay = await db.pumpSlots.where('[positionId+planDate]').equals([positionId, schedule.planDate]).toArray();
    const slot: PumpSlot = {
      id: uuid('slot'),
      positionId,
      seriesName,
      planDate: schedule.planDate,
      slotIndex: sameDay.length + 1,
      volumeM3: schedule.volumeM3,
      state: '已排',
      scheduleId: schedule.id,
      createdAt: stamp,
      updatedAt: stamp,
      revision: ROW_REVISION,
    };
    await db.pumpSlots.put(slot);
    await db.schedules.update(scheduleId, {
      state: '已排',
      pumpSlotId: slot.id,
      shortfallM3: Math.max(0, Math.round(shortfallM3 * 10) / 10),
      slotInferred: false,
      legacyReadonly: false,
      updatedAt: stamp,
    });
  });
}

/** 容量不够：按池排队顺延，差额写在计划上，计划留在「待排」等调度员重排 */
export async function deferSchedule(scheduleId: string, shortfallM3: number): Promise<void> {
  await db.schedules.update(scheduleId, {
    state: '待排',
    shortfallM3: Math.max(0, Math.round(shortfallM3 * 10) / 10),
    updatedAt: nowIso(),
  });
}

/** 泵位小幅挪动：只换占用记录指向的泵位，不打回计划（状态 / 排序不变） */
export async function reassignScheduleSlot(
  scheduleId: string,
  newPositionId: string,
  shortfallM3: number,
): Promise<void> {
  await db.transaction('rw', db.schedules, db.pumpSlots, async () => {
    const schedule = await db.schedules.get(scheduleId);
    if (!schedule || schedule.pumpSlotId === null) return;
    const stamp = nowIso();
    const sameDay = await db.pumpSlots.where('[positionId+planDate]').equals([newPositionId, schedule.planDate]).toArray();
    await db.pumpSlots.update(schedule.pumpSlotId, {
      positionId: newPositionId,
      slotIndex: sameDay.length + 1,
      updatedAt: stamp,
    });
    await db.schedules.update(scheduleId, {
      shortfallM3: Math.max(0, Math.round(shortfallM3 * 10) / 10),
      slotInferred: false,
      updatedAt: stamp,
    });
  });
}

/** 调度员把反推 / 退回的计划退回待排重排：解除泵位归属（删除活动占用） */
export async function returnScheduleToQueue(scheduleId: string): Promise<void> {
  await db.transaction('rw', db.schedules, db.pumpSlots, async () => {
    const schedule = await db.schedules.get(scheduleId);
    if (!schedule || schedule.pumpSlotId === null) return;
    const slotId: string = schedule.pumpSlotId;
    const slot = await db.pumpSlots.get(slotId);
    if (slot !== undefined && slot.state !== '已完成') await db.pumpSlots.delete(slotId);
    await db.schedules.update(scheduleId, {
      state: '待排',
      pumpSlotId: null,
      shortfallM3: 0,
      slotInferred: false,
      legacyReadonly: false,
      updatedAt: nowIso(),
    });
  });
}

/**
 * 出卤完成回写：把蒸发池推进到下一阶段，并把最新一次观测的密度对齐到实际密度。
 */
export async function applyDischarge(scheduleId: string, actualDensity: number): Promise<void> {
  await db.transaction('rw', db.ponds, db.schedules, db.observations, db.pumpSlots, async () => {
    const schedule = await db.schedules.get(scheduleId);
    if (!schedule) return;
    await db.schedules.update(scheduleId, { state: '已出卤', updatedAt: nowIso() });
    // 泵位占用随出卤完成落为「已完成」，历史占用照旧保留
    if (schedule.pumpSlotId !== null) {
      await db.pumpSlots.update(schedule.pumpSlotId, { state: '已完成', updatedAt: nowIso() });
    }
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

/** 推进走水状态；泵位时段占用状态随计划同步 */
export async function advanceScheduleState(scheduleId: string, next: Schedule['state'], actualDensity: number): Promise<void> {
  if (next === '已出卤') {
    await applyDischarge(scheduleId, actualDensity);
    return;
  }
  await db.transaction('rw', db.schedules, db.pumpSlots, async () => {
    const schedule = await db.schedules.get(scheduleId);
    if (!schedule) return;
    const stamp = nowIso();
    await db.schedules.update(scheduleId, { state: next, updatedAt: stamp });
    if (schedule.pumpSlotId !== null && next === '走水中') {
      await db.pumpSlots.update(schedule.pumpSlotId, { state: '走水中', updatedAt: stamp });
    }
  });
}

/* -------------------------------- 泵房账 -------------------------------- */

export async function listPumpGroups(): Promise<PumpGroup[]> {
  return db.pumpGroups.toArray();
}

export async function putPumpGroup(row: PumpGroup): Promise<void> {
  await db.pumpGroups.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION });
}

/** 删除泵组：组内泵位一并删除，泵位上的活动计划退回待排（已完成占用照旧） */
export async function removePumpGroup(id: string): Promise<void> {
  await db.transaction(
    'rw',
    db.pumpGroups,
    db.pumpPositions,
    db.pumpSlots,
    db.schedules,
    async () => {
      const positions = await db.pumpPositions.where('groupId').equals(id).toArray();
      for (const position of positions) {
        await deactivatePositionTx(position.id, true);
      }
      await db.pumpPositions.where('groupId').equals(id).delete();
      await db.pumpGroups.delete(id);
    },
  );
}

export async function listPumpPositions(): Promise<PumpPosition[]> {
  return db.pumpPositions.toArray();
}

export async function putPumpPosition(row: PumpPosition): Promise<void> {
  await db.pumpPositions.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION });
}

async function deactivatePositionTx(positionId: string, deleting: boolean): Promise<void> {
  const activeSlots = await db.pumpSlots
    .where('positionId')
    .equals(positionId)
    .toArray();
  for (const slot of activeSlots) {
    if (slot.state === '已完成') continue; // 出卤完的照旧，不打回
    await db.schedules.update(slot.scheduleId, {
      state: '待排',
      pumpSlotId: null,
      shortfallM3: 0,
      slotInferred: false,
      updatedAt: nowIso(),
    });
    await db.pumpSlots.delete(slot.id);
  }
  if (!deleting) await db.pumpPositions.update(positionId, { status: '停用', updatedAt: nowIso() });
}

/** 泵房停泵：该泵位上靠它排的活动计划全部退回「待排」等调度员重排，已完成的照旧 */
export async function deactivatePumpPosition(positionId: string): Promise<void> {
  await db.transaction('rw', db.pumpPositions, db.pumpSlots, db.schedules, async () => {
    await deactivatePositionTx(positionId, false);
  });
}

/** 泵房重新启用泵位（不影响已退回的计划，等调度员重排放行） */
export async function activatePumpPosition(positionId: string): Promise<void> {
  await db.pumpPositions.update(positionId, { status: '运行', updatedAt: nowIso() });
}

export async function removePumpPosition(id: string): Promise<void> {
  await db.transaction('rw', db.pumpPositions, db.pumpSlots, db.schedules, async () => {
    await deactivatePositionTx(id, true);
    await db.pumpPositions.delete(id);
  });
}

export async function listPumpSlots(): Promise<PumpSlot[]> {
  return db.pumpSlots.toArray();
}

export async function listPumpMeterReadings(): Promise<PumpMeterReading[]> {
  const rows = await db.pumpMeterReadings.toArray();
  return rows.sort((a, b) => a.date.localeCompare(b.date) || b.updatedAt.localeCompare(a.updatedAt));
}

/** 抄表写入：净量由止底−起底兜底重算；该表只有泵房角色（/pumps）能写 */
export async function putPumpMeterReading(row: PumpMeterReading): Promise<void> {
  const net = Math.round((row.endReading - row.startReading) * 10) / 10;
  await db.pumpMeterReadings.put({
    ...row,
    netVolumeM3: row.netVolumeM3 > 0 ? row.netVolumeM3 : net,
    updatedAt: nowIso(),
    revision: ROW_REVISION,
  });
}

export async function removePumpMeterReading(id: string): Promise<void> {
  await db.pumpMeterReadings.delete(id);
}

/* ---------------------------- 整库快照 ---------------------------- */

export interface DatabaseSnapshot {
  name: string
  schemaVersion: number
  exportedAt: string
  ponds: Pond[]
  gates: Gate[]
  observations: Observation[]
  assays: Assay[]
  schedules: Schedule[]
  pumpGroups: PumpGroup[]
  pumpPositions: PumpPosition[]
  pumpSlots: PumpSlot[]
  pumpMeterReadings: PumpMeterReading[]
}

/** 兼容旧版存档：v2 快照没有泵房表与计划泵位字段，导入时补默认值 */
function normalizeSchedule(row: Partial<Schedule> & { id: string }): Schedule {
  return {
    ...(row as Schedule),
    pumpSlotId: typeof row.pumpSlotId === 'string' ? row.pumpSlotId : null,
    shortfallM3: typeof row.shortfallM3 === 'number' ? row.shortfallM3 : 0,
    slotInferred: row.slotInferred === true,
    legacyReadonly: row.legacyReadonly === true,
  };
}

export async function exportSnapshot(): Promise<DatabaseSnapshot> {
  const [ponds, gates, observations, assays, schedules, pumpGroups, pumpPositions, pumpSlots, pumpMeterReadings] =
    await Promise.all([
      db.ponds.toArray(),
      db.gates.toArray(),
      db.observations.toArray(),
      db.assays.toArray(),
      db.schedules.toArray(),
      db.pumpGroups.toArray(),
      db.pumpPositions.toArray(),
      db.pumpSlots.toArray(),
      db.pumpMeterReadings.toArray(),
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
    pumpGroups,
    pumpPositions,
    pumpSlots,
    pumpMeterReadings,
  };
}

export async function importSnapshot(snapshot: DatabaseSnapshot): Promise<void> {
  await db.transaction(
    'rw',
    [db.ponds, db.gates, db.observations, db.assays, db.schedules, db.pumpGroups, db.pumpPositions, db.pumpSlots, db.pumpMeterReadings],
    async () => {
      await Promise.all([
        db.ponds.clear(),
        db.gates.clear(),
        db.observations.clear(),
        db.assays.clear(),
        db.schedules.clear(),
        db.pumpGroups.clear(),
        db.pumpPositions.clear(),
        db.pumpSlots.clear(),
        db.pumpMeterReadings.clear(),
      ]);
      await db.ponds.bulkPut(snapshot.ponds.map((row) => ({ ...row, revision: ROW_REVISION })));
      await db.gates.bulkPut(snapshot.gates.map((row) => ({ ...row, revision: ROW_REVISION })));
      await db.observations.bulkPut(snapshot.observations.map((row) => ({ ...row, revision: ROW_REVISION })));
      await db.assays.bulkPut(snapshot.assays.map((row) => ({ ...row, revision: ROW_REVISION })));
      await db.schedules.bulkPut((snapshot.schedules ?? []).map((row) => ({ ...normalizeSchedule(row), revision: ROW_REVISION })));
      await db.pumpGroups.bulkPut((snapshot.pumpGroups ?? []).map((row) => ({ ...row, revision: ROW_REVISION })));
      await db.pumpPositions.bulkPut((snapshot.pumpPositions ?? []).map((row) => ({ ...row, revision: ROW_REVISION })));
      await db.pumpSlots.bulkPut((snapshot.pumpSlots ?? []).map((row) => ({ ...row, revision: ROW_REVISION })));
      await db.pumpMeterReadings.bulkPut((snapshot.pumpMeterReadings ?? []).map((row) => ({ ...row, revision: ROW_REVISION })));
    },
  );
}

export async function resetDatabase(): Promise<void> {
  await db.transaction(
    'rw',
    [db.ponds, db.gates, db.observations, db.assays, db.schedules, db.pumpGroups, db.pumpPositions, db.pumpSlots, db.pumpMeterReadings],
    async () => {
      await Promise.all([
        db.ponds.clear(),
        db.gates.clear(),
        db.observations.clear(),
        db.assays.clear(),
        db.schedules.clear(),
        db.pumpGroups.clear(),
        db.pumpPositions.clear(),
        db.pumpSlots.clear(),
        db.pumpMeterReadings.clear(),
      ]);
    },
  );
  await seedDatabase();
}

export async function countAll(): Promise<Record<string, number>> {
  const [ponds, gates, observations, assays, schedules, pumpGroups, pumpPositions, pumpSlots, pumpMeterReadings] =
    await Promise.all([
      db.ponds.count(),
      db.gates.count(),
      db.observations.count(),
      db.assays.count(),
      db.schedules.count(),
      db.pumpGroups.count(),
      db.pumpPositions.count(),
      db.pumpSlots.count(),
      db.pumpMeterReadings.count(),
    ]);
  return { ponds, gates, observations, assays, schedules, pumpGroups, pumpPositions, pumpSlots, pumpMeterReadings };
}
