import type { LocalTestPreview, LocalTestRequest, NumenValue, OutputSample } from '@numenjs/core'
export const outputSamplesQueryRef = { id: 'numen:output-samples', version: 1 } as const
export const createOutputSampleActionRef = { id: 'numen:output-sample-create', version: 1 } as const
export const importOutputSampleActionRef = { id: 'numen:output-sample-import', version: 1 } as const
export const deleteOutputSampleActionRef = { id: 'numen:output-sample-delete', version: 1 } as const
export const localTestPreviewQueryRef = { id: 'numen:local-test-preview', version: 1 } as const
export const startLocalTestActionRef = { id: 'numen:local-test-start', version: 1 } as const
export type OutputSampleSummary = Omit<OutputSample, 'value' | 'contract'>
export interface OutputSamplesInput { automationId: string; offset?: number }
export interface OutputSamplesPage { items: OutputSampleSummary[]; nextOffset?: number }
export interface CreateOutputSampleInput { automationId: string; expectedDraftVersion: number; nodeId: string; value: NumenValue }
export interface ImportOutputSampleInput { automationId: string; executionId: string }
export interface DeleteOutputSampleInput { automationId: string; sampleId: string }
export type WorkbenchLocalTestPreview = Pick<LocalTestPreview, 'request' | 'previewHash' | 'calls' | 'substitutions' | 'externalWrites'> & { nodeIds: string[] }
export type StartLocalTestInput = LocalTestRequest & { previewHash: string; requestId: string }
export interface StartLocalTestResult { runId: string; snapshotId: string }
