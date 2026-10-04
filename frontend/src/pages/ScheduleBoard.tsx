/**
 * /schedules 走水与出卤编排（调度室）
 * 调度只管池与目标密度：放行前先看哪个泵位空着、容量够不够，不够按池排队顺延，差额写在计划上。
 * 泵位账归泵房：停泵 / 改派会退回计划（已出卤照旧）；泵房抄表调度员不可改，按池对账只摆数字。
 * 消费模型：Schedule、PumpPosition、PumpSlot、PumpMeterReading、Pond；
 * 复用组件：<FilterBar>、<EmptyPanel>、<StatBadge>、<ReleaseDialog>、<ReassignDialog>
 */
import { For, Show, createMemo, createSignal, onMount } from 'solid-js';
import { createStore } from 'solid-js/store';
import AppDialog from '../components/common/AppDialog';
import EmptyPanel from '../components/common/EmptyPanel';
import FilterBar from '../components/common/FilterBar';
import StatBadge from '../components/common/StatBadge';
import StageTag from '../components/common/StageTag';
import ReleaseDialog from '../components/pump/ReleaseDialog';
import ReassignDialog from '../components/pump/ReassignDialog';
import { usePondStore } from '../stores/pondStore';
import { usePumpStore } from '../stores/pumpStore';
import { useScheduleStore } from '../stores/scheduleStore';
import { SCHEDULE_STATE_OPTIONS, type Schedule, type ScheduleDraft, type ScheduleState } from '../types/schedule';
import { effectiveVerdict } from '../utils/brine';
import { reconcileByPond, type ReconcileStatus } from '../utils/pump';
import { today } from '../utils/id';

const INPUT =
  'w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm outline-none focus:border-brine-500 focus:ring-1 focus:ring-brine-400';
const BTN_PRIMARY =
  'rounded-md bg-brine-600 px-3.5 py-1.5 text-sm font-medium text-white transition hover:bg-brine-700 disabled:opacity-50';
const BTN_GHOST =
  'rounded-md border border-slate-300 bg-white px-3.5 py-1.5 text-sm text-slate-700 transition hover:bg-slate-100';
const BTN_DANGER = 'rounded-md bg-rose-600 px-3.5 py-1.5 text-sm font-medium text-white transition hover:bg-rose-700';

const STATE_STYLE: Record<ScheduleState, string> = {
  待排: 'border-slate-300 bg-slate-100 text-slate-600',
  已排: 'border-sky-300 bg-sky-50 text-sky-700',
  走水中: 'border-amber-300 bg-amber-50 text-amber-700',
  已出卤: 'border-emerald-300 bg-emerald-50 text-emerald-700',
};

const RECON_STYLE: Record<ReconcileStatus, string> = {
  平: 'border-emerald-300 bg-emerald-50 text-emerald-700',
  超差: 'border-rose-300 bg-rose-50 text-rose-700',
  缺抄表: 'border-amber-300 bg-amber-50 text-amber-700',
};

function emptyDraft(pondId: string, orderIndex: number): ScheduleDraft {
  return {
    pondId,
    planDate: today(),
    targetDensity: 1.15,
    volumeM3: 800,
    operator: '',
    state: '待排',
    orderIndex,
  };
}

