import { cdkGet, cdkPost, cdkDelete } from '@/lib/cdk-api'

export type DatasetStatus = 'INDEXING' | 'READY' | 'FAILED' | 'DELETING'

export type Dataset = {
  datasetId: string
  name: string
  s3Prefix: string
  status: DatasetStatus
  fileCount: number
  chunkCount: number
  createdAt: string
  updatedAt: string
}

export type AvailableRepo = {
  name: string
  worktreePrefix: string
  catalogPrefix: string | null
  jobId: string
  clonedAt: string
}

export type QuerySource = {
  filePath: string
  content: string
  datasetName: string
}

export function listDatasets(tenantId?: string) {
  const qs = tenantId ? `?tenantId=${tenantId}` : ''
  return cdkGet<{ ok: boolean; datasets: Dataset[] }>(`/assistant/datasets${qs}`)
}

export function listAvailableRepos(tenantId?: string) {
  const qs = tenantId ? `?tenantId=${tenantId}` : ''
  return cdkGet<{ ok: boolean; repos: AvailableRepo[] }>(`/assistant/available-repos${qs}`)
}

export function indexDataset(name: string, s3Prefix: string, mode: 'full' | 'catalog', tenantId?: string) {
  return cdkPost<{ ok: boolean; datasetId: string }>('/assistant/datasets', {
    name,
    s3Prefix,
    mode,
    ...(tenantId ? { tenantId } : {}),
  })
}

export function deleteDataset(datasetId: string) {
  return cdkDelete<{ ok: boolean }>(`/assistant/datasets/${datasetId}`)
}

export function queryAssistant(question: string, datasetIds: string[], tenantId?: string, model?: string) {
  return cdkPost<{ ok: boolean; answer: string; sources: QuerySource[] }>('/assistant/query', {
    question,
    datasetIds,
    ...(tenantId ? { tenantId } : {}),
    ...(model ? { model } : {}),
  })
}
