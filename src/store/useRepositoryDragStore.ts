import { create } from 'zustand';

interface RepositoryDragState {
  isDragging: boolean;
  /** 开始一次仓库卡片拖拽：置位并注册 document 级兜底监听 */
  startDrag: () => void;
  /** 结束拖拽：幂等，移除兜底监听 */
  endDrag: () => void;
}

/**
 * 仓库卡片拖拽中的瞬态状态（不持久化）。
 *
 * 为什么不能只依赖卡片自身的 React onDragEnd：drop 时若源卡片因分类变更
 * 从当前视图卸载，浏览器向已脱离 DOM 的源节点派发 dragend，React 委托在
 * 根容器的合成事件收不到，endDrag 就永远不会执行（issue #353 的根因）。
 * 因此 startDrag 同时注册 document 级原生监听兜底：
 * - dragend（capture）：覆盖源节点仍挂载的正常路径；
 * - mousemove（capture, once）：HTML5 拖拽期间浏览器抑制 mousemove，
 *   拖拽一结束立即恢复派发，即使 dragend 丢失也能可靠清位。
 */
export const useRepositoryDragStore = create<RepositoryDragState>()((set, get) => {
  let cleanupFallback: (() => void) | null = null;

  const endDrag = () => {
    if (cleanupFallback) {
      cleanupFallback();
      cleanupFallback = null;
    }
    if (get().isDragging) {
      set({ isDragging: false });
    }
  };

  return {
    isDragging: false,
    startDrag: () => {
      endDrag();
      set({ isDragging: true });

      const onDragEnd = () => endDrag();
      const onMouseMove = () => endDrag();
      document.addEventListener('dragend', onDragEnd, true);
      document.addEventListener('mousemove', onMouseMove, true);
      cleanupFallback = () => {
        document.removeEventListener('dragend', onDragEnd, true);
        document.removeEventListener('mousemove', onMouseMove, true);
      };
    },
    endDrag,
  };
});
