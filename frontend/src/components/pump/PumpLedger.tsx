/**
 * <PumpLedger> 泵组 · 泵位 · 泵位时段账（泵房维护，调度室只读）
 * - 泵组按池系归属，泵位带容量；停泵把靠它排的活动计划退回待排（已出卤照旧）
 * - 泵位时段占用一表只读（改派泵位去走水编排页的「小幅挪动」，不在这里改计划）
 */
import { For, Show, createMemo, createSignal } from 'solid-js';
import { createStore } from 'solid-js/store';
import AppDialog from '../common/AppDialog';
import { usePumpStore } from '../../stores/pumpStore';
import { usePondStore } from '../../stores/pondStore';
import { useScheduleStore } from '../../stores/scheduleStore';
import type { PumpGroup } from '../../types/pumpGroup';
import type { PumpPosition } from '../../types/pumpPosition';
import { PUMP_GROUP_STATUS_OPTIONS } from '../../types/pumpGroup';
import { PUMP_POSITION_STATUS_OPTIONS } from '../../types/pumpPosition';

const INPUT =
  'w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm outline-none focus:border-brine-500 focus:ring-1 focus:ring-brine-400';
const BTN_PRIMARY =
  'rounded-md bg-brine-600 px-3.5 py-1.5 text-sm font-medium text-white transition hover:bg-brine-700 disabled:opacity-50';
const BTN_GHOST =
  'rounded-md border border-slate-300 bg-white px-3.5 py-1.5 text-sm text-slate-700 transition hover:bg-slate-100';
const BTN_DANGER = 'rounded-md bg-rose-600 px-3.5 py-1.5 text-sm font-medium text-white transition hover:bg-rose-700';

const SLOT_STYLE: Record<string, string> = {
  已排: 'border-sky-300 bg-sky-50 text-sky-700',
  走水中: 'border-amber-300 bg-amber-50 text-amber-700',
  已完成: 'border-emerald-300 bg-emerald-50 text-emerald-700',
};

