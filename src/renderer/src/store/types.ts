import type { useAppNavigation } from '@renderer/composables/useAppNavigation'
import type { useAppSettings } from '@renderer/composables/useAppSettings'
import type { usePreview } from '@renderer/composables/usePreview'
import type { useRunSession } from '@renderer/composables/useRunSession'
import type { useTaskForm } from '@renderer/composables/useTaskForm'

export interface AppStore {
  navigationStore: ReturnType<typeof useAppNavigation>
  settingsStore: ReturnType<typeof useAppSettings>
  runSessionStore: ReturnType<typeof useRunSession>
  taskFormStore: ReturnType<typeof useTaskForm>
  previewStore: ReturnType<typeof usePreview>
}
