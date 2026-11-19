import type {
  AudioMode,
  BackgroundMode,
  BillingMode,
  CharacterAsset,
  EnvironmentAsset,
  ErrorDiagnosticDetail,
  FreeModeFallbackPolicy,
  LightingMode,
  ModelCatalogItem,
  OutputAspectRatio,
  OutputResolution,
  ProjectRecord,
  ProviderConfigRecord,
  ProviderId,
  QualityTier,
  QueueOverview,
  QuotaDashboardResponse,
  ReplacementScope,
  SelfTestReport,
  SettingsStatus,
  TaskCapabilityPreview,
  TransformationMode,
  VideoMetadata,
} from './types';

export class ApiRequestError extends Error {
  statusCode: number;
  diagnosticDetail?: ErrorDiagnosticDetail | null;
  rawBody?: string;

  constructor(
    message: string,
    statusCode: number,
    diagnosticDetail?: ErrorDiagnosticDetail | null,
    rawBody?: string
  ) {
    super(message);
    this.name = 'ApiRequestError';
    this.statusCode = statusCode;
    this.diagnosticDetail = diagnosticDetail;
    this.rawBody = rawBody;
  }
}

async function jsonOrThrow<T>(res: Response): Promise<T> {
  const rawText = await res.text();
  let parsed: Record<string, unknown> | null = null;
  if (rawText) {
    try {
      parsed = JSON.parse(rawText) as Record<string, unknown>;
    } catch {
      parsed = null;
    }
  }

  if (!res.ok) {
    const fallbackText =
      rawText && !rawText.trim().startsWith('<')
        ? rawText.slice(0, 240)
        : `Server or proxy returned HTTP ${res.status} (${res.statusText || 'Error'})`;
    const msg =
      (parsed && typeof parsed.error === 'string' && parsed.error) ||
      fallbackText;
    const diag =
      parsed && parsed.diagnosticDetail
        ? (parsed.diagnosticDetail as ErrorDiagnosticDetail)
        : null;
    throw new ApiRequestError(msg, res.status, diag, rawText.slice(0, 400));
  }

  if (!parsed && rawText.trim().length > 0) {
    throw new ApiRequestError(
      `Unexpected non-JSON response from server (HTTP ${res.status}).`,
      res.status,
      null,
      rawText.slice(0, 300)
    );
  }

  return (parsed ?? {}) as T;
}

export type VideoUploadPhase = 'uploading' | 'validating' | 'completed';

const CHUNK_THRESHOLD_BYTES = 3 * 1024 * 1024;
const CHUNK_SIZE_BYTES = 2 * 1024 * 1024;

function sendChunkXhr(
  uploadId: string,
  index: number,
  chunk: Blob,
  onChunkProgress: (loadedBytes: number) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(
      'POST',
      `/api/uploads/video/chunk?uploadId=${encodeURIComponent(uploadId)}&index=${index}`
    );
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');

    xhr.upload.onprogress = (ev) => {
      if (ev.lengthComputable) {
        onChunkProgress(ev.loaded);
      }
    };

    xhr.onload = () => {
      let errMsg = `Chunk ${index + 1} upload failed (HTTP ${xhr.status}).`;
      try {
        const parsed = JSON.parse(xhr.responseText);
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve();
          return;
        }
        if (parsed?.error) errMsg = String(parsed.error);
      } catch {
        // Keep HTTP error status message
      }
      reject(new ApiRequestError(errMsg, xhr.status));
    };

    xhr.onerror = () =>
      reject(new ApiRequestError(`Network error while uploading chunk ${index + 1}.`, 0));
    xhr.send(chunk);
  });
}

