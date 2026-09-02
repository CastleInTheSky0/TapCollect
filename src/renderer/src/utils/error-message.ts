export const messageFromError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)
