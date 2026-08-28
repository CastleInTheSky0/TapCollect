import type { Ref } from 'vue'

export type PreviewOpenAction =
  | 'step-list'
  | 'address'
  | 'detail-first'
  | 'detail-next'
  | 'placeholder-list'

export const runPreviewOpenGuard = async (
  activeAction: Ref<PreviewOpenAction | null>,
  action: PreviewOpenAction,
  operation: () => Promise<void>
): Promise<boolean> => {
  if (activeAction.value) return false
  activeAction.value = action
  try {
    await operation()
    return true
  } finally {
    if (activeAction.value === action) activeAction.value = null
  }
}
