/**
 * ECharts 只监听 window.resize 无法覆盖 CSS 网格在同一窗口内重排的场景。
 * 统一观察实际宿主容器，并把 resize 延迟到下一帧，确保图表读取的是布局
 * 已稳定后的宽高。保留 window 监听作为不支持 ResizeObserver 的回退。
 */
export function observeChartContainerResize(
  element: HTMLElement,
  resize: () => void,
): () => void {
  let frame: number | undefined;
  const scheduleResize = () => {
    if (frame !== undefined) {
      return;
    }
    frame = window.requestAnimationFrame(() => {
      frame = undefined;
      resize();
    });
  };

  const observer = typeof ResizeObserver === "undefined"
    ? undefined
    : new ResizeObserver(scheduleResize);
  observer?.observe(element);
  window.addEventListener("resize", scheduleResize);
  scheduleResize();

  return () => {
    if (frame !== undefined) {
      window.cancelAnimationFrame(frame);
    }
    observer?.disconnect();
    window.removeEventListener("resize", scheduleResize);
  };
}
