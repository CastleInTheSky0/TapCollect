import { describe, expect, it } from 'vitest'
import { createTask, normalizeTaskConfig } from './defaults'
import { isAccessProfileId, parseProfileCookies, profileMatchesUrl, validateAccessProfile } from './access-profile'
import { createTaskConfigBundle, prepareImportedTaskConfig } from './task-config-bundle'

const id = 'c56a4180-65aa-42ec-a945-5fd21dec0538'
const profile = { id, name: ' 编辑站点 ', origin: 'https://EXAMPLE.com:443/', userAgent: '', language: '' }

describe('access profile boundaries', () => {
  it('uses immutable exact origins without URL credentials, path or wildcard matching', () => {
    const normalized = validateAccessProfile(profile)
    expect(normalized.origin).toBe('https://example.com')
    expect(normalized.name).toBe('编辑站点')
    expect(profileMatchesUrl(normalized, 'https://example.com/article?a=1')).toBe(true)
    for (const url of ['http://example.com', 'https://example.com:8443', 'https://child.example.com', 'https://user:secret@example.com']) expect(profileMatchesUrl(normalized, url)).toBe(false)
    for (const origin of ['https://example.com/path', 'https://user:secret@example.com', 'file:///tmp', 'https://example.com?token=secret']) expect(() => validateAccessProfile({ ...profile, origin })).toThrow()
    expect(() => validateAccessProfile({ ...profile, userAgent: 'UA\r\nx-secret: secret' })).toThrow()
    expect(isAccessProfileId('../../secret')).toBe(false)
  })

  it('validates cookie attributes atomically without revealing secret values', () => {
    const value = { name: 'session', value: 'never-echo-this', path: '/', httpOnly: true, expirationDate: 2000 }
    expect(parseProfileCookies(JSON.stringify([value]), 'https://example.com', 1000)).toEqual([{ ...value, secure: true, sameSite: 'unspecified' }])
    for (const patch of [{ domain: '.com' }, { domain: 'other.example.com' }, { path: '/bad;path' }, { expirationDate: 999 }, { secure: false, sameSite: 'no_restriction' }, { name: '__Host-session', domain: 'example.com' }, { httpOnly: 'true' }, { value: 'bad\r\nsecret' }]) {
      expect(() => parseProfileCookies(JSON.stringify([{ ...value, ...patch }]), 'https://example.com', 1000)).toThrow('属性无效')
    }
    expect(() => parseProfileCookies(JSON.stringify([value, value]), 'https://example.com', 1000)).toThrow()
    expect(() => parseProfileCookies('never-echo-this', 'https://example.com')).toThrow('Cookie JSON 格式无效')
  })

  it('keeps missing profile references explicit while removing credential channels from bundles', () => {
    const task = createTask('task')
    expect(normalizeTaskConfig(task).accessProfileId).toBe('')
    task.accessProfileId = id
    task.request.headers = [{ id: 'auth', key: ' Authorization ', value: 'Bearer secret' }, { id: 'cookie', key: 'Cookie', value: 'secret' }, { id: 'ok', key: 'Accept', value: 'text/html' }]
    const bundle = createTaskConfigBundle([task])
    expect(JSON.stringify(bundle)).not.toContain('secret')
    expect(task.request.headers).toHaveLength(3)
    const imported = prepareImportedTaskConfig(bundle.tasks[0], 'new-task')
    expect(imported.accessProfileId).toBe(id)
    expect(imported.request.headers).toEqual([{ id: 'ok', key: 'Accept', value: 'text/html' }])
    expect(prepareImportedTaskConfig(task, 'old-export').request.headers).toHaveLength(1)
  })

  it('limits cookie import by encoded bytes as well as row count', () => {
    const json = JSON.stringify(Array.from({ length: 100 }, (_, index) => ({ name: `session-${index}`, value: '字'.repeat(900) })))
    expect(json.length).toBeLessThan(256_000)
    expect(() => parseProfileCookies(json, 'https://example.com')).toThrow('不能超过 256 KB')
    const rows = Array.from({ length: 201 }, (_, index) => ({ name: `session-${index}`, value: 'value' }))
    expect(() => parseProfileCookies(JSON.stringify(rows), 'https://example.com')).toThrow('最多 200 项')
  })
})