export async function uploadVideoWithProgress(
  file: File,
  onProgress: (percent: number) => void,
  onPhase?: (phase: VideoUploadPhase) => void
): Promise<VideoMetadata> {
  onPhase?.('uploading');
  onProgress(0);

  if (file.size > CHUNK_THRESHOLD_BYTES) {
    const totalChunks = Math.ceil(file.size / CHUNK_SIZE_BYTES);
    const initRes = await fetch('/api/uploads/video/init', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        originalName: file.name,
        mimeType: file.type || 'video/mp4',
        totalSizeBytes: file.size,
        totalChunks,
      }),
    });
    const { uploadId } = await jsonOrThrow<{ uploadId: string }>(initRes);

    let uploadedSoFar = 0;
    for (let i = 0; i < totalChunks; i++) {
      const start = i * CHUNK_SIZE_BYTES;
      const end = Math.min(file.size, start + CHUNK_SIZE_BYTES);
      const blob = file.slice(start, end);

      let attempt = 0;
      while (true) {
        try {
          await sendChunkXhr(uploadId, i, blob, (loaded) => {
            const pct = Math.min(
              95,
              Math.round(((uploadedSoFar + loaded) / file.size) * 95)
            );
            onProgress(pct);
          });
          break;
        } catch (err) {
          attempt++;
          if (attempt >= 2) throw err;
        }
      }
      uploadedSoFar += blob.size;
      onProgress(Math.min(95, Math.round((uploadedSoFar / file.size) * 95)));
    }

    onPhase?.('validating');
    const completeRes = await fetch('/api/uploads/video/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uploadId }),
    });
    const meta = await jsonOrThrow<VideoMetadata>(completeRes);
    onProgress(100);
    onPhase?.('completed');
    return meta;
  }

  return new Promise((resolve, reject) => {
    const formData = new FormData();
    formData.append('video', file);

    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/uploads/video');

    xhr.upload.onprogress = (ev) => {
      if (ev.lengthComputable) {
        const pct = Math.min(95, Math.round((ev.loaded / ev.total) * 95));
        onProgress(pct);
        if (ev.loaded >= ev.total) {
          onPhase?.('validating');
        }
      }
    };

    xhr.onload = () => {
      try {
        const parsed = JSON.parse(xhr.responseText);
        if (xhr.status >= 200 && xhr.status < 300) {
          onProgress(100);
          onPhase?.('completed');
          resolve(parsed as VideoMetadata);
        } else {
          reject(
            new ApiRequestError(
              parsed?.error || `Upload failed (HTTP ${xhr.status})`,
              xhr.status
            )
          );
        }
      } catch {
        reject(
          new ApiRequestError(
            `Upload failed (HTTP ${xhr.status}): Invalid response from server.`,
            xhr.status
          )
        );
      }
    };

    xhr.onerror = () =>
      reject(new ApiRequestError('Network error while uploading video.', 0));
    xhr.send(formData);
  });
}

export async function fetchCharacters(): Promise<CharacterAsset[]> {
  const res = await fetch('/api/characters');
  return jsonOrThrow(res);
}

export async function uploadCharacter(params: {
  name: string;
  notes?: string;
  files: File[];
}): Promise<{ character: CharacterAsset; analysisWarning: string | null }> {
  const form = new FormData();
  form.append('name', params.name);
  if (params.notes) form.append('notes', params.notes);
  for (const f of params.files) {
    form.append('photos', f);
  }
  const res = await fetch('/api/characters', { method: 'POST', body: form });
  return jsonOrThrow(res);
}

export async function reanalyzeCharacter(id: string): Promise<CharacterAsset> {
  const res = await fetch(`/api/characters/${id}/analyze`, { method: 'POST' });
  return jsonOrThrow(res);
}

export async function deleteCharacter(id: string): Promise<void> {
  const res = await fetch(`/api/characters/${id}`, { method: 'DELETE' });
  await jsonOrThrow(res);
}

export async function fetchEnvironments(): Promise<EnvironmentAsset[]> {
  const res = await fetch('/api/environments');
  return jsonOrThrow(res);
}

