const tabBarTheme = {
  slots: {
    root: 'scrollbar-none flex h-9 shrink-0 items-end overflow-x-auto border-b border-border bg-canvas pr-[length:var(--window-controls-width,0px)] pl-[length:var(--traffic-light-width,0px)] [-webkit-app-region:drag]',
    list: 'flex h-full items-end',
    item: 'group/tab flex h-full max-w-48 min-w-0 items-center border-r border-border pr-3',
    trigger:
      'flex h-full min-w-0 cursor-pointer touch-manipulation items-center gap-1.5 px-3 text-[11px] transition-colors outline-none select-none focus-visible:ring-1 focus-visible:ring-accent [-webkit-app-region:no-drag]',
    icon: 'size-3 shrink-0 opacity-50',
    label: 'min-w-0 flex-1 truncate',
    close:
      'flex size-6 shrink-0 cursor-pointer touch-manipulation items-center justify-center rounded transition-opacity group-hover/tab:opacity-100 hover:bg-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-panel-focus sm:size-4 [-webkit-app-region:no-drag]',
    closeIcon: 'size-3',
    dirtyDot: 'size-1.5 shrink-0 rounded-full bg-accent',
    newIcon: 'size-3.5',
    // electron-desktop P0（2026-09-07）：hidden titlebar 配套——root 槽
    // [-webkit-app-region:drag] 让整个 tab 栏拖窗口，但按钮（trigger/close/
    // newButton）必须显式标 [-webkit-app-region:no-drag] 否则点击被吞。P214
    // 已登 trigger/close，2026-09-20 续登 newButton：之前 IconButton 未单独
    // 豁免、整栏被拖动吞点，上游 e69ba75c1 删 no-drag 后回归。
    newButton: '[-webkit-app-region:no-drag]'
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
