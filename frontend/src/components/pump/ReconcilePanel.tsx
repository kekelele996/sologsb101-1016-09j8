/**
 * <ReconcilePanel> 按池对账（调度室 + 泵房共看，数字只摆不改）
 * 计划量之和（已放行、非待排）与泵房抄表净量按池比对：
 * - 容差内 → 平
 * - 超容差 → 超差，把两边数字与差额摆出来，等泵房在「抄表净量」里复核（调度员动不了抄表）
 * - 有计划无抄表 → 缺抄表
 */
import { For, Show, createMemo } from 'solid-js';
import StatBadge from '../common/StatBadge';
import { usePondStore } from '../../stores/pondStore';
import { usePumpStore } from '../../stores/pumpStore';
import { useScheduleStore } from '../../stores/scheduleStore';
import { RECONCILE_TOLERANCE_M3, reconcileByPond, type ReconcileStatus } from '../../utils/pump';

const STATUS_STYLE: Record<ReconcileStatus, string> = {
  平: 'border-emerald-300 bg-emerald-50 text-emerald-700',
  超差: 'border-rose-300 bg-rose-50 text-rose-700',
  缺抄表: 'border-amber-300 bg-amber-50 text-amber-700',
};

export default function ReconcilePanel() {
  const pondStore = usePondStore();
  const pumpStore = usePumpStore();
  const scheduleStore = useScheduleStore();

  const items = createMemo(() =>
    reconcileByPond(
      scheduleStore.state.rows,
      pumpStore.state.readings,
      (pondId) => pondStore.state.ponds.find((pond) => pond.id === pondId)?.seriesName ?? '（未知池系）',
    ),
  );

  const stats = createMemo(() => {
    const list = items();
    return {
      total: list.length,
      ok: list.filter((item) => item.status === '平').length,
      over: list.filter((item) => item.status === '超差').length,
      missing: list.filter((item) => item.status === '缺抄表').length,
    };
  });

  const pondCode = (pondId: string): string => pondStore.state.ponds.find((pond) => pond.id === pondId)?.code ?? '（池已删）';

  return (
    <section class="space-y-3 rounded-xl border border-slate-200 bg-white p-4">
      <header>
        <h2 class="text-[15px] font-semibold text-slate-800">按池对账（计划量 vs 泵房抄表净量）</h2>
        <p class="mt-0.5 text-xs text-slate-500">
          容差 ±{RECONCILE_TOLERANCE_M3} m³；超差只摆数字等泵房复核，调度员不能修改泵房抄表。待排计划未占用泵位，不计入计划量。
        </p>
      </header>

      <div class="flex flex-wrap gap-3">
        <StatBadge label="对账池数" value={stats().total} suffix="口" tone="primary" size="sm" />
        <StatBadge label="平" value={stats().ok} suffix="口" tone="success" size="sm" />
        <StatBadge label="超差待复核" value={stats().over} suffix="口" tone="danger" size="sm" />
        <StatBadge label="缺抄表" value={stats().missing} suffix="口" tone="warning" size="sm" />
      </div>

      <Show
        when={items().length > 0}
        fallback={<div class="rounded-lg border border-dashed border-brine-200 px-4 py-8 text-center text-sm text-slate-500">暂无已放行计划，放行并抄表后自动按池对账。</div>}
      >
        <div class="overflow-x-auto">
          <table class="w-full min-w-[900px] text-sm">
            <thead>
              <tr class="border-b border-slate-200 text-left text-xs text-slate-500">
                <th class="px-3 py-2">池号</th>
                <th class="px-3 py-2">池系</th>
                <th class="px-3 py-2 text-right">已放行计划数</th>
                <th class="px-3 py-2 text-right">计划量之和(m³)</th>
                <th class="px-3 py-2 text-right">抄表条数</th>
                <th class="px-3 py-2 text-right">抄表净量(m³)</th>
                <th class="px-3 py-2 text-right">差额(m³)</th>
                <th class="px-3 py-2">对账</th>
              </tr>
            </thead>
            <tbody>
              <For each={items()}>
                {(item) => (
                  <tr class={`border-b border-slate-100 ${item.status === '超差' ? 'bg-rose-50/40' : ''}`}>
                    <td class="px-3 py-2 font-medium text-slate-800">{pondCode(item.pondId)}</td>
                    <td class="px-3 py-2 text-xs text-slate-500">{item.seriesName}</td>
                    <td class="px-3 py-2 text-right tabular-nums">{item.scheduleCount}</td>
                    <td class="px-3 py-2 text-right tabular-nums">{item.planVolumeM3}</td>
                    <td class="px-3 py-2 text-right tabular-nums">{item.readingCount}</td>
                    <td class="px-3 py-2 text-right tabular-nums">{item.netVolumeM3}</td>
                    <td
                      class={`px-3 py-2 text-right tabular-nums font-semibold ${
                        item.status === '超差' ? 'text-rose-700' : item.status === '缺抄表' ? 'text-amber-700' : 'text-slate-800'
                      }`}
                    >
                      {item.status === '缺抄表' ? '—' : item.diffM3 > 0 ? `+${item.diffM3}` : item.diffM3}
                    </td>
                    <td class="px-3 py-2">
                      <span class={`rounded border px-2 py-0.5 text-[11px] ${STATUS_STYLE[item.status]}`}>
                        {item.status === '超差' ? '超差·等泵房复核' : item.status}
                      </span>
                    </td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </div>
      </Show>

      <p class="text-[11px] leading-relaxed text-slate-400">
        差额 = 计划量之和 − 抄表净量：正数表示抄表偏少，负数表示抄表偏多；超过 ±{RECONCILE_TOLERANCE_M3} m³ 即标红等泵房复核表底。
      </p>
    </section>
  );
}