export default function ScheduleBoard() {
  const pondStore = usePondStore();
  const scheduleStore = useScheduleStore();
  const pumpStore = usePumpStore();

  const [dialogOpen, setDialogOpen] = createSignal(false);
  const [editingId, setEditingId] = createSignal<string | null>(null);
  const [deleting, setDeleting] = createSignal<Schedule | null>(null);
  const [dragOverId, setDragOverId] = createSignal<string | null>(null);
  const [releaseTarget, setReleaseTarget] = createSignal<Schedule | null>(null);
  const [reassignTarget, setReassignTarget] = createSignal<Schedule | null>(null);
  const [draft, setDraft] = createStore<ScheduleDraft>(emptyDraft('', 1));

  onMount(() => {
    void pondStore.loadAll();
  });

  const pondOf = (pondId: string) => pondStore.state.ponds.find((pond) => pond.id === pondId) ?? null;
  const pondLabel = (pondId: string): string => {
    const pond = pondOf(pondId);
    return pond === null ? '（池已删除）' : `${pond.code} · ${pond.seriesName}`;
  };

  /** 计划绑定的泵位时段与泵位（可能已停用 / 已删除） */
  const slotOf = (row: Schedule) => (row.pumpSlotId === null ? null : pumpStore.state.slots.find((slot) => slot.id === row.pumpSlotId) ?? null);
  const positionOf = (row: Schedule) => {
    const slot = slotOf(row);
    return slot === null ? null : pumpStore.positionById().get(slot.positionId) ?? null;
  };

  const ordered = createMemo<Schedule[]>(() =>
    [...scheduleStore.state.rows].sort((a, b) => a.orderIndex - b.orderIndex || a.planDate.localeCompare(b.planDate)),
  );

  const filtered = createMemo<Schedule[]>(() => {
    const current = scheduleStore.filters();
    const series = pondStore.state.currentSeries;
    const keyword = current.keyword.trim().toLowerCase();
    return ordered().filter((row) => {
      const pond = pondOf(row.pondId);
      if (series !== null && pond?.seriesName !== series) return false;
      if (current.state !== 'all' && row.state !== current.state) return false;
      if (keyword === '') return true;
      const position = positionOf(row);
      return (
        pondLabel(row.pondId).toLowerCase().includes(keyword) ||
        row.operator.toLowerCase().includes(keyword) ||
        row.planDate.includes(keyword) ||
        (position?.code.toLowerCase().includes(keyword) ?? false)
      );
    });
  });

  /** 按池对账（调度只读视图，泵房复核在 /pumps） */
  const reconcile = createMemo(() => {
    const map = new Map(
      reconcileByPond(
        scheduleStore.state.rows,
        pumpStore.state.readings,
        (pondId) => pondOf(pondId)?.seriesName ?? '（未知池系）',
      ).map((item) => [item.pondId, item]),
    );
    return map;
  });

  const stats = createMemo(() => {
    const list = ordered();
    const reconcileList = Array.from(reconcile().values());
    return {
      total: list.length,
      pending: list.filter((row) => row.state === '待排').length,
      running: list.filter((row) => row.state === '走水中').length,
      done: list.filter((row) => row.state === '已出卤').length,
      readonly: list.filter((row) => row.legacyReadonly).length,
      shortfall: list.filter((row) => row.shortfallM3 > 0 && row.state === '待排').length,
      volume: Math.round(list.reduce((acc, row) => acc + row.volumeM3, 0) * 10) / 10,
      donePct: list.length === 0 ? 0 : Math.round((list.filter((row) => row.state === '已出卤').length / list.length) * 1000) / 10,
      reconOver: reconcileList.filter((item) => item.status === '超差').length,
      reconMissing: reconcileList.filter((item) => item.status === '缺抄表').length,
    };
  });

  const openCreate = (): void => {
    const pondId = pondStore.pondsOfSeries(pondStore.state.currentSeries)[0]?.id ?? pondStore.state.ponds[0]?.id ?? '';
    setEditingId(null);
    setDraft(emptyDraft(pondId, ordered().length + 1));
    setDialogOpen(true);
  };

  const openEdit = (row: Schedule): void => {
    setEditingId(row.id);
    setDraft({
      pondId: row.pondId,
      planDate: row.planDate,
      targetDensity: row.targetDensity,
      volumeM3: row.volumeM3,
      operator: row.operator,
      state: row.state,
      orderIndex: row.orderIndex,
    });
    setDialogOpen(true);
  };

  const submit = async (): Promise<void> => {
    if (draft.pondId === '') {
      scheduleStore.setMessage('请选择蒸发池');
      return;
    }
    if (editingId() === null) {
      const row = await scheduleStore.createSchedule({ ...draft });
      scheduleStore.setMessage(`已新建走水计划：${row.planDate}，目标密度 ${row.targetDensity} g/cm³，进入待排队列`);
    } else {
      await scheduleStore.updateSchedule(editingId() as string, { ...draft });
    }
    setDialogOpen(false);
  };

  const confirmDelete = async (): Promise<void> => {
    const row = deleting();
    if (row === null) return;
    await scheduleStore.deleteSchedule(row.id);
    setDeleting(null);
  };

  const handleDrop = async (targetId: string): Promise<void> => {
    const fromId = scheduleStore.draggingId();
    setDragOverId(null);
    scheduleStore.setDraggingId(null);
    if (fromId === null || fromId === targetId) return;
    await scheduleStore.moveBefore(fromId, targetId);
  };

  const nextStateLabel = (state: ScheduleState): string => {
    if (state === '已排') return '开始走水';
    if (state === '走水中') return '完成出卤';
    return '已出卤';
  };

  return (
    <div class="space-y-3.5">
      <div class="flex flex-wrap gap-3">
        <StatBadge label="走水计划" value={stats().total} suffix="条" tone="primary" />
        <StatBadge label="待排" value={stats().pending} suffix="条" tone="default" />
        <StatBadge label="走水中" value={stats().running} suffix="条" tone="warning" />
        <StatBadge label="已出卤" value={stats().done} suffix="条" tone="success" />
        <StatBadge label="待排缺方" value={stats().shortfall} suffix="条" tone="warning" hint="容量不够按池排队顺延、差额已写在计划上的待排条数" />
        <StatBadge label="旧数据只读" value={stats().readonly} suffix="条" tone="danger" hint="升级时按池系反推不出泵位归属的旧计划，留只读等处理" />
        <StatBadge label="对账超差" value={stats().reconOver} suffix="口" tone="danger" hint="计划量之和与泵房抄表净量差过容差，等泵房复核" />
        <StatBadge label="缺抄表" value={stats().reconMissing} suffix="口" tone="warning" />
        <StatBadge label="计划总量" value={stats().volume} suffix="m³" tone="info" />
        <StatBadge label="出卤完成率" value={`${stats().donePct}%`} percent={stats().donePct} tone="success" />
      </div>

      <Show when={scheduleStore.state.lastMessage !== ''}>
        <div class="rounded-lg border border-brine-200 bg-brine-50 px-3.5 py-2 text-sm text-brine-800">
          {scheduleStore.state.lastMessage}
        </div>
      </Show>

      <section class="rounded-xl border border-slate-200 bg-white p-4">
        <header class="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 class="text-[15px] font-semibold text-slate-800">走水与出卤编排</h2>
            <p class="mt-0.5 text-xs text-slate-500">
              放行前先看哪个泵位空着，容量不够按池排队顺延；泵位小幅挪动不打回计划，停泵 / 改派由泵房退回待排（已出卤照旧）。
            </p>
          </div>
          <button type="button" class={BTN_PRIMARY} onClick={openCreate} disabled={pondStore.state.ponds.length === 0}>
            + 新建走水计划
          </button>
        </header>

        <FilterBar
          keyword={scheduleStore.filters().keyword}
          onKeyword={(value) => scheduleStore.patchFilters({ keyword: value })}
          fields={[
            { key: 'series', label: '池系', options: pondStore.seriesOptions() },
            { key: 'state', label: '状态', options: [...SCHEDULE_STATE_OPTIONS] },
          ]}
          values={{ series: pondStore.state.currentSeries ?? 'all', state: scheduleStore.filters().state }}
          onChange={(key, value) => {
            if (key === 'series') pondStore.setCurrentSeries(value === 'all' ? null : value);
            if (key === 'state') scheduleStore.patchFilters({ state: value as ScheduleState | 'all' });
          }}
          onReset={() => {
            scheduleStore.resetFilters();
            pondStore.setCurrentSeries(pondStore.seriesOptions()[0] ?? null);
          }}
          resultText={`命中 ${filtered().length} / ${ordered().length} 条`}
        />

        <Show when={ordered().length === 0}>
          <EmptyPanel
            title="还没有走水编排"
            description="为蒸发池编排走水日期、目标密度与计划量；新建后先进待排队列，放行时再选当日空泵位。"
            actionText="新建第一条走水计划"
            onAction={openCreate}
          />
        </Show>

        <Show when={ordered().length > 0}>
          <ul class="space-y-2">
            <For each={filtered()}>
              {(row, index) => {
                const position = () => positionOf(row);
                const slot = () => slotOf(row);
                const recon = () => reconcile().get(row.pondId);
                return (
                  <li
                    draggable={!row.legacyReadonly}
                    class={`flex flex-wrap items-center gap-3 rounded-lg border bg-white px-3.5 py-3 transition ${
                      dragOverId() === row.id ? 'border-brine-500 ring-1 ring-brine-400' : 'border-slate-200'
                    } ${row.legacyReadonly ? 'bg-slate-50/70 opacity-90' : ''}`}
                    onDragStart={() => scheduleStore.setDraggingId(row.id)}
                    onDragOver={(event) => {
                      event.preventDefault();
                      setDragOverId(row.id);
                    }}
                    onDragLeave={() => setDragOverId(null)}
                    onDrop={(event) => {
                      event.preventDefault();
                      void handleDrop(row.id);
                    }}
                  >
                    <span class="grid h-7 w-7 shrink-0 cursor-grab place-items-center rounded-full bg-slate-100 text-xs font-semibold text-slate-500">
                      {index() + 1}
                    </span>
                    <span class="cursor-grab text-slate-300" title="按住拖拽调整顺序">
                      ⠿
                    </span>
                    <div class="min-w-[180px] flex-1">
                      <p class="text-sm font-medium text-slate-800">{pondLabel(row.pondId)}</p>
                      <p class="text-xs text-slate-500">
                        计划日期 {row.planDate} · 调度员 {row.operator === '' ? '未填写' : row.operator}
                      </p>
                    </div>
                    <div class="flex items-center gap-2">
                      <StageTag stage={pondOf(row.pondId)?.stage ?? null} size="sm" />
                    </div>
                    <div class="text-xs text-slate-600">
                      <p>
                        目标密度 <span class="tabular-nums font-medium text-slate-800">{row.targetDensity}</span> g/cm³
                      </p>
                      <p>
                        当前密度{' '}
                        <span class="tabular-nums font-medium text-brine-700">
                          {pondStore.statOf(row.pondId).currentDensity || '—'}
                        </span>
                      </p>
                    </div>
                    <div class="text-xs text-slate-600">
                      <p>
                        计划量 <span class="tabular-nums font-medium text-slate-800">{row.volumeM3}</span> m³
                      </p>
                      <p>
                        组分判定{' '}
                        <span class="font-medium text-slate-800">
                          {(() => {
                            const list = pondStore.state.assays
                              .filter((item) => item.pondId === row.pondId)
                              .sort((a, b) => a.date.localeCompare(b.date));
                            return list.length === 0 ? '未化验' : effectiveVerdict(list[list.length - 1]);
                          })()}
                        </span>
                      </p>
                    </div>

                    {/* 泵位归属：调度只看，不能直接改抄表 / 台账 */}
                    <div class="min-w-[132px] text-xs">
                      <Show
                        when={position() !== null}
                        fallback={
                          <p class={row.legacyReadonly ? 'font-medium text-rose-700' : 'text-slate-400'}>
                            {row.legacyReadonly ? '旧数据缺泵位·只读' : '未排泵位'}
                          </p>
                        }
                      >
                        <p class="font-medium text-slate-800">{position()?.code}</p>
                        <p class="text-slate-400">
                          {slot()?.state ?? ''}
                          {row.slotInferred ? ' · 反推' : ''}
                        </p>
                      </Show>
                      <Show when={position() !== null && position()?.status === '停用'}>
                        <p class="text-rose-600">泵位已停用</p>
                      </Show>
                      <Show when={row.shortfallM3 > 0}>
                        <p class="text-amber-700">缺口 {row.shortfallM3} m³</p>
                      </Show>
                    </div>

                    <Show when={recon() !== undefined && recon()?.status !== '平'}>
                      <span class={`rounded border px-2 py-0.5 text-[11px] ${RECON_STYLE[recon()?.status ?? '平']}`}>
                        对账{recon()?.status === '超差' ? `超差 ${recon()?.diffM3}` : '缺抄表'}
                      </span>
                    </Show>

                    <span class={`rounded border px-2 py-0.5 text-[11px] ${STATE_STYLE[row.state]}`}>{row.state}</span>

                    <div class="flex flex-wrap items-center gap-2">
                      <Show
                        when={!row.legacyReadonly}
                        fallback={
                          <span class="rounded border border-rose-200 bg-rose-50 px-2 py-1 text-[11px] text-rose-700" title="升级时按池系反推不出泵位归属，留只读；退回待排后由调度员重新放行">
                            🔒 只读
                          </span>
                        }
                      >
                        <Show when={row.state === '待排'}>
                          <button
                            class="rounded-md bg-brine-600 px-2.5 py-1 text-xs font-medium text-white transition hover:bg-brine-700"
                            onClick={() => setReleaseTarget(row)}
                          >
                            放行选泵位
                          </button>
                        </Show>
                        <Show when={row.state === '已排' || row.state === '走水中'}>
                          <button
                            class="rounded-md border border-brine-300 bg-brine-50 px-2.5 py-1 text-xs text-brine-700 transition hover:bg-brine-100"
                            onClick={async () => {
                              const next = await scheduleStore.advance(row.id);
                              if (next === null) scheduleStore.setMessage('该计划暂时不能推进');
                            }}
                          >
                            {nextStateLabel(row.state)}
                          </button>
                          <button class="text-xs text-slate-600 hover:underline" onClick={() => setReassignTarget(row)}>
                            小幅挪动
                          </button>
                        </Show>
                        <Show when={row.state === '已出卤'}>
                          <span class="px-1 text-[11px] text-emerald-600">已出卤，占用照旧</span>
                        </Show>
                        <Show when={row.pumpSlotId !== null && row.state !== '已出卤'}>
                          <button
                            class="text-xs text-amber-700 hover:underline"
                            title="解除泵位归属，退回待排队列重新放行"
                            onClick={async () => {
                              await scheduleStore.returnToQueue(row.id);
                            }}
                          >
                            退回重排
                          </button>
                        </Show>
                        <button class="text-xs text-brine-700 hover:underline" onClick={() => openEdit(row)}>
                          编辑
                        </button>
                        <button class="text-xs text-rose-600 hover:underline" onClick={() => setDeleting(row)}>
                          删除
                        </button>
                      </Show>
                    </div>
                  </li>
                );
              }}
            </For>
          </ul>
        </Show>

        <Show when={ordered().length > 0 && filtered().length === 0}>
          <EmptyPanel
            title="没有符合筛选条件的走水计划"
            description="可以切换池系或状态筛选条件，或直接重置筛选。"
            actionText="重置筛选"
            onAction={() => scheduleStore.resetFilters()}
          />
        </Show>
      </section>

      <ReleaseDialog open={releaseTarget() !== null} schedule={releaseTarget()} onClose={() => setReleaseTarget(null)} />
      <ReassignDialog open={reassignTarget() !== null} schedule={reassignTarget()} onClose={() => setReassignTarget(null)} />

      <AppDialog
        open={dialogOpen()}
        title={editingId() === null ? '新建走水计划' : '编辑走水计划'}
        onClose={() => setDialogOpen(false)}
        footer={
          <>
            <button class={BTN_GHOST} onClick={() => setDialogOpen(false)}>
              取消
            </button>
            <button class={BTN_PRIMARY} onClick={() => void submit()}>
              保存
            </button>
          </>
        }
      >
        <div class="grid gap-3 sm:grid-cols-2">
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>蒸发池</span>
            <select class={INPUT} value={draft.pondId} onChange={(event) => setDraft('pondId', event.currentTarget.value)}>
              <option value="">请选择</option>
              <For each={pondStore.state.ponds}>
                {(pond) => (
                  <option value={pond.id}>
                    {pond.code} · {pond.seriesName} · {pond.stage}
                  </option>
                )}
              </For>
            </select>
          </label>
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>计划走水日期</span>
            <input type="date" class={INPUT} value={draft.planDate} onInput={(event) => setDraft('planDate', event.currentTarget.value)} />
          </label>
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>目标密度（g/cm³）</span>
            <input
              type="number"
              step="0.001"
              class={INPUT}
              value={draft.targetDensity}
              onInput={(event) => setDraft('targetDensity', Number(event.currentTarget.value))}
            />
          </label>
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>计划量（m³）</span>
            <input
              type="number"
              step="10"
              class={INPUT}
              value={draft.volumeM3}
              onInput={(event) => setDraft('volumeM3', Number(event.currentTarget.value))}
            />
          </label>
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>调度员</span>
            <input class={INPUT} value={draft.operator} onInput={(event) => setDraft('operator', event.currentTarget.value)} />
          </label>
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>排序序号（越小越先走水）</span>
            <input
              type="number"
              min="1"
              step="1"
              class={INPUT}
              value={draft.orderIndex}
              onInput={(event) => setDraft('orderIndex', Number(event.currentTarget.value))}
            />
          </label>
        </div>
        <p class="mt-3 rounded-md bg-slate-50 px-3 py-2 text-xs leading-relaxed text-slate-500">
          新建计划一律进「待排」，泵位不在此填写：放行时选当日空泵位，容量不够按池排队顺延。状态推进到「已出卤」会回写池阶段与实际密度。
        </p>
      </AppDialog>

      <AppDialog
        open={deleting() !== null}
        title="确认删除走水计划？"
        width="max-w-lg"
        onClose={() => setDeleting(null)}
        footer={
          <>
            <button class={BTN_GHOST} onClick={() => setDeleting(null)}>
              取消
            </button>
            <button class={BTN_DANGER} onClick={() => void confirmDelete()}>
              确认删除
            </button>
          </>
        }
      >
        <p class="text-sm leading-relaxed text-slate-600">
          将删除「{pondLabel(deleting()?.pondId ?? '')}」在 {deleting()?.planDate} 的走水计划及其泵位时段占用。
        </p>
      </AppDialog>
    </div>
  );
}
