import { describe, expect, it } from 'vitest'
import { detectBlockedPage } from './block-detector'
import { parseRetryAfter } from './access-errors'

describe('challenge detection', () => {
  it('recognizes challenge and login pages using combined signals', () => {
    expect(detectBlockedPage('<title>安全验证</title><form><input name="captcha">请输入验证码</form>', 'https://example.com/list')).toContain('验证')
    expect(detectBlockedPage('<title>登录</title><form><input type="password"></form>', 'https://example.com/login')).toContain('登录')
    expect(detectBlockedPage('<title>Just a moment...</title><div id="challenge-form">Enable JavaScript and cookies to continue</div>', 'https://example.com/list')).toContain('验证')
  })
  it('does not mistake empty lists or news about captcha for a challenge', () => {
    expect(detectBlockedPage('<title>新闻列表</title><ul></ul>', 'https://example.com/list')).toBeNull()
    expect(detectBlockedPage('<title>关于验证码的通知</title><article>请输入验证码是登录时的提示。</article>', 'https://example.com/news/42')).toBeNull()
    expect(detectBlockedPage('<title>首页</title><form><input type="password"></form><article>正常内容</article>', 'https://example.com')).toBeNull()
  })
  it('honors both Retry-After forms without applying local backoff caps', () => {
    const now = Date.parse('2026-09-07T00:00:00Z')
    expect(parseRetryAfter('7200', now)).toBe(7200000)
    expect(parseRetryAfter('Mon, 07 Sep 2026 01:00:00 GMT', now)).toBe(3600000)
    expect(parseRetryAfter('invalid', now)).toBe(0)
    expect(parseRetryAfter('-2', now)).toBe(0)
  })
})
