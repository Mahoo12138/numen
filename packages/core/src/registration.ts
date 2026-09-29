import type { Context } from 'cordis'

export interface RuntimeRegistration {
  kind: 'capability' | 'connection-adapter' | 'connection-type'
  id: string
  version: number
  role: 'definition' | 'provider'
  owner: Context
  token: symbol
}

declare module 'cordis' {
  interface Events {
    'numen/registration-change'(registration: RuntimeRegistration, active: boolean): void
  }
}

/** Registries report actual registration owners; the Host alone resolves configuration identity. */
export function trackRegistration(ctx: Context, owner: Context, ref: Omit<RuntimeRegistration, 'owner' | 'token'>): () => void {
  const registration = { ...ref, owner, token: Symbol() }
  let active = true
  ctx.emit('numen/registration-change', registration, true)
  return () => {
    if (!active) return
    active = false
    ctx.emit('numen/registration-change', registration, false)
  }
}