export async function uploadEnvironment(params: {
  name: string;
  category: string;
  description: string;
  file: File;
}): Promise<EnvironmentAsset> {
  const form = new FormData();
  form.append('name', params.name);
  form.append('category', params.category);
  form.append('description', params.description);
  form.append('image', params.file);
  const res = await fetch('/api/environments', { method: 'POST', body: form });
  return jsonOrThrow(res);
}

export async function deleteEnvironment(id: string): Promise<void> {
  const res = await fetch(`/api/environments/${id}`, { method: 'DELETE' });
  await jsonOrThrow(res);
}

export async function fetchProjects(): Promise<ProjectRecord[]> {
  const res = await fetch('/api/projects');
  return jsonOrThrow(res);
}

export async function fetchProject(id: string): Promise<ProjectRecord> {
  const res = await fetch(`/api/projects/${id}`);
  return jsonOrThrow(res);
}

export async function createProject(payload: {
  name?: string;
  sourceVideo: VideoMetadata;
  characterIds: string[];
  environmentId: string | null;
  environmentVideo?: VideoMetadata | null;
  instruction: string;
  mode: TransformationMode;
  replacementScope?: ReplacementScope;
  backgroundMode?: BackgroundMode;
  lightingMode?: LightingMode;
  qualityTier: QualityTier;
  resolution: OutputResolution;
  aspectRatio: OutputAspectRatio;
  audioMode: AudioMode;
  billingMode: BillingMode;
  freeFallbackPolicy?: FreeModeFallbackPolicy;
  paidConfirmed: boolean;
}): Promise<ProjectRecord> {
  const res = await fetch('/api/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return jsonOrThrow(res);
}

export async function updateProject(
  id: string,
  payload: Partial<ProjectRecord>
): Promise<ProjectRecord> {
  const res = await fetch(`/api/projects/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return jsonOrThrow(res);
}

export async function deleteProject(id: string): Promise<void> {
  const res = await fetch(`/api/projects/${id}`, { method: 'DELETE' });
  await jsonOrThrow(res);
}

export async function analyzeProject(id: string): Promise<ProjectRecord> {
  const res = await fetch(`/api/projects/${id}/analyze`, { method: 'POST' });
  return jsonOrThrow(res);
}

export async function startProjectRun(
  id: string,
  paidConfirmed = false,
  resetPipeline = false
): Promise<{ started: boolean }> {
  const res = await fetch(`/api/projects/${id}/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ paidConfirmed, resetPipeline }),
  });
  return jsonOrThrow(res);
}

export async function retryProjectSegment(
  id: string,
  segmentIndex: number
): Promise<void> {
  const res = await fetch(`/api/projects/${id}/segments/${segmentIndex}/retry`, {
    method: 'POST',
  });
  await jsonOrThrow(res);
}

export async function fetchModels(): Promise<ModelCatalogItem[]> {
  const res = await fetch('/api/models');
  return jsonOrThrow(res);
}

export async function fetchQuotaDashboard(): Promise<QuotaDashboardResponse> {
  const res = await fetch('/api/quota-dashboard');
  return jsonOrThrow(res);
}

export async function fetchProviders(): Promise<ProviderConfigRecord[]> {
  const res = await fetch('/api/providers');
  return jsonOrThrow(res);
}

