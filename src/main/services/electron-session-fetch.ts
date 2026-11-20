import { randomUUID } from 'node:crypto'
import { session, type OnHeadersReceivedListenerDetails, type Session } from 'electron'

interface ManualRequest { requestId?: number; redirect?: { status: number; headers: Headers } }
const REQUEST_MARKER = 'x-tapcollect-session-request'

export class ElectronSessionFetch {
  private readonly pending = new Map<string, ManualRequest>()
  private readonly requests = new Map<number, ManualRequest>()

  constructor(private readonly session: Session) {}

  identifyRequest(id: number, headers: Record<string, string>): void {
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() !== REQUEST_MARKER) continue
      const pending = this.pending.get(headers[key]!)
      if (pending) { pending.requestId = id; this.requests.set(id, pending) }
      delete headers[key]
    }
  }

  captureRedirect(details: OnHeadersReceivedListenerDetails): void {
    const pending = this.requests.get(details.id)
    if (!pending || details.statusCode < 300 || details.statusCode >= 400) return
    const headers = new Headers()
    for (const [key, values] of Object.entries(details.responseHeaders ?? {})) {
      for (const value of values) headers.append(key, value)
    }
    pending.redirect = { status: details.statusCode, headers }
  }

  async fetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    const target = input instanceof URL ? input.href : input
    if (init?.redirect !== 'manual') return this.session.fetch(target, init)
    // Electron 43 cancels manual redirects. Correlate the native response
    // without forwarding the marker or letting Chromium follow the next hop.
    const marker = randomUUID()
    const pending: ManualRequest = {}
    const headers = new Headers(init.headers)
    headers.set(REQUEST_MARKER, marker)
    this.pending.set(marker, pending)
    try { return await this.session.fetch(target, { ...init, headers }) }
    catch (error) {
      if (pending.redirect && !init.signal?.aborted) return new Response(null, pending.redirect)
      throw error
    } finally {
      this.pending.delete(marker)
      if (pending.requestId !== undefined) this.requests.delete(pending.requestId)
    }
  }
}

let detailTransport: ElectronSessionFetch | undefined

export const fetchInAnonymousDetailSession: typeof fetch = (input, init) => {
  if (!detailTransport) {
    const detailSession = session.fromPartition('tapcollect-anonymous-detail-http', { cache: false })
    const transport = new ElectronSessionFetch(detailSession)
    detailSession.webRequest.onBeforeSendHeaders((details, callback) => {
      const headers = { ...details.requestHeaders }
      transport.identifyRequest(details.id, headers)
      callback({ requestHeaders: headers })
    })
    detailSession.webRequest.onHeadersReceived((details, callback) => {
      transport.captureRedirect(details)
      callback({})
    })
    detailTransport = transport
  }
  return detailTransport.fetch(input, { ...init, credentials: 'omit' })
}
