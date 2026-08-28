import { inject } from 'vue'
import type { InjectionKey } from 'vue'
import type { AppStore } from './types'

export type { AppStore } from './types'

export const appStoreKey: InjectionKey<AppStore> = Symbol('app-store')

export const useAppStore = (): AppStore => {
  const store = inject(appStoreKey)
  if (!store) throw new Error('路由页面必须渲染在应用外壳内')
  return store
}
