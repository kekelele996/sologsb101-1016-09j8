/**
 * <ReassignDialog> 泵位小幅挪动弹层（泵房改派 / 调度确认）
 * 只换占用指向的泵位，不打回计划：状态、排序与队列位置都保持不变。
 * 目标必须是当日空着的运行泵位；停用泵位不出现在这里（停用走「停泵退回」流程）。
 */
import { For, Show } from 'solid-js';
import AppDialog from '../common/AppDialog';
import { usePondStore } from '../../stores/pondStore';
import { usePumpStore } from '../../stores/pumpStore';
import { useScheduleStore } from '../../stores/scheduleStore';
import type { Schedule } from '../../types/schedule';

export interface ReassignDialogProps {
  open: boolean;
  schedule: Schedule | null;
  onClose: () => void;
}

export default function ReassignDialog(props: ReassignDialogProps) {
  const pondStore = usePondStore();
  const pumpStore = usePumpStore();
  const scheduleStore = useScheduleStore();

  const candidates = () => {
    const schedule = props.schedule;
    if (schedule === null || schedule.pumpSlotId === null) return [];
    const currentSlot = pumpStore.state.slots.find((slot) => slot.id === schedule.pumpSlotId);
    return scheduleStore.releaseOptions(schedule).filter((option) => option.id !== currentSlot?.positionId);
  };

  const currentPositionCode = (): string => {
    const schedule = props.schedule;
    if (schedule === null || schedule.pumpSlotId === null) return '—';
    const slot = pumpStore.state.slots.find((item) => item.id === schedule.pumpSlotId);
    return slot === undefined ? '—' : pumpStore.positionById().get(slot.positionId)?.code ?? '—';
  };

  const pondLabel = (pondId: string): string => {
    const pond = pondStore.state.ponds.find((item) => item.id === pondId);
    return pond === undefined ? '（池已删除）' : `${pond.code} · ${pond.seriesName}`;
  };

  const submit = async (positionId: string): Promise<void> => {
    if (props.schedule === null) return;
    await scheduleStore.reassign(props.schedule.id, positionId);
    props.onClose();
  };

  return (
    <AppDialog
      open={props.open}
      title="泵位小幅挪动（不打回计划）"
      width="max-w-xl"
      onClose={props.onClose}
      footer={
        <button class="rounded-md border border-slate-300 bg-white px-3.5 py-1.5 text-sm text-slate-700 transition hover:bg-slate-100" onClick={props.onClose}>
          关闭
        </button>
      }
    >
      <Show when={props.schedule !== null && props.schedule !== undefined}>
        {
          /* @__PURE__ */ (() => {
            const s = () => props.schedule as Schedule;
            return (
            <div class="space-y-3">
              <div class="rounded-md bg-slate-50 px-3 py-2 text-xs leading-relaxed text-slate-600">
                <p>
                  {pondLabel(s().pondId)} · {s().planDate} · {s().volumeM3} m³
                </p>
                <p class="mt-1">
                  当前泵位：<span class="font-medium text-slate-800">{currentPositionCode()}</span>，计划状态保持「{s().state}」不变。
                </p>
              </div>
              <Show
                when={candidates().length > 0}
                fallback={
                  <div class="rounded-lg border border-dashed border-slate-300 bg-slate-50 px-4 py-5 text-center text-sm text-slate-500">
                    当日同池系没有其他空着的运行泵位；若该泵位要停用，请在泵房页「停泵」，靠它排的计划会退回待排。
                  </div>
                }
              >
                <ul class="space-y-2">
                  <For each={candidates()}>
                    {(option) => (
                      <li class="flex flex-wrap items-center gap-3 rounded-lg border border-slate-200 px-3.5 py-2.5">
                        <div class="min-w-[150px] flex-1">
                          <p class="text-sm font-medium text-slate-800">{option.code}</p>
                          <p class="text-xs text-slate-500">{option.note === '' ? '无备注' : option.note}</p>
                        </div>
                        <p class="text-xs text-slate-600">
                          容量 <span class="tabular-nums font-medium text-slate-800">{option.capacityM3}</span> m³
                        </p>
                        <Show when={option.shortfallM3 > 0}>
                          <span class="rounded border border-amber-300 bg-amber-50 px-2 py-0.5 text-[11px] text-amber-700">
                            缺口 {option.shortfallM3} m³
                          </span>
                        </Show>
                        <button
                          class="rounded-md border border-brine-300 bg-brine-50 px-3 py-1 text-xs text-brine-700 transition hover:bg-brine-100"
                          onClick={() => void submit(option.id)}
                        >
                          挪到该泵位
                        </button>
                      </li>
                    )}
                  </For>
                </ul>
              </Show>
            </div>
            );
          })()
        }
      </Show>
    </AppDialog>
  );
}
