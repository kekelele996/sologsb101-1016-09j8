/**
 * <ReleaseDialog> 放行选泵位弹层（调度室）
 * 放行前先看哪个泵位空着：列出当日同池系中空着的运行泵位与容量差额；
 * 容量够直接放行，不够可一键按池排队顺延（差额写在计划上）。
 */
import { For, Show } from 'solid-js';
import AppDialog from '../common/AppDialog';
import { usePondStore } from '../../stores/pondStore';
import { usePumpStore } from '../../stores/pumpStore';
import { useScheduleStore } from '../../stores/scheduleStore';
import { releaseCapacity } from '../../utils/pump';
import type { Schedule } from '../../types/schedule';

export interface ReleaseDialogProps {
  open: boolean;
  schedule: Schedule | null;
  onClose: () => void;
}

export default function ReleaseDialog(props: ReleaseDialogProps) {
  const pondStore = usePondStore();
  const pumpStore = usePumpStore();
  const scheduleStore = useScheduleStore();

  const pondLabel = (pondId: string): string => {
    const pond = pondStore.state.ponds.find((item) => item.id === pondId);
    return pond === undefined ? '（池已删除）' : `${pond.code} · ${pond.seriesName}`;
  };

  const options = () => (props.schedule === null ? [] : scheduleStore.releaseOptions(props.schedule));
  const capacity = () => releaseCapacity(options());

  const release = async (positionId: string): Promise<void> => {
    if (props.schedule === null) return;
    await scheduleStore.release(props.schedule.id, positionId);
    props.onClose();
  };

  const defer = async (): Promise<void> => {
    if (props.schedule === null) return;
    await scheduleStore.defer(props.schedule.id);
    props.onClose();
  };

  return (
    <AppDialog
      open={props.open}
      title="放行前选择泵位"
      width="max-w-2xl"
      onClose={props.onClose}
      footer={
        <>
          <button
            class="rounded-md border border-amber-300 bg-amber-50 px-3.5 py-1.5 text-sm font-medium text-amber-700 transition hover:bg-amber-100 disabled:opacity-50"
            disabled={props.schedule === null || capacity().canRelease}
            title={capacity().canRelease ? '有空泵位容量足够，无需顺延' : '按池排队顺延，差额写在计划上'}
            onClick={() => void defer()}
          >
            容量不够，按池排队顺延
          </button>
          <button class="rounded-md border border-slate-300 bg-white px-3.5 py-1.5 text-sm text-slate-700 transition hover:bg-slate-100" onClick={props.onClose}>
            取消
          </button>
        </>
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
                    {pondLabel(s().pondId)} · 计划日期 <span class="font-medium text-slate-800">{s().planDate}</span> · 计划量{' '}
                    <span class="font-medium text-slate-800">{s().volumeM3} m³</span>
                  </p>
                  <Show when={s().shortfallM3 > 0}>
                    <p class="mt-1 text-amber-700">上次顺延记录的容量缺口：{s().shortfallM3} m³</p>
                  </Show>
                </div>

                <Show
                  when={options().length > 0}
                  fallback={
                    <div class="rounded-lg border border-dashed border-amber-300 bg-amber-50 px-4 py-5 text-center text-sm text-amber-700">
                      当日该池系没有空着的运行泵位，可按池排队顺延，等泵房停泵改派或腾出泵位后再放行。
                    </div>
                  }
                >
                  <ul class="space-y-2">
                    <For each={options()}>
                      {(option) => (
                        <li class="flex flex-wrap items-center gap-3 rounded-lg border border-slate-200 px-3.5 py-2.5">
                          <div class="min-w-[160px] flex-1">
                            <p class="text-sm font-medium text-slate-800">{option.code}</p>
                            <p class="text-xs text-slate-500">
                              {pumpStore.groupOf(option.id)?.name ?? '未分组'} · {option.note === '' ? '无备注' : option.note}
                            </p>
                          </div>
                          <p class="text-xs text-slate-600">
                            容量 <span class="tabular-nums font-medium text-slate-800">{option.capacityM3}</span> m³
                          </p>
                          <Show
                            when={option.shortfallM3 === 0}
                            fallback={
                              <span
                                class="rounded border border-amber-300 bg-amber-50 px-2 py-0.5 text-[11px] text-amber-700"
                                title="容量不足不能放行，请用下方「按池排队顺延」；强行换小泵属于泵位小幅挪动"
                              >
                                缺口 {option.shortfallM3} m³·须顺延
                              </span>
                            }
                          >
                            <span class="rounded border border-emerald-300 bg-emerald-50 px-2 py-0.5 text-[11px] text-emerald-700">
                              容量够
                            </span>
                          </Show>
                          <Show when={option.shortfallM3 === 0}>
                            <button
                              class="rounded-md bg-brine-600 px-3 py-1 text-xs font-medium text-white transition hover:bg-brine-700"
                              onClick={() => void release(option.id)}
                            >
                              放行到该泵位
                            </button>
                          </Show>
                        </li>
                      )}
                    </For>
                  </ul>
                </Show>

                <p class="text-[11px] leading-relaxed text-slate-400">
                  泵位账归泵房：同一泵位同一天只放一条走水计划；泵房停泵或改派泵位会把计划退回待排，已出卤的历史占用照旧保留。
                </p>
              </div>
            );
          })()
        }
      </Show>
    </AppDialog>
  );
}
