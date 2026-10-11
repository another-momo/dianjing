const tabBarTheme = {
  slots: {
    // Electron 隐藏标题栏配套：root 槽 [-webkit-app-region:drag] 让整个 tab 栏拖窗口
    // 并为窗口控件/红绿灯留白；栏内按钮（trigger/close/newTab/scroll）必须显式标
    // [-webkit-app-region:no-drag] 否则点击被吞。
    root: 'flex h-9 shrink-0 items-end border-b border-border bg-canvas pr-[length:var(--window-controls-width,0px)] pl-[length:var(--traffic-light-width,0px)] [-webkit-app-region:drag]',
    // Sized by its tabs until the bar runs out of room; then it scrolls and fades the clipped side.
    scroller:
      'scrollbar-none h-full min-w-0 scroll-px-8 overflow-x-auto data-overflow-end:mask-r-from-[calc(100%-2rem)] data-overflow-start:mask-l-from-[calc(100%-2rem)]',
    list: 'flex h-full items-end',
    item: 'group/tab flex h-full max-w-48 min-w-24 items-center border-r border-border pr-3',
    trigger:
      'flex h-full min-w-0 cursor-pointer touch-manipulation items-center gap-1.5 px-3 text-[11px] transition-colors outline-none select-none focus-visible:ring-1 focus-visible:ring-panel-focus [-webkit-app-region:no-drag]',
    icon: 'size-3 shrink-0 opacity-50',
    label: 'min-w-0 flex-1 truncate',
    close:
      'flex size-6 shrink-0 cursor-pointer touch-manipulation items-center justify-center rounded transition-opacity group-hover/tab:opacity-100 hover:bg-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-panel-focus sm:size-4 [-webkit-app-region:no-drag]',
    closeIcon: 'size-3',
    dirtyDot: 'size-1.5 shrink-0 rounded-full bg-accent',
    newTab:
      'flex size-6 shrink-0 cursor-pointer touch-manipulation items-center justify-center self-center rounded text-muted transition-colors outline-none hover:bg-hover hover:text-surface focus-visible:ring-1 focus-visible:ring-panel-focus ms-1.75 [-webkit-app-region:no-drag]',
    newIcon: 'size-4',
    scroll:
      'flex size-6 shrink-0 cursor-pointer touch-manipulation items-center justify-center self-center rounded text-muted transition-colors outline-none hover:bg-hover hover:text-surface focus-visible:ring-1 focus-visible:ring-panel-focus mx-0.5 data-start:order-first [-webkit-app-region:no-drag]',
    scrollIcon: 'size-3.5'
  },
  variants: {
    active: {
      true: {
        item: 'bg-panel text-surface',
        trigger: 'bg-panel text-surface',
        close: 'opacity-100'
      },
      false: {
        item: 'text-muted hover:text-surface',
        trigger: 'text-muted hover:text-surface',
        close: 'opacity-0'
      }
    }
  },
  defaultVariants: {
    active: false
  }
}

export type TabBarTheme = typeof tabBarTheme
export default tabBarTheme
