/**
 * /pumps 泵房账（泵房角色）
 * 泵组、泵位、泵位时段与抄表净量都归这里维护；调度室（/schedules）只读这些数据。
 * 消费模型：PumpGroup、PumpPosition、PumpSlot、PumpMeterReading、Schedule、Pond；
 * 复用组件：<PumpLedger>、<MeterReadings>、<ReconcilePanel>
 */
import { Show, onMount } from 'solid-js';
import { usePondStore } from '../stores/pondStore';
import { usePumpStore } from '../stores/pumpStore';
import PumpLedger from '../components/pump/PumpLedger';
import MeterReadings from '../components/pump/MeterReadings';
import ReconcilePanel from '../components/pump/ReconcilePanel';

export default function PumpRoom() {
  const pondStore = usePondStore();
  const pumpStore = usePumpStore();

  onMount(() => {
    void pondStore.loadAll();
  });

  return (
    <div class="space-y-3.5">
      <Show when={pumpStore.state.lastMessage !== ''}>
        <div class="rounded-lg border border-brine-200 bg-brine-50 px-3.5 py-2 text-sm text-brine-800">
          {pumpStore.state.lastMessage}
        </div>
      </Show>

      <Show when={pumpStore.state.error !== ''}>
        <div class="rounded-lg border border-rose-200 bg-rose-50 px-3.5 py-2 text-sm text-rose-700">
          泵房账读取失败：{pumpStore.state.error}
        </div>
      </Show>

      <PumpLedger />
      <MeterReadings />
      <ReconcilePanel />
    </div>
  );
}
