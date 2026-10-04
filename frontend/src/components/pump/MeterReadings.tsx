/**
 * <MeterReadings> 泵房抄表净量录入（泵房维护）
 * 按「池 + 日期」抄起止表底，净量自动 = 止底 − 起底。
 * 调度室（/schedules）只读这些数字，不能改；对账超差时等泵房在此复核。
 */
import { For, Show, createMemo, createSignal } from 'solid-js';
import { createStore } from 'solid-js/store';
import AppDialog from '../common/AppDialog';
import { usePumpStore } from '../../stores/pumpStore';
import { usePondStore } from '../../stores/pondStore';
import type { PumpMeterReading } from '../../types/pumpMeterReading';
import { today } from '../../utils/id';

const INPUT =
  'w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm outline-none focus:border-brine-500 focus:ring-1 focus:ring-brine-400';
const BTN_PRIMARY =
  'rounded-md bg-brine-600 px-3.5 py-1.5 text-sm font-medium text-white transition hover:bg-brine-700 disabled:opacity-50';
const BTN_GHOST =
  'rounded-md border border-slate-300 bg-white px-3.5 py-1.5 text-sm text-slate-700 transition hover:bg-slate-100';
const BTN_DANGER = 'rounded-md bg-rose-600 px-3.5 py-1.5 text-sm font-medium text-white transition hover:bg-rose-700';

function emptyDraft(pondId: string, seriesName: string, positionId: string) {
  return {
    date: today(),
    pondId,
    seriesName,
    positionId,
    startReading: 0,
    endReading: 0,
    reader: '',
    note: '',
  };
}

