/**
 * /pumps 泵房泵位账
 * 泵房管理泵组、泵位时段与抄表净量；按池对账把计划量之和与泵房抄表净量摆出来等泵房复核。
 * 调度员在走水页只能读泵位与抄表、放行时选空泵位；抄表净量归泵房录入，调度员不可改。
 * 消费模型：PumpUnit、PumpSlot、PumpMeter、Pond、Schedule；复用组件：<AppDialog>、<EmptyPanel>、<StatBadge>
 */
import { For, Show, createMemo, createSignal, onMount } from 'solid-js';
import { createStore } from 'solid-js/store';
import AppDialog from '../components/common/AppDialog';
import EmptyPanel from '../components/common/EmptyPanel';
import StatBadge from '../components/common/StatBadge';
import { usePondStore } from '../stores/pondStore';
import { usePumpStore } from '../stores/pumpStore';
import { useScheduleStore } from '../stores/scheduleStore';
import {
  PUMP_SLOT_STATUS_OPTIONS,
  PUMP_UNIT_STATUS_OPTIONS,
  type PumpMeter,
  type PumpSlot,
  type PumpUnit,
  type PumpUnitStatus,
  type PumpSlotStatus,
} from '../types/pump';
import { RECONCILE_TOLERANCE_M3, reconcileAll, slotAvailableM3, slotCommittedM3 } from '../utils/pump';
import { today } from '../utils/id';

const INPUT =
  'w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm outline-none focus:border-brine-500 focus:ring-1 focus:ring-brine-400';
const BTN_PRIMARY =
  'rounded-md bg-brine-600 px-3.5 py-1.5 text-sm font-medium text-white transition hover:bg-brine-700 disabled:opacity-50';
const BTN_GHOST =
  'rounded-md border border-slate-300 bg-white px-3.5 py-1.5 text-sm text-slate-700 transition hover:bg-slate-100';
const BTN_DANGER = 'rounded-md bg-rose-600 px-3.5 py-1.5 text-sm font-medium text-white transition hover:bg-rose-700';

type TabKey = 'units' | 'meters' | 'reconcile';

const TAB_ITEMS: Array<{ key: TabKey; label: string; hint: string }> = [
  { key: 'units', label: '泵组与泵位', hint: '泵组 · 泵位时段 · 容量' },
  { key: 'meters', label: '泵房抄表', hint: '按池按日期净量（泵房录入）' },
  { key: 'reconcile', label: '按池对账', hint: '计划量 vs 抄表净量' },
];

const STATUS_STYLE: Record<string, string> = {
  在用: 'border-emerald-300 bg-emerald-50 text-emerald-700',
  停用: 'border-slate-300 bg-slate-100 text-slate-500',
};

interface UnitDraft {
  code: string;
  seriesName: string;
  status: PumpUnitStatus;
  note: string;
}

interface SlotDraft {
  pumpUnitId: string;
  positionCode: string;
  date: string;
  capacityM3: number;
  status: PumpSlotStatus;
  note: string;
}

interface MeterDraft {
  pondId: string;
  date: string;
  netVolumeM3: number;
  note: string;
}

function emptyUnitDraft(seriesName: string): UnitDraft {
  return { code: '', seriesName, status: '在用', note: '' };
}

function emptySlotDraft(pumpUnitId: string): SlotDraft {
  return { pumpUnitId, positionCode: '1#', date: today(), capacityM3: 1000, status: '在用', note: '' };
}

function emptyMeterDraft(): MeterDraft {
  return { pondId: '', date: today(), netVolumeM3: 0, note: '' };
}

