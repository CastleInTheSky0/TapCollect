import { JSDOM } from 'jsdom'

/** 只识别多个明确的验证信号；普通空列表或提及验证码的文章不构成阻断。 */
export const detectBlockedPage = (html: string, url: string): string | null => {
  if (!/(?:captcha|challenge|verify|password|just a moment|登录|验证|访问受限|访问被拒绝|安全检查|频繁)/i.test(html)) return null
  const dom = new JSDOM(html)
  try {
    const document = dom.window.document
    const title = document.title.trim()
    const text = (document.body?.textContent ?? '').replace(/\s+/g, ' ').trim()
    const challengeTitle = /^(?:just a moment[.!…]*|attention required.*|verify (?:you are human|your identity).*|访问验证|安全验证|人机验证|访问受限|访问被拒绝|安全检查|请完成验证|登录|用户登录|sign in|log in)$/i.test(title)
    const challengeControl = Boolean(document.querySelector(
      'iframe[src*="captcha"], iframe[src*="challenge"], input[name*="captcha"], input[id*="captcha"], #challenge-form, #cf-challenge-running, .cf-turnstile, .g-recaptcha, .h-captcha'
    ))
    const passwordForm = Boolean(document.querySelector('form input[type="password"]'))
    const challengeInstruction = /验证您是人类|请完成.{0,12}验证|请输入.{0,8}验证码|verify you are human|checking your browser|enable javascript and cookies to continue|访问过于频繁|访问频率过高/i.test(text)
    const challengePath = /\/(?:captcha|challenge|login|signin)(?:[/.?]|$)/i.test(new URL(url).pathname)
    if (challengeTitle && (challengeControl || passwordForm || challengeInstruction || challengePath)) {
      return passwordForm ? '页面需要登录，请人工检查后重试' : '检测到访问验证页，请人工检查后重试'
    }
    if (challengeControl && challengeInstruction && text.length < 2000) {
      return '检测到人机验证，请人工检查后重试'
    }
    return null
  } finally {
    dom.window.close()
  }
}
