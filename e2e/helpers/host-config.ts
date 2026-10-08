import { expect } from '@playwright/test'
import type { HostConfigMutationRequest, HostConfigService } from '../../packages/config/dist/index.js'

/** Intentional direct Host mutations still require the same reviewed preview as the UI. */
export async function applyFreshHostConfig(host: HostConfigService, input: HostConfigMutationRequest) {
  const preview = await host.preview(input)
  expect(preview.blockedReason).toBeUndefined()
  expect(preview.previewToken).toEqual(expect.any(String))
  return host.apply({ ...input, previewToken: preview.previewToken! })
}
