import { ref } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import { runPreviewOpenGuard, type PreviewOpenAction } from './preview-open-guard'

describe('runPreviewOpenGuard', () => {
  it('ignores a repeated preview action while the first action is pending', async () => {
    const activeAction = ref<PreviewOpenAction | null>(null)
    let finishFirst: (() => void) | undefined
    const firstOperation = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishFirst = resolve
        })
    )
    const secondOperation = vi.fn(async () => undefined)

    const first = runPreviewOpenGuard(activeAction, 'detail-first', firstOperation)
    expect(activeAction.value).toBe('detail-first')

    const second = await runPreviewOpenGuard(activeAction, 'detail-first', secondOperation)
    expect(second).toBe(false)
    expect(secondOperation).not.toHaveBeenCalled()

    finishFirst?.()
    await expect(first).resolves.toBe(true)
    expect(firstOperation).toHaveBeenCalledTimes(1)
    expect(activeAction.value).toBeNull()
  })

  it('shares the pending lock between different preview actions', async () => {
    const activeAction = ref<PreviewOpenAction | null>(null)
    let finishFirst: (() => void) | undefined
    const first = runPreviewOpenGuard(
      activeAction,
      'detail-first',
      () =>
        new Promise<void>((resolve) => {
          finishFirst = resolve
        })
    )
    const secondOperation = vi.fn(async () => undefined)

    await expect(
      runPreviewOpenGuard(activeAction, 'address', secondOperation)
    ).resolves.toBe(false)
    expect(secondOperation).not.toHaveBeenCalled()

    finishFirst?.()
    await expect(first).resolves.toBe(true)
  })

  it('releases the active action after a failed preview operation', async () => {
    const activeAction = ref<PreviewOpenAction | null>(null)

    await expect(
      runPreviewOpenGuard(activeAction, 'address', async () => {
        throw new Error('preview failed')
      })
    ).rejects.toThrow('preview failed')

    expect(activeAction.value).toBeNull()
    await expect(
      runPreviewOpenGuard(activeAction, 'address', async () => undefined)
    ).resolves.toBe(true)
  })
})
