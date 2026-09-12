import { beforeEach, describe, expect, it } from 'vitest';
import { useRepositoryDragStore } from './useRepositoryDragStore';

const dispatchDragEnd = () => document.dispatchEvent(new Event('dragend'));
const dispatchMouseMove = () => document.dispatchEvent(new Event('mousemove'));

describe('useRepositoryDragStore', () => {
  beforeEach(() => {
    useRepositoryDragStore.getState().endDrag();
  });

  it('startDrag 置位拖拽状态', () => {
    useRepositoryDragStore.getState().startDrag();
    expect(useRepositoryDragStore.getState().isDragging).toBe(true);
  });

  it('document 级 dragend 兜底清除拖拽状态', () => {
    useRepositoryDragStore.getState().startDrag();
    dispatchDragEnd();
    expect(useRepositoryDragStore.getState().isDragging).toBe(false);
  });

  it('document 级 mousemove 兜底清除拖拽状态（dragend 丢失时的恢复路径）', () => {
    useRepositoryDragStore.getState().startDrag();
    dispatchMouseMove();
    expect(useRepositoryDragStore.getState().isDragging).toBe(false);
  });

  it('endDrag 幂等，重复调用安全', () => {
    const state = useRepositoryDragStore.getState();
    state.startDrag();
    state.endDrag();
    state.endDrag();
    expect(useRepositoryDragStore.getState().isDragging).toBe(false);
  });

  it('重复 startDrag 不叠加监听：一次 dragend 即可清位', () => {
    const state = useRepositoryDragStore.getState();
    state.startDrag();
    state.startDrag();
    dispatchDragEnd();
    expect(useRepositoryDragStore.getState().isDragging).toBe(false);
    // 清位后兜底监听已全部移除，后续事件不再影响状态
    state.startDrag();
    expect(useRepositoryDragStore.getState().isDragging).toBe(true);
    state.endDrag();
  });
});
