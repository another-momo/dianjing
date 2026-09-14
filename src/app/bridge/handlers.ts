import type { FigmaAPI } from '@open-pencil/core/figma-api'

import { createAutomationEvalHandler } from '@/app/bridge/eval-handler'
import { handleExport, handleExportJSX } from '@/app/bridge/export-handlers'
import { handleNewDocument, handleOpenFile, handleSaveFile } from '@/app/bridge/file-handlers'
import { handleRPCFallback } from '@/app/bridge/rpc-handler'
import { handleSelection } from '@/app/bridge/selection-handler'
import {
  isUnknownRecord,
  listAutomationDocuments,
  resolveAutomationTarget,
  responseWithTarget,
  stripAutomationTargetArgs
} from '@/app/bridge/target'
import { createAutomationToolHandler } from '@/app/bridge/tool-handlers'
import type { EditorStore } from '@/app/editor/active-store'

type FigmaFactory = (store: EditorStore, pageId?: string) => FigmaAPI

type CommandHandler = (
  target: ReturnType<typeof resolveAutomationTarget>,
  args: unknown
) => Promise<unknown>

export function createAutomationCommandHandlers(makeFigma: FigmaFactory) {
  const handleEval = createAutomationEvalHandler(makeFigma)
  const { handleTool, handleUndoGroup } = createAutomationToolHandler(makeFigma)

  const commandHandlers: Partial<Record<string, CommandHandler>> = {
    eval: handleEval,
    tool: handleTool,
    // T59：AI 回合撤销组边界（begin/end），pi service 每回合各发一次
    undo_group: handleUndoGroup,
    export: handleExport,
    export_jsx: handleExportJSX,
    selection: handleSelection,
    save_file: handleSaveFile,
    new_document: handleNewDocument,
    open_file: handleOpenFile
  }

  async function handleRequest(
    store: EditorStore,
    command: string,
    args: unknown
  ): Promise<unknown> {
    if (command === 'list_documents') {
      return { ok: true, result: { documents: listAutomationDocuments(store) } }
    }

    if (command === 'open_file' || command === 'new_document') {
      const handler = commandHandlers[command]
      if (handler) return handler(resolveAutomationTarget(store, undefined), args)
    }

    const rawArgs = isUnknownRecord(args) ? args : {}
    const target = resolveAutomationTarget(store, rawArgs)
    const targetArgs = stripAutomationTargetArgs(rawArgs)
    const handler = commandHandlers[command]
    const result = handler
      ? await handler(target, targetArgs)
      : await handleRPCFallback(target, command, targetArgs)
    return responseWithTarget(result, target)
  }

  return { handleRequest }
}
