/**
 * Domain-owned: pending operations survive disposal of a Settings editor.
 *
 * 与上游 mutations.ts 同款语义：每连接（按 slug）一队列串行化，后入队等待
 * 前序完成，既防覆写也保用户快速连点保存不冲突。
 */

const pendingByConnection = new Map<string, Promise<unknown>>()

export function enqueueMCPConnectionMutation<T>(
  id: string,
  operation: () => Promise<T>
): Promise<T> {
  const previous = pendingByConnection.get(id) ?? Promise.resolve()
  const pending = previous.then(operation, operation)
  const settled = pending.then(
    () => undefined,
    () => undefined
  )
  pendingByConnection.set(id, settled)
  void settled.then(() => {
    if (pendingByConnection.get(id) === settled) pendingByConnection.delete(id)
    return undefined
  })
  return pending
}
