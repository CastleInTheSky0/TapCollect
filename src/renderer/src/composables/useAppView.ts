import { ref } from 'vue'
import type { Ref } from 'vue'

export type AppView = 'task' | 'run-center'

export const useAppView = (): {
  appView: Ref<AppView>
  setAppView: (view: AppView) => void
} => {
  const appView = ref<AppView>('task')

  const setAppView = (view: AppView): void => {
    appView.value = view
  }

  return { appView, setAppView }
}