export default function PumpLedger() {
  const pumpStore = usePumpStore();
  const pondStore = usePondStore();
  const scheduleStore = useScheduleStore();

  const [groupDialog, setGroupDialog] = createSignal(false);
  const [editingGroup, setEditingGroup] = createSignal<PumpGroup | null>(null);
  const [posDialog, setPosDialog] = createSignal(false);
  const [editingPos, setEditingPos] = createSignal<PumpPosition | null>(null);
  const [posGroupId, setPosGroupId] = createSignal('');
  const [deletingGroup, setDeletingGroup] = createSignal<PumpGroup | null>(null);
  const [deletingPos, setDeletingPos] = createSignal<PumpPosition | null>(null);

  const [groupDraft, setGroupDraft] = createStore({ code: '', name: '', seriesName: '', master: '', status: '运行' as PumpGroup['status'] });
  const [posDraft, setPosDraft] = createStore({ code: '', capacityM3: 1000, status: '运行' as PumpPosition['status'], note: '' });

  const pondCode = (pondId: string): string => pondStore.state.ponds.find((pond) => pond.id === pondId)?.code ?? '（池已删）';

  /** 泵位 → 当日活动计划，用于在泵位卡里提示占用 */
  const activeScheduleOfPosition = createMemo(() => {
    const map = new Map<string, string>();
    pumpStore.state.slots.forEach((slot) => {
      if (slot.state === '已完成') return;
      map.set(slot.positionId, slot.scheduleId);
    });
    return map;
  });

  const scheduleById = (id: string) => scheduleStore.state.rows.find((row) => row.id === id) ?? null;

  const openCreateGroup = (): void => {
    setEditingGroup(null);
    setGroupDraft({
      code: '',
      name: '',
      seriesName: pondStore.seriesOptions()[0] ?? '',
      master: '',
      status: '运行',
    });
    setGroupDialog(true);
  };

  const openEditGroup = (group: PumpGroup): void => {
    setEditingGroup(group);
    setGroupDraft({ code: group.code, name: group.name, seriesName: group.seriesName, master: group.master, status: group.status });
    setGroupDialog(true);
  };

  const submitGroup = async (): Promise<void> => {
    if (groupDraft.seriesName === '') return;
    if (editingGroup() === null) {
      await pumpStore.createGroup({ ...groupDraft });
    } else {
      await pumpStore.updateGroup((editingGroup() as PumpGroup).id, { ...groupDraft });
    }
    setGroupDialog(false);
  };

  const openCreatePos = (groupId: string): void => {
    setEditingPos(null);
    setPosGroupId(groupId);
    setPosDraft({ code: '', capacityM3: 1000, status: '运行', note: '' });
    setPosDialog(true);
  };

  const openEditPos = (position: PumpPosition): void => {
    setEditingPos(position);
    setPosGroupId(position.groupId);
    setPosDraft({ code: position.code, capacityM3: position.capacityM3, status: position.status, note: position.note });
    setPosDialog(true);
  };

  const submitPos = async (): Promise<void> => {
    if (posGroupId() === '') return;
    if (editingPos() === null) {
      await pumpStore.createPosition({ groupId: posGroupId(), ...posDraft });
    } else {
      const current = editingPos() as PumpPosition;
      // 编辑表单里直接置为停用，与「停泵退回」等效：活动计划退回待排，已出卤照旧
      if (current.status === '运行' && posDraft.status === '停用') {
        await pumpStore.updatePosition(current.id, { groupId: posGroupId(), ...posDraft });
        await pumpStore.stopPosition(current.id);
      } else {
        await pumpStore.updatePosition(current.id, { groupId: posGroupId(), ...posDraft });
      }
    }
    setPosDialog(false);
  };

  return (
    <section class="space-y-3 rounded-xl border border-slate-200 bg-white p-4">
      <header class="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 class="text-[15px] font-semibold text-slate-800">泵组与泵位账</h2>
          <p class="mt-0.5 text-xs text-slate-500">泵组按池系归属；容量是放行的硬约束。停泵会把靠它排的活动计划退回待排，已出卤的照旧留底。</p>
        </div>
        <button type="button" class={BTN_PRIMARY} onClick={openCreateGroup} disabled={pondStore.seriesOptions().length === 0}>
          + 新建泵组
        </button>
      </header>

      <div class="grid gap-3 lg:grid-cols-2">
        <For each={pumpStore.state.groups}>
          {(group) => {
            const positions = () => pumpStore.positionsOfGroup(group.id);
            return (
              <div class="rounded-lg border border-slate-200">
                <div class="flex flex-wrap items-center justify-between gap-2 rounded-t-lg border-b border-slate-200 bg-slate-50 px-3.5 py-2.5">
                  <div>
                    <p class="text-sm font-semibold text-slate-800">
                      {group.code} · {group.name}
                    </p>
                    <p class="text-xs text-slate-500">
                      {group.seriesName} · 负责人 {group.master === '' ? '未填' : group.master}
                    </p>
                  </div>
                  <div class="flex items-center gap-2">
                    <span
                      class={`rounded border px-2 py-0.5 text-[11px] ${
                        group.status === '运行'
                          ? 'border-emerald-300 bg-emerald-50 text-emerald-700'
                          : 'border-slate-300 bg-slate-100 text-slate-600'
                      }`}
                    >
                      {group.status}
                    </span>
                    <button class="text-xs text-brine-700 hover:underline" onClick={() => openEditGroup(group)}>
                      编辑
                    </button>
                    <button class="text-xs text-rose-600 hover:underline" onClick={() => setDeletingGroup(group)}>
                      删除
                    </button>
                  </div>
                </div>

                <ul class="divide-y divide-slate-100">
                  <For each={positions()}>
                    {(position) => {
                      const scheduleId = () => activeScheduleOfPosition().get(position.id) ?? null;
                      const occupied = () => scheduleById(scheduleId() ?? '');
                      return (
                        <li class="flex flex-wrap items-center gap-3 px-3.5 py-2.5">
                          <div class="min-w-[150px] flex-1">
                            <p class="text-sm font-medium text-slate-800">{position.code}</p>
                            <p class="text-xs text-slate-500">
                              容量 <span class="tabular-nums">{position.capacityM3}</span> m³ · {position.note === '' ? '无备注' : position.note}
                            </p>
                          </div>
                          <Show when={occupied() !== null && position.status === '运行'}>
                            <span class="rounded border border-amber-300 bg-amber-50 px-2 py-0.5 text-[11px] text-amber-700">
                              {occupied()?.planDate} 占用于 {pondCode(occupied()?.pondId ?? '')}
                            </span>
                          </Show>
                          <span
                            class={`rounded border px-2 py-0.5 text-[11px] ${
                              position.status === '运行'
                                ? 'border-emerald-300 bg-emerald-50 text-emerald-700'
                                : 'border-slate-300 bg-slate-100 text-slate-600'
                            }`}
                          >
                            {position.status}
                          </span>
                          <div class="flex flex-wrap items-center gap-2">
                            <Show
                              when={position.status === '运行'}
                              fallback={
                                <button class="text-xs text-emerald-700 hover:underline" onClick={() => void pumpStore.startPosition(position.id)}>
                                  启泵
                                </button>
                              }
                            >
                              <button class="text-xs text-amber-700 hover:underline" onClick={() => void pumpStore.stopPosition(position.id)}>
                                停泵退回
                              </button>
                            </Show>
                            <button class="text-xs text-brine-700 hover:underline" onClick={() => openEditPos(position)}>
                              编辑
                            </button>
                            <button class="text-xs text-rose-600 hover:underline" onClick={() => setDeletingPos(position)}>
                              删除
                            </button>
                          </div>
                        </li>
                      );
                    }}
                  </For>
                  <li class="px-3.5 py-2">
                    <button class="text-xs text-brine-700 hover:underline" onClick={() => openCreatePos(group.id)}>
                      + 新增泵位
                    </button>
                  </li>
                </ul>
              </div>
            );
          }}
        </For>
      </div>

      <Show when={pumpStore.state.groups.length === 0}>
        <div class="rounded-lg border border-dashed border-brine-200 bg-white px-4 py-8 text-center text-sm text-slate-500">
          还没有泵组，先按池系新建泵组并在其下登记泵位与容量。
        </div>
      </Show>

      {/* 泵位时段占用（只读） */}
      <div class="rounded-lg border border-slate-200">
        <div class="border-b border-slate-200 bg-slate-50 px-3.5 py-2">
          <h3 class="text-[13px] font-semibold text-slate-700">泵位时段占用（只读）</h3>
        </div>
        <Show
          when={pumpStore.state.slots.length > 0}
          fallback={<p class="px-3.5 py-4 text-center text-xs text-slate-400">暂无占用，调度放行后自动登记。</p>}
        >
          <div class="overflow-x-auto">
            <table class="w-full min-w-[760px] text-sm">
              <thead>
                <tr class="border-b border-slate-200 text-left text-xs text-slate-500">
                  <th class="px-3 py-2">日期</th>
                  <th class="px-3 py-2">池系</th>
                  <th class="px-3 py-2">泵位</th>
                  <th class="px-3 py-2">送向池</th>
                  <th class="px-3 py-2 text-right">时段水量(m³)</th>
                  <th class="px-3 py-2 text-right">槽次</th>
                  <th class="px-3 py-2">状态</th>
                </tr>
              </thead>
              <tbody>
                <For each={pumpStore.state.slots}>
                  {(slot) => (
                    <tr class="border-b border-slate-100">
                      <td class="px-3 py-2 tabular-nums">{slot.planDate}</td>
                      <td class="px-3 py-2 text-xs text-slate-500">{slot.seriesName}</td>
                      <td class="px-3 py-2">{pumpStore.positionById().get(slot.positionId)?.code ?? '（泵位已删）'}</td>
                      <td class="px-3 py-2">{pondCode(scheduleById(slot.scheduleId)?.pondId ?? '')}</td>
                      <td class="px-3 py-2 text-right tabular-nums">{slot.volumeM3}</td>
                      <td class="px-3 py-2 text-right tabular-nums">{slot.slotIndex}</td>
                      <td class="px-3 py-2">
                        <span class={`rounded border px-2 py-0.5 text-[11px] ${SLOT_STYLE[slot.state]}`}>{slot.state}</span>
                      </td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </div>
        </Show>
      </div>

      {/* 泵组编辑 */}
      <AppDialog
        open={groupDialog()}
        title={editingGroup() === null ? '新建泵组' : '编辑泵组'}
        onClose={() => setGroupDialog(false)}
        footer={
          <>
            <button class={BTN_GHOST} onClick={() => setGroupDialog(false)}>
              取消
            </button>
            <button class={BTN_PRIMARY} onClick={() => void submitGroup()}>
              保存
            </button>
          </>
        }
      >
        <div class="grid gap-3 sm:grid-cols-2">
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>泵组编号</span>
            <input class={INPUT} value={groupDraft.code} onInput={(e) => setGroupDraft('code', e.currentTarget.value)} />
          </label>
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>泵组名称</span>
            <input class={INPUT} value={groupDraft.name} onInput={(e) => setGroupDraft('name', e.currentTarget.value)} />
          </label>
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>归属池系</span>
            <select class={INPUT} value={groupDraft.seriesName} onChange={(e) => setGroupDraft('seriesName', e.currentTarget.value)}>
              <For each={pondStore.seriesOptions()}>
                {(series) => <option value={series}>{series}</option>}
              </For>
            </select>
          </label>
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>负责人</span>
            <input class={INPUT} value={groupDraft.master} onInput={(e) => setGroupDraft('master', e.currentTarget.value)} />
          </label>
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>状态</span>
            <select class={INPUT} value={groupDraft.status} onChange={(e) => setGroupDraft('status', e.currentTarget.value as PumpGroup['status'])}>
              <For each={PUMP_GROUP_STATUS_OPTIONS}>{(status) => <option value={status}>{status}</option>}</For>
            </select>
          </label>
        </div>
      </AppDialog>

      {/* 泵位编辑 */}
      <AppDialog
        open={posDialog()}
        title={editingPos() === null ? '新建泵位' : '编辑泵位'}
        onClose={() => setPosDialog(false)}
        footer={
          <>
            <button class={BTN_GHOST} onClick={() => setPosDialog(false)}>
              取消
            </button>
            <button class={BTN_PRIMARY} onClick={() => void submitPos()}>
              保存
            </button>
          </>
        }
      >
        <div class="grid gap-3 sm:grid-cols-2">
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>所属泵组</span>
            <select class={INPUT} value={posGroupId()} onChange={(e) => setPosGroupId(e.currentTarget.value)}>
              <For each={pumpStore.state.groups}>
                {(group) => <option value={group.id}>{group.name}</option>}
              </For>
            </select>
          </label>
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>泵位编号</span>
            <input class={INPUT} value={posDraft.code} onInput={(e) => setPosDraft('code', e.currentTarget.value)} />
          </label>
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>单次容量上限（m³）</span>
            <input
              type="number"
              step="50"
              min="0"
              class={INPUT}
              value={posDraft.capacityM3}
              onInput={(e) => setPosDraft('capacityM3', Number(e.currentTarget.value))}
            />
          </label>
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>状态（停用后不能挂计划）</span>
            <select class={INPUT} value={posDraft.status} onChange={(e) => setPosDraft('status', e.currentTarget.value as PumpPosition['status'])}>
              <For each={PUMP_POSITION_STATUS_OPTIONS}>{(status) => <option value={status}>{status}</option>}</For>
            </select>
          </label>
          <label class="flex flex-col gap-1 text-[13px] text-slate-600 sm:col-span-2">
            <span>备注</span>
            <input class={INPUT} value={posDraft.note} onInput={(e) => setPosDraft('note', e.currentTarget.value)} placeholder="检修 / 备用 / 主走水" />
          </label>
        </div>
        <Show when={editingPos() !== null && (editingPos() as PumpPosition).status === '运行' && posDraft.status === '停用'}>
          <p class="mt-3 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-700">
            保存停用后，靠该泵位排的活动计划会立即退回「待排」，等调度员重排；已出卤的历史占用保留。
          </p>
        </Show>
      </AppDialog>

      {/* 删除泵组确认 */}
      <AppDialog
        open={deletingGroup() !== null}
        title="确认删除泵组？"
        width="max-w-lg"
        onClose={() => setDeletingGroup(null)}
        footer={
          <>
            <button class={BTN_GHOST} onClick={() => setDeletingGroup(null)}>
              取消
            </button>
            <button
              class={BTN_DANGER}
              onClick={async () => {
                const group = deletingGroup();
                if (group !== null) await pumpStore.deleteGroup(group.id);
                setDeletingGroup(null);
              }}
            >
              确认删除
            </button>
          </>
        }
      >
        <p class="text-sm leading-relaxed text-slate-600">
          将删除泵组「{deletingGroup()?.name}」及其全部泵位；靠这些泵位排的活动计划会退回待排等调度员重排，已出卤的历史占用照旧保留。
        </p>
      </AppDialog>

      {/* 删除泵位确认 */}
      <AppDialog
        open={deletingPos() !== null}
        title="确认删除泵位？"
        width="max-w-lg"
        onClose={() => setDeletingPos(null)}
        footer={
          <>
            <button class={BTN_GHOST} onClick={() => setDeletingPos(null)}>
              取消
            </button>
            <button
              class={BTN_DANGER}
              onClick={async () => {
                const position = deletingPos();
                if (position !== null) await pumpStore.deletePosition(position.id);
                setDeletingPos(null);
              }}
            >
              确认删除
            </button>
          </>
        }
      >
        <p class="text-sm leading-relaxed text-slate-600">
          将删除泵位「{deletingPos()?.code}」；靠它排的活动计划会退回待排等调度员重排，已出卤的历史占用照旧保留。
        </p>
      </AppDialog>
    </section>
  );
}
