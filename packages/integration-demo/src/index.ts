import { defineCapability, type CapabilityProvider } from '@numen/core'
import type { Context } from 'cordis'
import z from 'schemastery'

export interface EchoInput {
  message: string
}

export interface EchoOutput {
  message: string
}

export const echoCapability = defineCapability({
  id: 'demo:echo',
  version: 1,
  kind: 'query',
  title: 'Echo',
  description: 'Return the input message unchanged. This Capability is local and requires no Connection.',
  input: z.object({ message: z.string().required() }),
  output: z.object({ message: z.string().required() }),
  semantics: { sideEffect: false, idempotent: true, retrySafe: true },
})

export function demoIntegrationPlugin(ctx: Context): void {
  ctx.capabilities.define(ctx, echoCapability)
  ctx.capabilities.provide(ctx, echoCapability, {
    async invoke({ input }) {
      return { message: input.message }
    },
  } satisfies CapabilityProvider<EchoInput, EchoOutput>)
}

demoIntegrationPlugin.inject = ['capabilities']

export default demoIntegrationPlugin