export default function MeterReadings() {
  const pumpStore = usePumpStore();
  const pondStore = usePondStore();

  const [dialogOpen, setDialogOpen] = createSignal(false);
  const [editingId, setEditingId] = createSignal<string | null>(null);
  const [deleting, setDeleting] = createSignal<PumpMeterReading | null>(null);
  const [draft, setDraft] = createStore(emptyDraft('', '', ''));

  const pondOf = (id: string) => pondStore.state.ponds.find((pond) => pond.id === id) ?? null;
  const pondLabel = (id: string): string => {
    const pond = pondOf(id);
    return pond === null ? '（池已删除）' : `${pond.code} · ${pond.seriesName}`;
  };
  const positionCode = (id: string): string => pumpStore.positionById().get(id)?.code ?? '（泵位已删）';

  /** 抄表只能选同池系的泵位 */
  const positionOptions = createMemo(() => {
    if (draft.seriesName === '') return pumpStore.state.positions;
    return pumpStore.positionsOfSeries(draft.seriesName);
  });

  const netPreview = (): number => Math.round((draft.endReading - draft.startReading) * 10) / 10;

  const openCreate = (): void => {
    const pond = pondStore.state.ponds[0];
    const seriesName = pond?.seriesName ?? '';
    setEditingId(null);
    setDraft(emptyDraft(pond?.id ?? '', seriesName, pumpStore.positionsOfSeries(seriesName)[0]?.id ?? ''));
    setDialogOpen(true);
  };

  const openEdit = (row: PumpMeterReading): void => {
    setEditingId(row.id);
    setDraft({
      date: row.date,
      pondId: row.pondId,
      seriesName: row.seriesName,
      positionId: row.positionId,
      startReading: row.startReading,
      endReading: row.endReading,
      reader: row.reader,
      note: row.note,
    });
    setDialogOpen(true);
  };

  const submit = async (): Promise<void> => {
    if (draft.pondId === '' || draft.positionId === '') return;
    if (editingId() === null) {
      await pumpStore.createReading({ ...draft, netVolumeM3: netPreview() });
    } else {
      await pumpStore.updateReading(editingId() as string, { ...draft, netVolumeM3: netPreview() });
    }
    setDialogOpen(false);
  };

  const confirmDelete = async (): Promise<void> => {
    const row = deleting();
    if (row === null) return;
    await pumpStore.deleteReading(row.id);
    setDeleting(null);
  };

  return (
    <section class="space-y-3 rounded-xl border border-slate-200 bg-white p-4">
      <header class="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 class="text-[15px] font-semibold text-slate-800">泵房抄表净量</h2>
          <p class="mt-0.5 text-xs text-slate-500">按池抄起止表底，净量自动计算；调度室只读不可改，对账超差由泵房在此复核。</p>
        </div>
        <button type="button" class={BTN_PRIMARY} onClick={openCreate} disabled={pondStore.state.ponds.length === 0}>
          + 新增抄表
        </button>
      </header>

      <Show
        when={pumpStore.state.readings.length > 0}
        fallback={<div class="rounded-lg border border-dashed border-brine-200 px-4 py-8 text-center text-sm text-slate-500">还没有抄表记录。</div>}
      >
        <div class="overflow-x-auto">
          <table class="w-full min-w-[980px] text-sm">
            <thead>
              <tr class="border-b border-slate-200 text-left text-xs text-slate-500">
                <th class="px-3 py-2">日期</th>
                <th class="px-3 py-2">送向池</th>
                <th class="px-3 py-2">泵位</th>
                <th class="px-3 py-2 text-right">起底</th>
                <th class="px-3 py-2 text-right">止底</th>
                <th class="px-3 py-2 text-right">净量(m³)</th>
                <th class="px-3 py-2">抄表员</th>
                <th class="px-3 py-2">备注</th>
                <th class="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              <For each={pumpStore.state.readings}>
                {(row) => (
                  <tr class="border-b border-slate-100 hover:bg-slate-50/60">
                    <td class="px-3 py-2 tabular-nums">{row.date}</td>
                    <td class="px-3 py-2">{pondLabel(row.pondId)}</td>
                    <td class="px-3 py-2">{positionCode(row.positionId)}</td>
                    <td class="px-3 py-2 text-right tabular-nums">{row.startReading}</td>
                    <td class="px-3 py-2 text-right tabular-nums">{row.endReading}</td>
                    <td class="px-3 py-2 text-right font-medium tabular-nums text-slate-800">{row.netVolumeM3}</td>
                    <td class="px-3 py-2">{row.reader === '' ? '—' : row.reader}</td>
                    <td class="max-w-[220px] truncate px-3 py-2 text-xs text-slate-500" title={row.note}>
                      {row.note === '' ? '—' : row.note}
                    </td>
                    <td class="px-3 py-2 text-right">
                      <button class="mr-2 text-xs text-brine-700 hover:underline" onClick={() => openEdit(row)}>
                        复核/编辑
                      </button>
                      <button class="text-xs text-rose-600 hover:underline" onClick={() => setDeleting(row)}>
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

      <AppDialog
        open={dialogOpen()}
        title={editingId() === null ? '新增泵房抄表' : '复核 / 编辑抄表'}
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
            <span>抄表日期</span>
            <input type="date" class={INPUT} value={draft.date} onInput={(e) => setDraft('date', e.currentTarget.value)} />
          </label>
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>送向蒸发池</span>
            <select
              class={INPUT}
              value={draft.pondId}
              onChange={(e) => {
                const pond = pondOf(e.currentTarget.value);
                const seriesName = pond?.seriesName ?? '';
                const firstPosition = pumpStore.positionsOfSeries(seriesName)[0]?.id ?? '';
                setDraft({ pondId: e.currentTarget.value, seriesName, positionId: firstPosition });
              }}
            >
              <For each={pondStore.state.ponds}>
                {(pond) => (
                  <option value={pond.id}>
                    {pond.code} · {pond.seriesName}
                  </option>
                )}
              </For>
            </select>
          </label>
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>供水泵位（同池系）</span>
            <select class={INPUT} value={draft.positionId} onChange={(e) => setDraft('positionId', e.currentTarget.value)}>
              <For each={positionOptions()}>
                {(position) => <option value={position.id}>{position.code}</option>}
              </For>
            </select>
          </label>
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>抄表员</span>
            <input class={INPUT} value={draft.reader} onInput={(e) => setDraft('reader', e.currentTarget.value)} />
          </label>
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>起表读数</span>
            <input
              type="number"
              step="1"
              class={INPUT}
              value={draft.startReading}
              onInput={(e) => setDraft('startReading', Number(e.currentTarget.value))}
            />
          </label>
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>止表读数</span>
            <input
              type="number"
              step="1"
              class={INPUT}
              value={draft.endReading}
              onInput={(e) => setDraft('endReading', Number(e.currentTarget.value))}
            />
          </label>
          <label class="flex flex-col gap-1 text-[13px] text-slate-600 sm:col-span-2">
            <span>复核备注</span>
            <input class={INPUT} value={draft.note} onInput={(e) => setDraft('note', e.currentTarget.value)} placeholder="对账超差原因 / 表底修正说明" />
          </label>
        </div>
        <p class="mt-3 rounded-md bg-brine-50 px-3 py-2 text-xs text-brine-800">
          抄表净量（自动）：<span class="tabular-nums font-semibold">{netPreview()}</span> m³
        </p>
      </AppDialog>

      <AppDialog
        open={deleting() !== null}
        title="确认删除抄表记录？"
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
          将删除 {deleting()?.date} 送向「{pondLabel(deleting()?.pondId ?? '')}」的抄表记录（净量 {deleting()?.netVolumeM3} m³），删除后对账将重新判定。
        </p>
      </AppDialog>
    </section>
  );
}
