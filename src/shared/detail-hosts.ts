import type { DetailConfig } from './types'

const HOST_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i

export interface DetailHostScope {
  listHostname: string
  externalHostnames: ReadonlySet<string>
}

export const analyzeDetailHosts = (value = '') => {
  const hostnames = new Set<string>()
  const issues: string[] = []
  for (const [index, line] of value.split(/\r?\n/).entries()) {
    const host = line.trim().toLowerCase()
    if (!host) continue
    if (host.length > 253 || !host.split('.').every((label) => HOST_LABEL.test(label))) {
      issues.push(`“允许的外站详情主机名”第 ${index + 1} 行无效，请填写完整主机名，不含协议、端口、路径或通配符`)
    } else {
      hostnames.add(host)
    }
  }
  return { hostnames, issues }
}

export const detailHostConfigurationIssues = (detail: DetailConfig): string[] =>
  detail.enabled && detail.navigationMode === 'link'
    ? analyzeDetailHosts(detail.allowedExternalHosts).issues
    : []

export const detailHostScope = (detail: DetailConfig, listUrl: string): DetailHostScope => {
  const listHostname = new URL(listUrl).hostname
  const externalHostnames = new Set<string>()
  if (detail.enabled && detail.navigationMode === 'link') {
    const { hostnames, issues } = analyzeDetailHosts(detail.allowedExternalHosts)
    if (!issues.length) {
      for (const hostname of hostnames) {
        if (hostname !== listHostname) externalHostnames.add(hostname)
      }
    }
  }
  return { listHostname, externalHostnames }
}

export const allowedDetailHostname = (scope: DetailHostScope, target: string): string => {
  try {
    const { hostname, protocol, username, password } = new URL(target)
    if (username || password || (protocol !== 'http:' && protocol !== 'https:')) return ''
    return hostname === scope.listHostname || scope.externalHostnames.has(hostname) ? hostname : ''
  } catch {
    return ''
  }
}
