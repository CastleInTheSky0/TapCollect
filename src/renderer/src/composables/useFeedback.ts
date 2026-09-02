import MessagePlugin from 'tdesign-vue-next/es/message/plugin'
import { messageFromError } from '@renderer/utils/error-message'

const MESSAGE_AUTO_DISMISS_MS = 5_000

export const useFeedback = (): {
  showError: (error: unknown) => void
  showNotice: (message: string) => void
  showWarning: (message: string) => void
  formatConfigurationIssues: (intro: string, issues: string[]) => string
} => {
  const showFeedback = (theme: 'success' | 'warning' | 'error', content: string): void => {
    MessagePlugin.closeAll()
    void MessagePlugin(theme, {
      closeBtn: true,
      content,
      duration: MESSAGE_AUTO_DISMISS_MS,
      placement: 'top'
    })
  }

  const showError = (error: unknown): void => {
    showFeedback('error', messageFromError(error))
  }

  const showNotice = (message: string): void => {
    showFeedback('success', message)
  }

  const showWarning = (message: string): void => {
    showFeedback('warning', message)
  }

  const formatConfigurationIssues = (intro: string, issues: string[]): string =>
    `${intro}（${issues.length} 项）：${issues
      .map((issue, index) => `${index + 1}. ${issue}`)
      .join('；')}`

  return { showError, showNotice, showWarning, formatConfigurationIssues }
}