export default function PumpRoom() {
  const pondStore = usePondStore();
  const pumpStore = usePumpStore();
  const scheduleStore = useScheduleStore();

  const [tab, setTab] = createSignal<TabKey>('units');

  const [unitDialogOpen, setUnitDialogOpen] = createSignal(false);
  const [editingUnitId, setEditingUnitId] = createSignal<string | null>(null);
  const [unitDraft, setUnitDraft] = createStore<UnitDraft>(emptyUnitDraft(''));

  const [slotDialogOpen, setSlotDialogOpen] = createSignal(false);
  const [editingSlotId, setEditingSlotId] = createSignal<string | null>(null);
  const [slotDraft, setSlotDraft] = createStore<SlotDraft>(emptySlotDraft(''));

  const [meterDialogOpen, setMeterDialogOpen] = createSignal(false);
  const [editingMeterId, setEditingMeterId] = createSignal<string | null>(null);
  const [meterDraft, setMeterDraft] = createStore<MeterDraft>(emptyMeterDraft());

  const [deletingUnit, setDeletingUnit] = createSignal<PumpUnit | null>(null);
  const [deletingSlot, setDeletingSlot] = createSignal<PumpSlot | null>(null);
  const [deletingMeter, setDeletingMeter] = createSignal<PumpMeter | null>(null);

  onMount(() => {
    void pondStore.loadAll();
  });

  const pondOf = (pondId: string) => pondStore.state.ponds.find((pond) => pond.id === pondId) ?? null;
  const pondLabel = (pondId: string): string => {
    const pond = pondOf(pondId);
    return pond === null ? '（池已删除）' : `${pond.code} · ${pond.seriesName}`;
  };

  const schedules = createMemo(() => scheduleStore.state.rows);

  const slotsOfUnit = (unitId: string) => pumpStore.slotsOfUnit(unitId);

  const reconcileRows = createMemo(() =>
    reconcileAll(
      pondStore.state.ponds.map((pond) => pond.id),
      schedules(),
      pumpStore.state.meters,
    ),
  );

  const overToleranceCount = createMemo(() => reconcileRows().filter((row) => row.overTolerance).length);

  /* ------------------------------ 泵组表单 ------------------------------ */

  const openCreateUnit = (): void => {
    const seriesName = pondStore.state.currentSeries ?? pondStore.seriesOptions()[0] ?? '';
    setEditingUnitId(null);
    setUnitDraft(emptyUnitDraft(seriesName));
    setUnitDialogOpen(true);
  };

  const openEditUnit = (unit: PumpUnit): void => {
    setEditingUnitId(unit.id);
    setUnitDraft({ code: unit.code, seriesName: unit.seriesName, status: unit.status, note: unit.note });
    setUnitDialogOpen(true);
  };

  const submitUnit = async (): Promise<void> => {
    if (unitDraft.seriesName.trim() === '') {
      pumpStore.setMessage('请填写服务池系');
      return;
    }
    if (editingUnitId() === null) {
      await pumpStore.createUnit({ ...unitDraft });
    } else {
      await pumpStore.updateUnit(editingUnitId() as string, { ...unitDraft });
    }
    setUnitDialogOpen(false);
  };

  /* ------------------------------ 泵位时段表单 ------------------------------ */

  const openCreateSlot = (unitId: string): void => {
    setEditingSlotId(null);
    setSlotDraft(emptySlotDraft(unitId));
    setSlotDialogOpen(true);
  };

  const openEditSlot = (slot: PumpSlot): void => {
    setEditingSlotId(slot.id);
    setSlotDraft({
      pumpUnitId: slot.pumpUnitId,
      positionCode: slot.positionCode,
      date: slot.date,
      capacityM3: slot.capacityM3,
      status: slot.status,
      note: slot.note,
    });
    setSlotDialogOpen(true);
  };

  const submitSlot = async (): Promise<void> => {
    if (slotDraft.capacityM3 <= 0) {
      pumpStore.setMessage('容量必须大于 0');
      return;
    }
    if (editingSlotId() === null) {
      await pumpStore.createSlot({ ...slotDraft });
    } else {
      await pumpStore.updateSlot(editingSlotId() as string, { ...slotDraft });
    }
    setSlotDialogOpen(false);
  };

  /* ------------------------------ 泵房抄表表单 ------------------------------ */

  const openCreateMeter = (): void => {
    setEditingMeterId(null);
    setMeterDraft(emptyMeterDraft());
    setMeterDialogOpen(true);
  };

  const openEditMeter = (meter: PumpMeter): void => {
    setEditingMeterId(meter.id);
    setMeterDraft({ pondId: meter.pondId, date: meter.date, netVolumeM3: meter.netVolumeM3, note: meter.note });
    setMeterDialogOpen(true);
  };

  const submitMeter = async (): Promise<void> => {
    if (meterDraft.pondId === '') {
      pumpStore.setMessage('请选择蒸发池');
      return;
    }
    if (meterDraft.netVolumeM3 < 0) {
      pumpStore.setMessage('抄表净量不能为负');
      return;
    }
    if (editingMeterId() === null) {
      await pumpStore.createMeter({ ...meterDraft });
    } else {
      await pumpStore.updateMeter(editingMeterId() as string, { ...meterDraft });
    }
    setMeterDialogOpen(false);
  };

  return (
    <div class="space-y-3.5">
      <div class="flex flex-wrap gap-3">
        <StatBadge label="泵组" value={pumpStore.state.units.length} suffix="组" tone="primary" />
        <StatBadge label="泵位时段" value={pumpStore.state.slots.length} suffix="个" tone="info" />
        <StatBadge label="泵房抄表" value={pumpStore.state.meters.length} suffix="条" tone="default" />
        <StatBadge
          label="超容差待复核"
          value={overToleranceCount()}
          suffix="池"
          tone={overToleranceCount() > 0 ? 'danger' : 'success'}
          hint={`计划量之和与抄表净量差超过 ${RECONCILE_TOLERANCE_M3} m³ 的池数`}
        />
      </div>

      <Show when={pumpStore.state.lastMessage !== ''}>
        <div class="rounded-lg border border-brine-200 bg-brine-50 px-3.5 py-2 text-sm text-brine-800">
          {pumpStore.state.lastMessage}
        </div>
      </Show>

      <div class="flex flex-wrap gap-1.5 rounded-lg border border-slate-200 bg-white p-1.5">
        <For each={TAB_ITEMS}>
          {(item) => (
            <button
              type="button"
              class={`rounded-md px-3.5 py-1.5 text-sm transition ${
                tab() === item.key ? 'bg-brine-600 text-white' : 'text-slate-600 hover:bg-slate-100'
              }`}
              onClick={() => setTab(item.key)}
            >
              {item.label}
            </button>
          )}
        </For>
      </div>

      {/* ------------------------------ 泵组与泵位 ------------------------------ */}
      <Show when={tab() === 'units'}>
        <section class="rounded-xl border border-slate-200 bg-white p-4">
          <header class="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 class="text-[15px] font-semibold text-slate-800">泵组与泵位时段</h2>
              <p class="mt-0.5 text-xs text-slate-500">
                泵组按池系服务，泵位时段挂在泵组下。停泵 / 停用泵位会把靠它排的计划退回待排；小幅改日期 / 容量不打回计划。
              </p>
            </div>
            <button type="button" class={BTN_PRIMARY} onClick={openCreateUnit}>
              + 新建泵组
            </button>
          </header>

          <Show
            when={pumpStore.state.units.length > 0}
            fallback={
              <EmptyPanel
                title="还没有泵组"
                description="按池系建立泵组，再在泵组下建泵位时段。走水计划放行时即可选择空泵位。"
                actionText="新建第一个泵组"
                onAction={openCreateUnit}
              />
            }
          >
            <div class="space-y-3">
              <For each={pumpStore.state.units}>
                {(unit) => {
                  const unitSlots = (): PumpSlot[] => slotsOfUnit(unit.id);
                  return (
                    <div class="rounded-lg border border-slate-200">
                      <div class="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 bg-slate-50/60 px-3.5 py-2.5">
                        <div class="flex items-center gap-2">
                          <span class="text-sm font-semibold text-slate-800">{unit.code}</span>
                          <span class="text-xs text-slate-500">{unit.seriesName}</span>
                          <span class={`rounded border px-2 py-0.5 text-[11px] ${STATUS_STYLE[unit.status]}`}>{unit.status}</span>
                          <Show when={unit.note !== ''}>
                            <span class="text-xs text-slate-400">· {unit.note}</span>
                          </Show>
                        </div>
                        <div class="flex flex-wrap items-center gap-2">
                          <button class="text-xs text-brine-700 hover:underline" onClick={() => openCreateSlot(unit.id)}>
                            + 泵位时段
                          </button>
                          <button class="text-xs text-brine-700 hover:underline" onClick={() => openEditUnit(unit)}>
                            编辑
                          </button>
                          <button
                            class="text-xs text-slate-600 hover:underline"
                            onClick={() => pumpStore.setUnitStatus(unit.id, unit.status === '在用' ? '停用' : '在用')}
                          >
                            {unit.status === '在用' ? '停用' : '启用'}
                          </button>
                          <button class="text-xs text-rose-600 hover:underline" onClick={() => setDeletingUnit(unit)}>
                            删除
                          </button>
                        </div>
                      </div>

                      <Show
                        when={unitSlots().length > 0}
                        fallback={<p class="px-3.5 py-3 text-xs text-slate-400">该泵组还没有泵位时段</p>}
                      >
                        <ul class="divide-y divide-slate-100">
                          <For each={unitSlots()}>
                            {(slot) => {
                              const committed = (): number => slotCommittedM3(slot, schedules());
                              const available = (): number => slotAvailableM3(slot, schedules());
                              const pct = (): number => (slot.capacityM3 === 0 ? 0 : Math.min(100, (committed() / slot.capacityM3) * 100));
                              return (
                                <li class="flex flex-wrap items-center gap-3 px-3.5 py-2.5">
                                  <div class="min-w-[140px] flex-1">
                                    <p class="text-sm font-medium text-slate-800">
                                      {slot.date} · {slot.positionCode}
                                    </p>
                                    <p class="text-xs text-slate-500">
                                      容量 <span class="tabular-nums">{slot.capacityM3}</span> m³ · 已占用{' '}
                                      <span class="tabular-nums">{committed()}</span> m³ · 剩余{' '}
                                      <span class="tabular-nums text-brine-700">{available()}</span> m³
                                    </p>
                                  </div>
                                  <div class="h-1.5 w-28 overflow-hidden rounded-full bg-slate-100">
                                    <div
                                      class={`h-full rounded-full ${pct() >= 100 ? 'bg-rose-500' : 'bg-brine-600'}`}
                                      style={{ width: `${pct()}%` }}
                                    />
                                  </div>
                                  <span class={`rounded border px-2 py-0.5 text-[11px] ${STATUS_STYLE[slot.status]}`}>
                                    {slot.status}
                                  </span>
                                  <div class="flex flex-wrap items-center gap-2">
                                    <button class="text-xs text-brine-700 hover:underline" onClick={() => openEditSlot(slot)}>
                                      编辑
                                    </button>
                                    <button
                                      class="text-xs text-slate-600 hover:underline"
                                      onClick={() => pumpStore.setSlotStatus(slot.id, slot.status === '在用' ? '停用' : '在用')}
                                    >
                                      {slot.status === '在用' ? '停用' : '启用'}
                                    </button>
                                    <button class="text-xs text-rose-600 hover:underline" onClick={() => setDeletingSlot(slot)}>
                                      删除
                                    </button>
                                  </div>
                                </li>
                              );
                            }}
                          </For>
                        </ul>
                      </Show>
                    </div>
                  );
                }}
              </For>
            </div>
          </Show>
        </section>
      </Show>

      {/* ------------------------------ 泵房抄表 ------------------------------ */}
      <Show when={tab() === 'meters'}>
        <section class="rounded-xl border border-slate-200 bg-white p-4">
          <header class="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 class="text-[15px] font-semibold text-slate-800">泵房抄表净量</h2>
              <p class="mt-0.5 text-xs text-slate-500">
                按池、按日期记录实际走水净量，归泵房录入与维护；调度员在走水编排页只读，不可修改。
              </p>
            </div>
            <button type="button" class={BTN_PRIMARY} onClick={openCreateMeter} disabled={pondStore.state.ponds.length === 0}>
              + 新建抄表
            </button>
          </header>

          <Show
            when={pumpStore.state.meters.length > 0}
            fallback={
              <EmptyPanel
                title="还没有泵房抄表"
                description="按池、按日期录入抄表净量，用于和走水计划量按池对账。"
                actionText="新建第一条抄表"
                onAction={openCreateMeter}
              />
            }
          >
            <div class="overflow-x-auto">
              <table class="w-full min-w-[640px] border-collapse text-sm">
                <thead>
                  <tr class="border-b border-slate-200 bg-slate-50 text-left text-xs text-slate-500">
                    <th class="px-3 py-2">蒸发池</th>
                    <th class="px-3 py-2">抄表日期</th>
                    <th class="px-3 py-2 text-right">抄表净量（m³）</th>
                    <th class="px-3 py-2">备注</th>
                    <th class="px-3 py-2 text-right">操作</th>
                  </tr>
                </thead>
                <tbody>
                  <For each={pumpStore.state.meters}>
                    {(meter) => (
                      <tr class="border-b border-slate-100 hover:bg-slate-50/60">
                        <td class="px-3 py-2.5 font-medium text-slate-800">{pondLabel(meter.pondId)}</td>
                        <td class="px-3 py-2.5 tabular-nums">{meter.date}</td>
                        <td class="px-3 py-2.5 text-right tabular-nums">{meter.netVolumeM3}</td>
                        <td class="px-3 py-2.5 text-xs text-slate-500">{meter.note || '—'}</td>
                        <td class="px-3 py-2.5 text-right">
                          <button class="mr-2 text-xs text-brine-700 hover:underline" onClick={() => openEditMeter(meter)}>
                            编辑
                          </button>
                          <button class="text-xs text-rose-600 hover:underline" onClick={() => setDeletingMeter(meter)}>
                            删除
                          </button>
                        </td>
                      </tr>
                    )}
                  </For>
                </tbody>
              </table>
            </div>
          </Show>
        </section>
      </Show>

      {/* ------------------------------ 按池对账 ------------------------------ */}
      <Show when={tab() === 'reconcile'}>
        <section class="rounded-xl border border-slate-200 bg-white p-4">
          <header class="mb-3">
            <h2 class="text-[15px] font-semibold text-slate-800">按池对账</h2>
            <p class="mt-0.5 text-xs text-slate-500">
              计划量之和（已排 / 走水中 / 已出卤）与泵房抄表净量按池对比；差值超过容差 {RECONCILE_TOLERANCE_M3} m³
              即把数字摆出来等泵房复核。调度员只看不改。
            </p>
          </header>

          <Show
            when={reconcileRows().length > 0}
            fallback={
              <EmptyPanel
                title="还没有可对账的蒸发池"
                description="先在 /ponds 建立蒸发池，并在走水编排中安排计划、在泵房抄表中录入净量，这里会自动按池对账。"
              />
            }
          >
            <div class="overflow-x-auto">
              <table class="w-full min-w-[720px] border-collapse text-sm">
                <thead>
                  <tr class="border-b border-slate-200 bg-slate-50 text-left text-xs text-slate-500">
                    <th class="px-3 py-2">蒸发池</th>
                    <th class="px-3 py-2 text-right">计划量之和（m³）</th>
                    <th class="px-3 py-2 text-right">泵房抄表净量（m³）</th>
                    <th class="px-3 py-2 text-right">差值（m³）</th>
                    <th class="px-3 py-2">状态</th>
                  </tr>
                </thead>
                <tbody>
                  <For each={reconcileRows()}>
                    {(row) => {
                      const pond = (): ReturnType<typeof pondOf> => pondOf(row.pondId);
                      return (
                        <tr class={`border-b border-slate-100 ${row.overTolerance ? 'bg-rose-50/60' : 'hover:bg-slate-50/60'}`}>
                          <td class="px-3 py-2.5 font-medium text-slate-800">
                            {pond() === null ? '（池已删除）' : `${pond()!.code} · ${pond()!.seriesName}`}
                          </td>
                          <td class="px-3 py-2.5 text-right tabular-nums">{row.plannedM3}</td>
                          <td class="px-3 py-2.5 text-right tabular-nums">{row.meterM3}</td>
                          <td
                            class={`px-3 py-2.5 text-right tabular-nums font-medium ${
                              row.overTolerance ? 'text-rose-700' : 'text-slate-700'
                            }`}
                          >
                            {row.diffM3 > 0 ? `+${row.diffM3}` : row.diffM3}
                          </td>
                          <td class="px-3 py-2.5">
                            <Show
                              when={row.overTolerance}
                              fallback={<span class="rounded border border-emerald-300 bg-emerald-50 px-2 py-0.5 text-[11px] text-emerald-700">正常</span>}
                            >
                              <span class="rounded border border-rose-300 bg-rose-100 px-2 py-0.5 text-[11px] text-rose-700">
                                超容差 · 等泵房复核
                              </span>
                            </Show>
                          </td>
                        </tr>
                      );
                    }}
                  </For>
                </tbody>
              </table>
            </div>
          </Show>
        </section>
      </Show>

      {/* ------------------------------ 泵组表单弹层 ------------------------------ */}
      <AppDialog
        open={unitDialogOpen()}
        title={editingUnitId() === null ? '新建泵组' : '编辑泵组'}
        onClose={() => setUnitDialogOpen(false)}
        footer={
          <>
            <button class={BTN_GHOST} onClick={() => setUnitDialogOpen(false)}>
              取消
            </button>
            <button class={BTN_PRIMARY} onClick={() => void submitUnit()}>
              保存
            </button>
          </>
        }
      >
        <div class="grid gap-3 sm:grid-cols-2">
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>泵组编号</span>
            <input class={INPUT} value={unitDraft.code} onInput={(event) => setUnitDraft('code', event.currentTarget.value)} placeholder="如 北部一系泵组" />
          </label>
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>服务池系</span>
            <input class={INPUT} value={unitDraft.seriesName} onInput={(event) => setUnitDraft('seriesName', event.currentTarget.value)} placeholder="如 北部一系" />
          </label>
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>状态</span>
            <select class={INPUT} value={unitDraft.status} onChange={(event) => setUnitDraft('status', event.currentTarget.value as PumpUnitStatus)}>
              <For each={PUMP_UNIT_STATUS_OPTIONS}>{(status) => <option value={status}>{status}</option>}</For>
            </select>
          </label>
          <label class="flex flex-col gap-1 text-[13px] text-slate-600 sm:col-span-2">
            <span>备注</span>
            <input class={INPUT} value={unitDraft.note} onInput={(event) => setUnitDraft('note', event.currentTarget.value)} />
          </label>
        </div>
      </AppDialog>

      {/* ------------------------------ 泵位时段表单弹层 ------------------------------ */}
      <AppDialog
        open={slotDialogOpen()}
        title={editingSlotId() === null ? '新建泵位时段' : '编辑泵位时段'}
        onClose={() => setSlotDialogOpen(false)}
        footer={
          <>
            <button class={BTN_GHOST} onClick={() => setSlotDialogOpen(false)}>
              取消
            </button>
            <button class={BTN_PRIMARY} onClick={() => void submitSlot()}>
              保存
            </button>
          </>
        }
      >
        <div class="grid gap-3 sm:grid-cols-2">
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>所属泵组</span>
            <select class={INPUT} value={slotDraft.pumpUnitId} onChange={(event) => setSlotDraft('pumpUnitId', event.currentTarget.value)}>
              <For each={pumpStore.state.units}>{(unit) => <option value={unit.id}>{unit.code}</option>}</For>
            </select>
          </label>
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>泵位号</span>
            <input class={INPUT} value={slotDraft.positionCode} onInput={(event) => setSlotDraft('positionCode', event.currentTarget.value)} placeholder="如 1#" />
          </label>
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>时段日期</span>
            <input type="date" class={INPUT} value={slotDraft.date} onInput={(event) => setSlotDraft('date', event.currentTarget.value)} />
          </label>
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>容量（m³）</span>
            <input
              type="number"
              step="10"
              class={INPUT}
              value={slotDraft.capacityM3}
              onInput={(event) => setSlotDraft('capacityM3', Number(event.currentTarget.value))}
            />
          </label>
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>状态</span>
            <select class={INPUT} value={slotDraft.status} onChange={(event) => setSlotDraft('status', event.currentTarget.value as PumpSlotStatus)}>
              <For each={PUMP_SLOT_STATUS_OPTIONS}>{(status) => <option value={status}>{status}</option>}</For>
            </select>
          </label>
          <label class="flex flex-col gap-1 text-[13px] text-slate-600 sm:col-span-2">
            <span>备注</span>
            <input class={INPUT} value={slotDraft.note} onInput={(event) => setSlotDraft('note', event.currentTarget.value)} />
          </label>
        </div>
        <p class="mt-3 rounded-md bg-slate-50 px-3 py-2 text-xs leading-relaxed text-slate-500">
          小幅改动日期 / 容量 / 泵位号不会打回已挂接的计划；只有把泵位时段「停用」或「删除」才会把靠它排的计划退回待排。
        </p>
      </AppDialog>

      {/* ------------------------------ 泵房抄表表单弹层 ------------------------------ */}
      <AppDialog
        open={meterDialogOpen()}
        title={editingMeterId() === null ? '新建泵房抄表' : '编辑泵房抄表'}
        onClose={() => setMeterDialogOpen(false)}
        footer={
          <>
            <button class={BTN_GHOST} onClick={() => setMeterDialogOpen(false)}>
              取消
            </button>
            <button class={BTN_PRIMARY} onClick={() => void submitMeter()}>
              保存
            </button>
          </>
        }
      >
        <div class="grid gap-3 sm:grid-cols-2">
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>蒸发池</span>
            <select class={INPUT} value={meterDraft.pondId} onChange={(event) => setMeterDraft('pondId', event.currentTarget.value)}>
              <option value="">请选择</option>
              <For each={pondStore.state.ponds}>
                {(pond) => <option value={pond.id}>{pond.code} · {pond.seriesName}</option>}
              </For>
            </select>
          </label>
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>抄表日期</span>
            <input type="date" class={INPUT} value={meterDraft.date} onInput={(event) => setMeterDraft('date', event.currentTarget.value)} />
          </label>
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>抄表净量（m³）</span>
            <input
              type="number"
              step="10"
              class={INPUT}
              value={meterDraft.netVolumeM3}
              onInput={(event) => setMeterDraft('netVolumeM3', Number(event.currentTarget.value))}
            />
          </label>
          <label class="flex flex-col gap-1 text-[13px] text-slate-600 sm:col-span-2">
            <span>备注</span>
            <input class={INPUT} value={meterDraft.note} onInput={(event) => setMeterDraft('note', event.currentTarget.value)} />
          </label>
        </div>
      </AppDialog>

      {/* ------------------------------ 删除二次确认 ------------------------------ */}
      <AppDialog
        open={deletingUnit() !== null}
        title="确认删除泵组？"
        width="max-w-lg"
        onClose={() => setDeletingUnit(null)}
        footer={
          <>
            <button class={BTN_GHOST} onClick={() => setDeletingUnit(null)}>
              取消
            </button>
            <button
              class={BTN_DANGER}
              onClick={async () => {
                const unit = deletingUnit();
                if (unit === null) return;
                await pumpStore.deleteUnit(unit.id);
                setDeletingUnit(null);
              }}
            >
              确认删除
            </button>
          </>
        }
      >
        <p class="text-sm leading-relaxed text-slate-600">
          将删除泵组「{deletingUnit()?.code}」及其下全部泵位时段；靠它排的未出卤计划会退回待排等调度员重排，已出卤的保持原样。
        </p>
      </AppDialog>

      <AppDialog
        open={deletingSlot() !== null}
        title="确认删除泵位时段？"
        width="max-w-lg"
        onClose={() => setDeletingSlot(null)}
        footer={
          <>
            <button class={BTN_GHOST} onClick={() => setDeletingSlot(null)}>
              取消
            </button>
            <button
              class={BTN_DANGER}
              onClick={async () => {
                const slot = deletingSlot();
                if (slot === null) return;
                await pumpStore.deleteSlot(slot.id);
                setDeletingSlot(null);
              }}
            >
              确认删除
            </button>
          </>
        }
      >
        <p class="text-sm leading-relaxed text-slate-600">
          将删除泵位时段「{deletingSlot()?.date} {deletingSlot()?.positionCode}」；靠它排的未出卤计划会退回待排等调度员重排，已出卤的保持原样。
        </p>
      </AppDialog>

      <AppDialog
        open={deletingMeter() !== null}
        title="确认删除泵房抄表？"
        width="max-w-lg"
        onClose={() => setDeletingMeter(null)}
        footer={
          <>
            <button class={BTN_GHOST} onClick={() => setDeletingMeter(null)}>
              取消
            </button>
            <button
              class={BTN_DANGER}
              onClick={async () => {
                const meter = deletingMeter();
                if (meter === null) return;
                await pumpStore.deleteMeter(meter.id);
                setDeletingMeter(null);
              }}
            >
              确认删除
            </button>
          </>
        }
      >
        <p class="text-sm leading-relaxed text-slate-600">
          将删除「{pondLabel(deletingMeter()?.pondId ?? '')}」在 {deletingMeter()?.date} 的泵房抄表记录（{deletingMeter()?.netVolumeM3} m³）。
        </p>
      </AppDialog>
    </div>
  );
}
