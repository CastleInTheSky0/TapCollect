/// <reference types="vite/client" />

import type { CollectorApi } from '@shared/types'

declare global {
  interface Window {
    collector: CollectorApi
  }
}

export {}