export async function addCustomProvider(payload: {
  providerType: ProviderId;
  displayName: string;
  envVarName?: string;
  dailyCreditsRemaining?: number | null;
  monthlyCreditsRemaining?: number | null;
  estimatedSecondsRemaining?: number | null;
  nextResetAt?: string | null;
  note?: string;
}): Promise<ProviderConfigRecord> {
  const res = await fetch('/api/providers', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return jsonOrThrow(res);
}

export async function updateProviderConfig(
  id: string,
  payload: {
    enabled?: boolean;
    displayName?: string;
    endpointUrl?: string | null;
    manualEstimate?: Partial<ProviderConfigRecord['manualEstimate']>;
  }
): Promise<ProviderConfigRecord> {
  const res = await fetch(`/api/providers/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return jsonOrThrow(res);
}

export async function deleteCustomProvider(id: string): Promise<void> {
  const res = await fetch(`/api/providers/${id}`, { method: 'DELETE' });
  await jsonOrThrow(res);
}

export async function testProviderConnection(
  id: string
): Promise<ProviderConfigRecord> {
  const res = await fetch(`/api/providers/${id}/test`, { method: 'POST' });
  return jsonOrThrow(res);
}

export async function fetchWorkerSetup(): Promise<{
  workerFiles: string[];
  hardwareRequirement: string;
  cost: string;
  endpoints: string[];
  quickStartCommands: string[];
}> {
  const res = await fetch('/api/worker/setup');
  return jsonOrThrow(res);
}

export async function fetchModelSelectionPreview(params: {
  billingMode: BillingMode;
  mode: TransformationMode;
  resolution: OutputResolution;
  replacementScope?: ReplacementScope;
  hasCharacterRef: boolean;
  requiresMultiCharacter?: boolean;
}): Promise<{
  billingMode: BillingMode;
  capabilities: TaskCapabilityPreview;
  candidates: Array<{
    providerId: string;
    providerName: string;
    modelId: string;
    modelName: string;
    taskType?: string;
    freeTierEligible: boolean;
    score: number;
    reason: string;
    hardwareRequirement?: string | null;
    maxDurationSec: number;
    supportedResolutions: string[];
    supportsVideoToVideo?: boolean;
    supportsImageEditing?: boolean;
    supportsCharacterReplacement?: boolean;
    supportsMultiCharacter?: boolean;
  }>;
}> {
  const qs = new URLSearchParams({
    billingMode: params.billingMode,
    mode: params.mode,
    resolution: params.resolution,
    replacementScope: params.replacementScope ?? 'full_character_replacement',
    hasCharacterRef: String(params.hasCharacterRef),
    requiresMultiCharacter: String(Boolean(params.requiresMultiCharacter)),
  });
  const res = await fetch(`/api/providers/select-preview?${qs.toString()}`);
  return jsonOrThrow(res);
}

export async function fetchQueueOverview(): Promise<QueueOverview> {
  const res = await fetch('/api/queue');
  return jsonOrThrow(res);
}

export async function cancelQueuedJob(id: string): Promise<ProjectRecord> {
  const res = await fetch(`/api/queue/${id}/cancel`, { method: 'POST' });
  return jsonOrThrow(res);
}

export async function fetchSettingsStatus(): Promise<SettingsStatus> {
  const res = await fetch('/api/settings/status');
  return jsonOrThrow(res);
}

export async function testGeminiConnection(): Promise<{
  configured: boolean;
  connected: boolean;
  modelTested: string;
  message: string;
}> {
  const res = await fetch('/api/settings/test-connection', { method: 'POST' });
  return jsonOrThrow(res);
}

export async function runSelfTestSuite(): Promise<SelfTestReport> {
  const res = await fetch('/api/diagnostics/self-test', { method: 'POST' });
  return jsonOrThrow(res);
}

export async function verifyVideoDownloadAvailable(id: string): Promise<{
  ok: boolean;
  contentLength: number | null;
  error?: string;
}> {
  try {
    const res = await fetch(`/api/projects/${id}/download/video`, {
      method: 'HEAD',
    });
    if (!res.ok) {
      return {
        ok: false,
        contentLength: null,
        error: `Download verification failed (HTTP ${res.status}): generated MP4 was not found on server.`,
      };
    }
    const lenHeader = res.headers.get('content-length');
    return {
      ok: true,
      contentLength: lenHeader ? Number(lenHeader) : null,
    };
  } catch (err) {
    return {
      ok: false,
      contentLength: null,
      error: err instanceof Error ? err.message : 'Network error verifying download.',
    };
  }
}
