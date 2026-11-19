import fs from 'fs';
import path from 'path';
import {
  parseRateLimitMetadata,
  ProviderHttpError,
  QuotaExhaustedError,
  withRetry,
} from '../errors.ts';
import { computeImageSimilaritySsim, verifyPlayableVideo } from '../ffmpeg.ts';
import {
  checkGeminiConnection,
  editFrameWithGeminiImageModel,
  generateSegmentWithOmniFlash,
} from '../gemini.ts';
import {
  canCallModel,
  ensureModelQuotaRecord,
  recordModelApiRequest,
} from '../quota.ts';
import { isEnvSecretSet, isProviderConfigured } from '../store.ts';
import type {
  FrameEditRequest,
  FrameEditResult,
  ProviderAdapter,
  ProviderConfigRecord,
  ProviderId,
  ProviderModelSpec,
  ProviderQuotaInfo,
  SegmentGenerationRequest,
  SegmentGenerationResult,
} from './types.ts';

export class ProviderQuotaError extends QuotaExhaustedError {
  constructor(
    message: string,
    statusCode: number,
    providerId: string,
    providerJobId?: string | null,
    opts?: {
      retryAfterSec?: number | null;
      quotaIdentifier?: string | null;
      dailyLimit?: number | null;
      isDailyQuota?: boolean;
    }
  ) {
    super(message, {
      statusCode,
      providerId,
      providerJobId,
      retryAfterSec: opts?.retryAfterSec,
      quotaIdentifier: opts?.quotaIdentifier,
      dailyLimit: opts?.dailyLimit,
      isDailyQuota: opts?.isDailyQuota,
    });
  }
}

function assertExternalModelCallable(
  config: ProviderConfigRecord,
  req: SegmentGenerationRequest
): void {
  const modelSpec = config.models.find((m) => m.id === req.modelId);
  ensureModelQuotaRecord({
    providerId: config.id,
    providerName: config.displayName,
    modelId: req.modelId,
    taskType: modelSpec?.taskType ?? 'video_generation',
    freeTierEligible: modelSpec?.freeTierEligible ?? config.freeVideoEligible,
  });

  const check = canCallModel(config.id, req.modelId);
  if (!check.allowed) {
    const retryAfterSec = check.retryAfterAt
      ? Math.max(1, Math.ceil((Date.parse(check.retryAfterAt) - Date.now()) / 1000))
      : null;
    throw new ProviderQuotaError(
      check.reason || `${config.displayName} (${req.modelId}) is paused due to quota/rate limit.`,
      429,
      config.id,
      null,
      {
        retryAfterSec,
        quotaIdentifier: check.quotaIdentifier,
        dailyLimit: check.dailyLimit,
        isDailyQuota: check.status === 'daily_exhausted',
      }
    );
  }
}

function parseNumericHeader(res: Response, name: string): number | null {
  const val = res.headers.get(name);
  if (!val) return null;
  const num = Number(val.trim());
  return Number.isFinite(num) ? num : null;
}

function recordExternalSubmission(params: {
  config: ProviderConfigRecord;
  req: SegmentGenerationRequest;
  success: boolean;
  res?: Response;
  error?: unknown;
}): void {
  const modelSpec = params.config.models.find((m) => m.id === params.req.modelId);
  recordModelApiRequest({
    providerId: params.config.id,
    providerName: params.config.displayName,
    modelId: params.req.modelId,
    taskType: modelSpec?.taskType ?? 'video_generation',
    freeTierEligible: modelSpec?.freeTierEligible ?? params.config.freeVideoEligible,
    projectId: params.req.projectId,
    projectName: params.req.projectName,
    success: params.success,
    error: params.error,
    retryAfterHeader: params.res?.headers.get('retry-after'),
    confirmedLimitHeader: params.res
      ? (parseNumericHeader(params.res, 'x-ratelimit-limit-requests') ??
          parseNumericHeader(params.res, 'x-ratelimit-limit'))
      : null,
    remainingHeader: params.res
      ? (parseNumericHeader(params.res, 'x-ratelimit-remaining-requests') ??
          parseNumericHeader(params.res, 'x-ratelimit-remaining'))
      : null,
  });
}

function getSecret(envVarName: string): string | null {
  if (!isEnvSecretSet(envVarName)) return null;
  return process.env[envVarName]?.trim() ?? null;
}

function loadRefImageDataUrl(req: SegmentGenerationRequest): string | undefined {
  const refImagePath =
    req.characterRefs[0]?.primaryImagePath &&
    fs.existsSync(req.characterRefs[0].primaryImagePath)
      ? req.characterRefs[0].primaryImagePath
      : req.keyframePath;

  if (!refImagePath || !fs.existsSync(refImagePath)) return undefined;
  const ext = path.extname(refImagePath).toLowerCase();
  const mime =
    ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
  const b64 = fs.readFileSync(refImagePath).toString('base64');
  return `data:${mime};base64,${b64}`;
}

async function downloadAndVerifyMp4(params: {
  url: string;
  outPath: string;
  providerId: string;
  providerJobId?: string | null;
  headers?: Record<string, string>;
}): Promise<void> {
  const res = await withRetry(
    () =>
      fetch(params.url, {
        headers: params.headers,
      }),
    { maxAttempts: 3, baseDelayMs: 1200 }
  );

  if (!res.ok) {
    throw new ProviderHttpError(
      `Failed to download generated MP4 asset (${res.status} ${res.statusText}).`,
      {
        statusCode: res.status,
        providerId: params.providerId,
        providerJobId: params.providerJobId,
      }
    );
  }

  const arr = await res.arrayBuffer();
  if (arr.byteLength < 1024) {
    throw new ProviderHttpError('Downloaded video file was empty (< 1 KB).', {
      statusCode: 502,
      providerId: params.providerId,
      providerJobId: params.providerJobId,
    });
  }

  fs.mkdirSync(path.dirname(params.outPath), { recursive: true });
  fs.writeFileSync(params.outPath, Buffer.from(arr));

  const playable = await verifyPlayableVideo(params.outPath);
  if (!playable) {
    throw new ProviderHttpError(
      'Downloaded file failed MP4 playback verification (ffprobe/ffmpeg decode error).',
      {
        statusCode: 502,
        providerId: params.providerId,
        providerJobId: params.providerJobId,
      }
    );
  }
}

async function validateEditedFrameDiffersFromSource(params: {
  sourceFramePath: string;
  editedFramePath: string;
  providerId: string;
  frameIndex: number;
}): Promise<void> {
  if (!fs.existsSync(params.editedFramePath) || fs.statSync(params.editedFramePath).size < 512) {
    throw new ProviderHttpError(
      `Stage 4 edited frame #${params.frameIndex + 1} is missing or empty (< 512 bytes).`,
      { statusCode: 502, providerId: params.providerId }
    );
  }
  const ssim = await computeImageSimilaritySsim(
    params.sourceFramePath,
    params.editedFramePath
  );
  if (ssim !== null && ssim >= 0.992) {
    throw new ProviderHttpError(
      `Stage 4 output for frame #${params.frameIndex + 1} is nearly identical to source frame (SSIM=${ssim.toFixed(3)}) — original character identity was not replaced.`,
      { statusCode: 422, providerId: params.providerId }
    );
  }
}

function guessImageMime(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  return 'image/jpeg';
}

function fileToDataUrl(filePath: string): string {
  const mime = guessImageMime(filePath);
  return `data:${mime};base64,${fs.readFileSync(filePath).toString('base64')}`;
}

function getLocalWorkerBaseUrl(config: ProviderConfigRecord): string | null {
  const raw =
    config.endpointUrl?.trim() ||
    process.env[config.envVarName]?.trim() ||
    null;
  if (!raw || raw.startsWith('MY_')) return null;
  return raw.replace(/\/+$/, '');
}

function assertImageEditModelCallable(
  config: ProviderConfigRecord,
  req: FrameEditRequest
): void {
  const modelSpec = config.models.find((m) => m.id === req.modelId);
  ensureModelQuotaRecord({
    providerId: config.id,
    providerName: config.displayName,
    modelId: req.modelId,
    taskType: 'image_editing',
    freeTierEligible: modelSpec?.freeTierEligible ?? config.freeVideoEligible,
  });
  const check = canCallModel(config.id, req.modelId);
  if (!check.allowed) {
    const retryAfterSec = check.retryAfterAt
      ? Math.max(1, Math.ceil((Date.parse(check.retryAfterAt) - Date.now()) / 1000))
      : null;
    throw new ProviderQuotaError(
      check.reason || `${config.displayName} (${req.modelId}) is paused due to quota/rate limit.`,
      429,
      config.id,
      null,
      {
        retryAfterSec,
        quotaIdentifier: check.quotaIdentifier,
        dailyLimit: check.dailyLimit,
        isDailyQuota: check.status === 'daily_exhausted',
      }
    );
  }
}

// ---------------------------------------------------------------------------
// 0. Self-Hosted Open-Source GPU Worker Adapter ($0 API Fees)
// ---------------------------------------------------------------------------
const localGpuWorkerAdapter: ProviderAdapter = {
  providerType: 'local_gpu_worker',
  async testConnection(config) {
    const baseUrl = getLocalWorkerBaseUrl(config);
    if (!baseUrl) {
      return {
        connected: false,
        message:
          'Local/external open-source GPU worker endpoint URL is not configured (e.g. http://127.0.0.1:8000 or Colab tunnel running worker/gpu_worker.py).',
      };
    }
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      const res = await fetch(`${baseUrl}/health`, {
        signal: controller.signal,
      }).finally(() => clearTimeout(timer));
      if (!res.ok) {
        return {
          connected: false,
          message: `Worker health endpoint returned HTTP ${res.status}.`,
        };
      }
      const data = (await res.json()) as {
        status?: string;
        device?: string;
        models?: string[];
        capabilities?: Record<string, boolean>;
      };
      return {
        connected: data.status === 'ok' || res.ok,
        message: `Connected to Open-Source GPU Worker at ${baseUrl} (${data.device || 'ready'}${data.models?.length ? ` · ${data.models.join(', ')}` : ''}).`,
      };
    } catch (err) {
      return {
        connected: false,
        message: `Cannot reach GPU worker at ${baseUrl}: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  },
  async discoverModels(config) {
    return config.models;
  },
  async checkQuota(config) {
    const baseUrl = getLocalWorkerBaseUrl(config);
    return {
      exposedByApi: true,
      confirmedCreditsRemaining: baseUrl ? 9999 : null,
      confirmedSecondsRemaining: null,
      unitLabel: 'frames ($0 API cost)',
      note: baseUrl
        ? `Self-hosted worker configured at ${baseUrl}. $0 external API fees.`
        : 'Configure endpointUrl pointing to worker/gpu_worker.py (8–16 GB VRAM NVIDIA GPU or free Colab GPU).',
      checkedAt: new Date().toISOString(),
    };
  },
  async editCharacterFrame(config, req): Promise<FrameEditResult> {
    const baseUrl = getLocalWorkerBaseUrl(config);
    if (!baseUrl) {
      throw new ProviderHttpError(
        'Open-Source GPU Worker endpoint URL is not configured.',
        { statusCode: 400, providerId: config.id }
      );
    }

    const payload = {
      frameIndex: req.frameIndex,
      totalFrames: req.totalFrames,
      timestampSec: req.timestampSec,
      modelId: req.modelId,
      replacementScope: req.replacementScope,
      backgroundMode: req.backgroundMode,
      lightingMode: req.lightingMode,
      prompt: req.prompt,
      sourceWidth: req.sourceWidth,
      sourceHeight: req.sourceHeight,
      sourceImageBase64: fs.readFileSync(req.sourceFramePath).toString('base64'),
      maskImageBase64:
        req.unionMaskPath && fs.existsSync(req.unionMaskPath)
          ? fs.readFileSync(req.unionMaskPath).toString('base64')
          : null,
      previousEditedFrameBase64:
        req.previousEditedFramePath && fs.existsSync(req.previousEditedFramePath)
          ? fs.readFileSync(req.previousEditedFramePath).toString('base64')
          : null,
      bindings: req.bindings.map((b) => ({
        sourceCharacterId: b.sourceCharacterId,
        sourceLabel: b.sourceLabel,
        bbox: b.bbox,
        faceBox: b.faceBox ?? null,
        poseSummary: b.poseSummary,
        occluded: b.occluded,
        maskBase64:
          b.maskPath && fs.existsSync(b.maskPath)
            ? fs.readFileSync(b.maskPath).toString('base64')
            : null,
        referenceImagesBase64: [
          ...(fs.existsSync(b.targetCharacter.primaryImagePath)
            ? [fs.readFileSync(b.targetCharacter.primaryImagePath).toString('base64')]
            : []),
          ...b.targetCharacter.additionalImagePaths
            .filter((p) => fs.existsSync(p))
            .slice(0, 2)
            .map((p) => fs.readFileSync(p).toString('base64')),
        ],
        targetName: b.targetCharacter.name,
        identityPrompt: b.targetCharacter.profile?.identitySummaryPrompt || '',
      })),
      preservedCharacterLabels: req.preservedCharacterLabels,
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 90000);
    const res = await fetch(`${baseUrl}/edit-frame`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    }).finally(() => clearTimeout(timer));

    if (!res.ok) {
      const txt = await res.text();
      throw new ProviderHttpError(
        `GPU Worker /edit-frame failed (${res.status}): ${txt.slice(0, 220)}`,
        { statusCode: res.status, providerId: config.id }
      );
    }

    fs.mkdirSync(path.dirname(req.outFramePath), { recursive: true });
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('application/json')) {
      const data = (await res.json()) as {
        editedImageBase64?: string;
        modelUsed?: string;
      };
      if (!data.editedImageBase64) {
        throw new ProviderHttpError(
          'GPU Worker JSON response missing editedImageBase64.',
          { statusCode: 502, providerId: config.id }
        );
      }
      const cleanB64 = data.editedImageBase64.replace(/^data:image\/\w+;base64,/, '');
      fs.writeFileSync(req.outFramePath, Buffer.from(cleanB64, 'base64'));
      await validateEditedFrameDiffersFromSource({
        sourceFramePath: req.sourceFramePath,
        editedFramePath: req.outFramePath,
        providerId: config.id,
        frameIndex: req.frameIndex,
      });
      return {
        providerId: config.id,
        providerName: config.displayName,
        modelUsed: data.modelUsed || req.modelId,
        creditsConsumed: 1,
        estimatedCostUsd: 0,
      };
    }

    const buf = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(req.outFramePath, buf);
    await validateEditedFrameDiffersFromSource({
      sourceFramePath: req.sourceFramePath,
      editedFramePath: req.outFramePath,
      providerId: config.id,
      frameIndex: req.frameIndex,
    });
    return {
      providerId: config.id,
      providerName: config.displayName,
      modelUsed: req.modelId,
      creditsConsumed: 1,
      estimatedCostUsd: 0,
    };
  },
};

// ---------------------------------------------------------------------------
// 1. Google Gemini API Adapter
// ---------------------------------------------------------------------------
const googleGeminiAdapter: ProviderAdapter = {
  providerType: 'google_gemini',
  async testConnection(config) {
    if (!getSecret(config.envVarName)) {
      return {
        connected: false,
        message: `Server secret ${config.envVarName} is not configured in Settings > Secrets.`,
      };
    }
    const res = await checkGeminiConnection();
    return { connected: res.connected, message: res.message };
  },
  async discoverModels(config) {
    return config.models;
  },
  async checkQuota() {
    return {
      exposedByApi: false,
      confirmedCreditsRemaining: null,
      confirmedSecondsRemaining: null,
      unitLabel: 'credits',
      note: 'Quota information unavailable via Google Gemini API. gemini-4-hydrogen analysis uses free-tier RPM/TPM limits; gemini-omni-1.2-flash video generation requires a billing-enabled API key.',
      checkedAt: new Date().toISOString(),
    };
  },
  async generateVideoSegment(_config, req) {
    const res = await generateSegmentWithOmniFlash({
      sourceSegmentPath: req.sourceSegmentPath,
      outSegmentPath: req.outSegmentPath,
      durationSec: req.durationSec,
      aspectRatio: req.aspectRatio,
      sourceWidth: req.sourceWidth,
      sourceHeight: req.sourceHeight,
      resolution: req.resolution,
      qualityTier: req.qualityTier,
      characterRefs: req.characterRefs,
      mappedCharacterPairs: req.mappedCharacterPairs,
      preservedCharacterLabels: req.preservedCharacterLabels,
      replacementScope: req.replacementScope,
      backgroundMode: req.backgroundMode,
      lightingMode: req.lightingMode,
      environmentRef: req.environmentRef,
      prompt: req.prompt,
      existingProviderJobId: req.existingProviderJobId,
      projectId: req.projectId,
      projectName: req.projectName,
      onJobCreated: req.onJobCreated,
      onPollProgress: req.onPollProgress,
      isCancelled: req.isCancelled,
    });
    return {
      providerId: 'google_gemini',
      providerName: 'Google Gemini API',
      modelUsed: res.modelUsed,
      providerJobId: res.providerJobId,
      isNativeResolution: req.resolution === '1080p',
      creditsConsumed: 1,
      estimatedCostUsd: Math.round(req.durationSec * 0.15 * 100) / 100,
    };
  },
  async editCharacterFrame(config, req): Promise<FrameEditResult> {
    if (!getSecret(config.envVarName)) {
      throw new ProviderHttpError(
        `Server secret ${config.envVarName} is not configured.`,
        { statusCode: 401, providerId: config.id }
      );
    }
    const res = await editFrameWithGeminiImageModel(req);
    await validateEditedFrameDiffersFromSource({
      sourceFramePath: req.sourceFramePath,
      editedFramePath: req.outFramePath,
      providerId: config.id,
      frameIndex: req.frameIndex,
    });
    const modelSpec = config.models.find((m) => m.id === req.modelId);
    return {
      providerId: config.id,
      providerName: config.displayName,
      modelUsed: res.modelUsed,
      creditsConsumed: 1,
      estimatedCostUsd: modelSpec?.estimatedCostPerFrameUsd ?? 0.02,
    };
  },
};

// ---------------------------------------------------------------------------
// 2. Hugging Face Inference Providers Adapter (Dynamic Router Mapping)
// ---------------------------------------------------------------------------
async function resolveHfProviderRoute(
  modelId: string,
  token: string
): Promise<{
  providerKey: string;
  providerModelId: string;
  endpointUrl: string;
}> {
  try {
    const infoRes = await fetch(
      `https://huggingface.co/api/models/${modelId}?expand[]=inferenceProviderMapping`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (infoRes.ok) {
      const info = (await infoRes.json()) as {
        inferenceProviderMapping?: Record<
          string,
          { providerId?: string; status?: string; task?: string }
        >;
      };
      const mapping = info.inferenceProviderMapping;
      if (mapping) {
        const entries = Object.entries(mapping).filter(
          ([, v]) => v?.status === 'live' && v?.providerId
        );
        const preferred =
          entries.find(([k]) => k === 'fal-ai') ||
          entries.find(([k]) => k === 'hf-inference') ||
          entries.find(([k]) => k === 'replicate') ||
          entries[0];
        if (preferred) {
          const [providerKey, spec] = preferred;
          const providerModelId = spec.providerId!;
          const endpointUrl =
            providerKey === 'hf-inference'
              ? `https://router.huggingface.co/hf-inference/models/${modelId}`
              : `https://router.huggingface.co/${providerKey}/${providerModelId}`;
          return { providerKey, providerModelId, endpointUrl };
        }
      }
    }
  } catch {
    // fallback below
  }
  return {
    providerKey: 'hf-inference',
    providerModelId: modelId,
    endpointUrl: `https://router.huggingface.co/hf-inference/models/${modelId}`,
  };
}

const huggingFaceAdapter: ProviderAdapter = {
  providerType: 'huggingface',
  async testConnection(config) {
    const token = getSecret(config.envVarName);
    if (!token) {
      return {
        connected: false,
        message: `Server secret ${config.envVarName} is not configured. Add HF_TOKEN in Settings > Secrets.`,
      };
    }
    const res = await fetch('https://huggingface.co/api/whoami-v2', {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      return {
        connected: false,
        message: `Hugging Face authentication failed (${res.status}). Check HF_TOKEN.`,
      };
    }
    const data = (await res.json()) as { name?: string };
    return {
      connected: true,
      message: `Connected to Hugging Face as "${data.name ?? 'authorized user'}".`,
    };
  },
  async discoverModels(config) {
    try {
      const res = await fetch(
        'https://huggingface.co/api/models?inference_provider=all&pipeline_tag=image-to-video&sort=downloads&direction=-1&limit=5'
      );
      if (!res.ok) return config.models;
      const list = (await res.json()) as Array<{ id: string }>;
      if (!Array.isArray(list) || list.length === 0) return config.models;
      return list.map((m) => ({
        id: m.id,
        name: `${m.id} (HF Inference Router)`,
        taskType: 'video_generation',
        freeTierEligible: true,
        freeTierNotes: 'I2V only — uses HF monthly free inference credits (not V2V replacement)',
        maxDurationSec: 5,
        supportedResolutions: ['480p', '720p'],
        supportedAspectRatios: ['16:9', '9:16'],
        supportsImageToVideo: true,
        supportsVideoToVideo: false,
        supportsCharacterReference: m.id.toLowerCase().includes('wan'),
        supportsCharacterReplacement: false,
        supportsMultiCharacter: false,
        replacementWorkflow: 'i2v_only',
        characterPreservationScore: m.id.toLowerCase().includes('wan') ? 70 : 62,
        qualityScore: 76,
        motionAccuracyScore: 74,
        speedScore: 72,
        estimatedCostPerSecUsd: 0,
      }));
    } catch {
      return config.models;
    }
  },
  async checkQuota() {
    return {
      exposedByApi: false,
      confirmedCreditsRemaining: null,
      confirmedSecondsRemaining: null,
      unitLabel: 'USD inference credit',
      note: 'Quota information unavailable via API. Enter your Hugging Face billing dashboard allowance as a manual estimate.',
      checkedAt: new Date().toISOString(),
    };
  },
  async generateVideoSegment(config, req) {
    const token = getSecret(config.envVarName);
    if (!token) {
      throw new ProviderHttpError(
        'HF_TOKEN is not configured in server secrets.',
        { statusCode: 401, providerId: config.id }
      );
    }

    assertExternalModelCallable(config, req);

    const route = await resolveHfProviderRoute(req.modelId, token);
    const dataUrl = loadRefImageDataUrl(req);

    let payload: Record<string, unknown>;
    if (route.providerKey === 'fal-ai') {
      payload = {
        prompt: req.prompt,
        ...(dataUrl ? { image_url: dataUrl } : {}),
      };
    } else if (route.providerKey === 'replicate') {
      payload = {
        input: {
          prompt: req.prompt,
          ...(dataUrl ? { image: dataUrl } : {}),
        },
      };
    } else {
      payload = {
        inputs: req.prompt,
        parameters: dataUrl ? { image: dataUrl } : undefined,
      };
    }

    const res = await withRetry(
      async () => {
        if (req.isCancelled?.()) {
          throw new ProviderHttpError('Cancelled by user.', { providerId: config.id });
        }
        const r = await fetch(route.endpointUrl, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(payload),
        });
        if (r.status === 402 || r.status === 429) {
          const txt = await r.text();
          const retryHeader = r.headers.get('retry-after');
          const msg = `Hugging Face free quota or rate limit reached (${r.status}): ${txt.slice(0, 180)}`;
          const rateMeta = parseRateLimitMetadata(msg, retryHeader);
          const qErr = new ProviderQuotaError(
            msg,
            r.status,
            config.id,
            null,
            {
              retryAfterSec: rateMeta.retryAfterSec,
              quotaIdentifier: rateMeta.quotaIdentifier,
              dailyLimit: rateMeta.dailyLimit,
              isDailyQuota: rateMeta.isDailyQuota,
            }
          );
          recordExternalSubmission({ config, req, success: false, res: r, error: qErr });
          throw qErr;
        }
        if (r.status === 503 || r.status >= 500) {
          const txt = await r.text();
          throw new ProviderHttpError(
            `Hugging Face provider temporarily unavailable (${r.status}): ${txt.slice(0, 180)}`,
            { statusCode: r.status, providerId: config.id }
          );
        }
        return r;
      },
      { maxAttempts: 2, baseDelayMs: 2500 }
    );

    if (!res.ok) {
      const txt = await res.text();
      const httpErr = new ProviderHttpError(
        `Hugging Face (${route.providerKey}) error (${res.status}): ${txt.slice(0, 220)}`,
        { statusCode: res.status, providerId: config.id }
      );
      recordExternalSubmission({ config, req, success: false, res, error: httpErr });
      throw httpErr;
    }

    recordExternalSubmission({ config, req, success: true, res });

    const contentType = res.headers.get('content-type') || '';
    fs.mkdirSync(path.dirname(req.outSegmentPath), { recursive: true });
    if (contentType.includes('application/json')) {
      const json = (await res.json()) as {
        video?: { url?: string };
        url?: string;
        output?: string | string[];
      };
      const videoUrl =
        json.video?.url ||
        json.url ||
        (Array.isArray(json.output) ? json.output[0] : json.output);
      if (!videoUrl || typeof videoUrl !== 'string') {
        throw new ProviderHttpError(
          'Hugging Face response did not include a playable video binary or URL.',
          { statusCode: 502, providerId: config.id }
        );
      }
      await downloadAndVerifyMp4({
        url: videoUrl,
        outPath: req.outSegmentPath,
        providerId: config.id,
      });
    } else {
      const arr = await res.arrayBuffer();
      if (arr.byteLength < 1024) {
        throw new ProviderHttpError('Hugging Face returned an empty video payload.', {
          statusCode: 502,
          providerId: config.id,
        });
      }
      fs.writeFileSync(req.outSegmentPath, Buffer.from(arr));
      const playable = await verifyPlayableVideo(req.outSegmentPath);
      if (!playable) {
        throw new ProviderHttpError(
          'Hugging Face returned invalid video bytes that failed MP4 playback check.',
          { statusCode: 502, providerId: config.id }
        );
      }
    }

    return {
      providerId: config.id,
      providerName: config.displayName,
      modelUsed: `${req.modelId} (${route.providerKey})`,
      isNativeResolution: false,
      creditsConsumed: 1,
      estimatedCostUsd: 0,
    };
  },
  async editCharacterFrame(config, req): Promise<FrameEditResult> {
    const token = getSecret(config.envVarName);
    if (!token) {
      throw new ProviderHttpError('HF_TOKEN is not configured in server secrets.', {
        statusCode: 401,
        providerId: config.id,
      });
    }

    assertImageEditModelCallable(config, req);

    const route = await resolveHfProviderRoute(req.modelId, token);
    const primaryTarget = req.bindings[0]?.targetCharacter;
    const sourceDataUrl = fileToDataUrl(req.sourceFramePath);
    const refDataUrl =
      primaryTarget && fs.existsSync(primaryTarget.primaryImagePath)
        ? fileToDataUrl(primaryTarget.primaryImagePath)
        : undefined;
    const maskDataUrl =
      req.unionMaskPath && fs.existsSync(req.unionMaskPath)
        ? fileToDataUrl(req.unionMaskPath)
        : undefined;

    let payload: Record<string, unknown>;
    if (route.providerKey === 'fal-ai') {
      payload = {
        prompt: req.prompt,
        image_url: sourceDataUrl,
        ...(refDataUrl ? { reference_image_url: refDataUrl } : {}),
        ...(maskDataUrl ? { mask_url: maskDataUrl } : {}),
      };
    } else if (route.providerKey === 'replicate') {
      payload = {
        input: {
          prompt: req.prompt,
          input_image: sourceDataUrl,
          ...(refDataUrl ? { reference_image: refDataUrl } : {}),
          ...(maskDataUrl ? { mask: maskDataUrl } : {}),
        },
      };
    } else {
      payload = {
        inputs: fs.readFileSync(req.sourceFramePath).toString('base64'),
        parameters: {
          prompt: req.prompt,
          ...(maskDataUrl ? { mask_image: maskDataUrl } : {}),
        },
      };
    }

    const res = await fetch(route.endpointUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (res.status === 402 || res.status === 429) {
      const txt = await res.text();
      const msg = `Hugging Face image edit quota/rate limit (${res.status}): ${txt.slice(0, 180)}`;
      const rateMeta = parseRateLimitMetadata(msg, res.headers.get('retry-after'));
      const qErr = new ProviderQuotaError(msg, res.status, config.id, null, {
        retryAfterSec: rateMeta.retryAfterSec,
        quotaIdentifier: rateMeta.quotaIdentifier,
        dailyLimit: rateMeta.dailyLimit,
        isDailyQuota: rateMeta.isDailyQuota,
      });
      recordModelApiRequest({
        providerId: config.id,
        providerName: config.displayName,
        modelId: req.modelId,
        taskType: 'image_editing',
        freeTierEligible: true,
        projectId: req.projectId,
        projectName: req.projectName,
        success: false,
        error: qErr,
      });
      throw qErr;
    }

    if (!res.ok) {
      const txt = await res.text();
      throw new ProviderHttpError(
        `Hugging Face image edit failed (${res.status}): ${txt.slice(0, 220)}`,
        { statusCode: res.status, providerId: config.id }
      );
    }

    recordModelApiRequest({
      providerId: config.id,
      providerName: config.displayName,
      modelId: req.modelId,
      taskType: 'image_editing',
      freeTierEligible: true,
      projectId: req.projectId,
      projectName: req.projectName,
      success: true,
    });

    fs.mkdirSync(path.dirname(req.outFramePath), { recursive: true });
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('application/json')) {
      const json = (await res.json()) as {
        images?: Array<{ url?: string }>;
        image?: { url?: string };
        url?: string;
        output?: string | string[];
      };
      const imgUrl =
        json.images?.[0]?.url ||
        json.image?.url ||
        json.url ||
        (Array.isArray(json.output) ? json.output[0] : json.output);
      if (!imgUrl || typeof imgUrl !== 'string') {
        throw new ProviderHttpError(
          'Hugging Face image edit response contained no image URL or binary payload.',
          { statusCode: 502, providerId: config.id }
        );
      }
      const dlRes = await fetch(imgUrl);
      if (!dlRes.ok) {
        throw new ProviderHttpError(
          `Failed downloading edited image (${dlRes.status}).`,
          { statusCode: dlRes.status, providerId: config.id }
        );
      }
      fs.writeFileSync(req.outFramePath, Buffer.from(await dlRes.arrayBuffer()));
    } else {
      fs.writeFileSync(req.outFramePath, Buffer.from(await res.arrayBuffer()));
    }

    await validateEditedFrameDiffersFromSource({
      sourceFramePath: req.sourceFramePath,
      editedFramePath: req.outFramePath,
      providerId: config.id,
      frameIndex: req.frameIndex,
    });

    return {
      providerId: config.id,
      providerName: config.displayName,
      modelUsed: `${req.modelId} (${route.providerKey})`,
      creditsConsumed: 1,
      estimatedCostUsd: 0,
    };
  },
};

// ---------------------------------------------------------------------------
// 3. fal.ai Queue API Adapter
// ---------------------------------------------------------------------------
const falAiAdapter: ProviderAdapter = {
  providerType: 'fal_ai',
  async testConnection(config) {
    const key = getSecret(config.envVarName);
    if (!key) {
      return {
        connected: false,
        message: `Server secret ${config.envVarName} is not configured.`,
      };
    }
    const res = await fetch('https://api.fal.ai/v1/billing', {
      headers: { Authorization: `Key ${key}` },
    });
    if (res.status === 401 || res.status === 403) {
      return {
        connected: false,
        message: `fal.ai key rejected or lacks billing read scope (${res.status}).`,
      };
    }
    return {
      connected: res.ok,
      message: res.ok
        ? 'Connected to fal.ai Platform API.'
        : `fal.ai returned status ${res.status}.`,
    };
  },
  async discoverModels(config) {
    return config.models;
  },
  async checkQuota(config) {
    const key = getSecret(config.envVarName);
    if (!key) {
      return {
        exposedByApi: true,
        confirmedCreditsRemaining: null,
        confirmedSecondsRemaining: null,
        unitLabel: 'USD credits',
        note: 'FAL_KEY not configured.',
        checkedAt: new Date().toISOString(),
      };
    }
    try {
      const res = await fetch('https://api.fal.ai/v1/billing?expand=credits', {
        headers: { Authorization: `Key ${key}` },
      });
      if (!res.ok) {
        return {
          exposedByApi: false,
          confirmedCreditsRemaining: null,
          confirmedSecondsRemaining: null,
          unitLabel: 'USD credits',
          note: `fal.ai billing API returned ${res.status}. Ensure key has billing:usage:read permission.`,
          checkedAt: new Date().toISOString(),
        };
      }
      const data = (await res.json()) as {
        credits?: { balance?: number; remaining?: number };
        balance?: number;
      };
      const bal =
        data.credits?.remaining ?? data.credits?.balance ?? data.balance ?? null;
      return {
        exposedByApi: bal !== null,
        confirmedCreditsRemaining: bal,
        confirmedSecondsRemaining: bal !== null ? Math.floor(bal / 0.08) : null,
        unitLabel: 'USD credits',
        note:
          bal !== null
            ? `Confirmed live credit balance: $${bal.toFixed(2)}.`
            : 'Connected to fal.ai billing endpoint; credit field not present.',
        checkedAt: new Date().toISOString(),
      };
    } catch (err) {
      return {
        exposedByApi: false,
        confirmedCreditsRemaining: null,
        confirmedSecondsRemaining: null,
        unitLabel: 'USD credits',
        note: err instanceof Error ? err.message : String(err),
        checkedAt: new Date().toISOString(),
      };
    }
  },
  async generateVideoSegment(config, req) {
    const key = getSecret(config.envVarName);
    if (!key) {
      throw new ProviderHttpError('FAL_KEY is not configured in server secrets.', {
        statusCode: 401,
        providerId: config.id,
      });
    }

    assertExternalModelCallable(config, req);

    const imageDataUrl = loadRefImageDataUrl(req);
    let requestId = req.existingProviderJobId ?? null;
    let statusUrl = requestId
      ? `https://queue.fal.run/${req.modelId}/requests/${requestId}/status`
      : '';
    let responseUrl = requestId
      ? `https://queue.fal.run/${req.modelId}/requests/${requestId}`
      : '';

    if (!requestId) {
      const submitRes = await fetch(`https://queue.fal.run/${req.modelId}`, {
        method: 'POST',
        headers: {
          Authorization: `Key ${key}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          prompt: req.prompt,
          ...(imageDataUrl ? { image_url: imageDataUrl } : {}),
        }),
      });

      if (submitRes.status === 402 || submitRes.status === 429) {
        const txt = await submitRes.text();
        const msg = `fal.ai quota/rate limit reached (${submitRes.status}): ${txt.slice(0, 180)}`;
        const rateMeta = parseRateLimitMetadata(msg, submitRes.headers.get('retry-after'));
        const qErr = new ProviderQuotaError(
          msg,
          submitRes.status,
          config.id,
          null,
          {
            retryAfterSec: rateMeta.retryAfterSec,
            quotaIdentifier: rateMeta.quotaIdentifier,
            dailyLimit: rateMeta.dailyLimit,
            isDailyQuota: rateMeta.isDailyQuota,
          }
        );
        recordExternalSubmission({ config, req, success: false, res: submitRes, error: qErr });
        throw qErr;
      }
      if (!submitRes.ok) {
        const txt = await submitRes.text();
        const err = new ProviderHttpError(
          `fal.ai queue submission failed (${submitRes.status}): ${txt.slice(0, 220)}`,
          { statusCode: submitRes.status, providerId: config.id }
        );
        recordExternalSubmission({ config, req, success: false, res: submitRes, error: err });
        throw err;
      }

      recordExternalSubmission({ config, req, success: true, res: submitRes });
      const queued = (await submitRes.json()) as {
        request_id: string;
        status_url: string;
        response_url: string;
      };
      requestId = queued.request_id;
      statusUrl = queued.status_url;
      responseUrl = queued.response_url;
      req.onJobCreated?.(requestId);
    }

    const start = Date.now();
    let polls = 0;
    while (true) {
      if (req.isCancelled?.()) {
        throw new ProviderHttpError('fal.ai job cancelled by user.', {
          providerId: config.id,
          providerJobId: requestId,
        });
      }
      if (Date.now() - start > 420000) {
        throw new ProviderHttpError(
          `Timed out waiting for fal.ai job ${requestId}.`,
          { statusCode: 504, providerId: config.id, providerJobId: requestId }
        );
      }
      polls++;
      const stRes = await withRetry(
        () =>
          fetch(statusUrl, {
            headers: { Authorization: `Key ${key}` },
          }),
        { maxAttempts: 3, baseDelayMs: 1200 }
      );
      if (!stRes.ok) {
        throw new ProviderHttpError(
          `fal.ai status check failed (${stRes.status}).`,
          { statusCode: stRes.status, providerId: config.id, providerJobId: requestId }
        );
      }
      const st = (await stRes.json()) as { status?: string; error?: string };
      req.onPollProgress?.(st.status || 'IN_PROGRESS', polls);
      if (st.status === 'COMPLETED') break;
      if (st.status === 'FAILED') {
        throw new ProviderHttpError(st.error || 'fal.ai job failed.', {
          statusCode: 500,
          providerId: config.id,
          providerJobId: requestId,
        });
      }
      await new Promise((r) => setTimeout(r, 4000));
    }

    const resultRes = await fetch(responseUrl, {
      headers: { Authorization: `Key ${key}` },
    });
    if (!resultRes.ok) {
      throw new ProviderHttpError(
        `fal.ai result fetch failed (${resultRes.status}).`,
        { statusCode: resultRes.status, providerId: config.id, providerJobId: requestId }
      );
    }
    const resultJson = (await resultRes.json()) as { video?: { url?: string } };
    const videoUrl = resultJson.video?.url;
    if (!videoUrl) {
      throw new ProviderHttpError('fal.ai response did not include video.url.', {
        statusCode: 502,
        providerId: config.id,
        providerJobId: requestId,
      });
    }

    await downloadAndVerifyMp4({
      url: videoUrl,
      outPath: req.outSegmentPath,
      providerId: config.id,
      providerJobId: requestId,
    });

    return {
      providerId: config.id,
      providerName: config.displayName,
      modelUsed: req.modelId,
      providerJobId: requestId,
      isNativeResolution: false,
      creditsConsumed: 1,
      estimatedCostUsd: Math.round(req.durationSec * 0.08 * 100) / 100,
    };
  },
  async editCharacterFrame(config, req): Promise<FrameEditResult> {
    const key = getSecret(config.envVarName);
    if (!key) {
      throw new ProviderHttpError('FAL_KEY is not configured in server secrets.', {
        statusCode: 401,
        providerId: config.id,
      });
    }

    assertImageEditModelCallable(config, req);

    const sourceDataUrl = fileToDataUrl(req.sourceFramePath);
    const submitRes = await fetch(`https://queue.fal.run/${req.modelId}`, {
      method: 'POST',
      headers: {
        Authorization: `Key ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        prompt: req.prompt,
        image_url: sourceDataUrl,
      }),
    });

    if (submitRes.status === 402 || submitRes.status === 429) {
      const txt = await submitRes.text();
      const msg = `fal.ai image edit quota/rate limit (${submitRes.status}): ${txt.slice(0, 180)}`;
      const qErr = new ProviderQuotaError(msg, submitRes.status, config.id);
      recordModelApiRequest({
        providerId: config.id,
        providerName: config.displayName,
        modelId: req.modelId,
        taskType: 'image_editing',
        freeTierEligible: false,
        projectId: req.projectId,
        projectName: req.projectName,
        success: false,
        error: qErr,
      });
      throw qErr;
    }

    if (!submitRes.ok) {
      const txt = await submitRes.text();
      throw new ProviderHttpError(
        `fal.ai frame edit submission failed (${submitRes.status}): ${txt.slice(0, 220)}`,
        { statusCode: submitRes.status, providerId: config.id }
      );
    }

    const queued = (await submitRes.json()) as {
      request_id: string;
      status_url: string;
      response_url: string;
    };

    const start = Date.now();
    while (true) {
      if (Date.now() - start > 180000) {
        throw new ProviderHttpError('Timed out waiting for fal.ai frame edit.', {
          statusCode: 504,
          providerId: config.id,
          providerJobId: queued.request_id,
        });
      }
      const stRes = await fetch(queued.status_url, {
        headers: { Authorization: `Key ${key}` },
      });
      if (stRes.ok) {
        const st = (await stRes.json()) as { status?: string; error?: string };
        if (st.status === 'COMPLETED') break;
        if (st.status === 'FAILED') {
          throw new ProviderHttpError(st.error || 'fal.ai frame edit failed.', {
            statusCode: 500,
            providerId: config.id,
            providerJobId: queued.request_id,
          });
        }
      }
      await new Promise((r) => setTimeout(r, 2000));
    }

    const resultRes = await fetch(queued.response_url, {
      headers: { Authorization: `Key ${key}` },
    });
    const resultJson = (await resultRes.json()) as {
      images?: Array<{ url?: string }>;
      image?: { url?: string };
    };
    const imgUrl = resultJson.images?.[0]?.url || resultJson.image?.url;
    if (!imgUrl) {
      throw new ProviderHttpError('fal.ai frame edit returned no image URL.', {
        statusCode: 502,
        providerId: config.id,
        providerJobId: queued.request_id,
      });
    }

    const dlRes = await fetch(imgUrl);
    if (!dlRes.ok) {
      throw new ProviderHttpError(`Failed downloading fal.ai edited frame (${dlRes.status}).`, {
        statusCode: dlRes.status,
        providerId: config.id,
      });
    }
    fs.mkdirSync(path.dirname(req.outFramePath), { recursive: true });
    fs.writeFileSync(req.outFramePath, Buffer.from(await dlRes.arrayBuffer()));

    await validateEditedFrameDiffersFromSource({
      sourceFramePath: req.sourceFramePath,
      editedFramePath: req.outFramePath,
      providerId: config.id,
      frameIndex: req.frameIndex,
    });

    recordModelApiRequest({
      providerId: config.id,
      providerName: config.displayName,
      modelId: req.modelId,
      taskType: 'image_editing',
      freeTierEligible: false,
      projectId: req.projectId,
      projectName: req.projectName,
      success: true,
    });

    return {
      providerId: config.id,
      providerName: config.displayName,
      modelUsed: req.modelId,
      creditsConsumed: 1,
      estimatedCostUsd: 0.04,
    };
  },
};

// ---------------------------------------------------------------------------
// 4. Replicate Predictions API Adapter
// ---------------------------------------------------------------------------
const replicateAdapter: ProviderAdapter = {
  providerType: 'replicate',
  async testConnection(config) {
    const token = getSecret(config.envVarName);
    if (!token) {
      return {
        connected: false,
        message: `Server secret ${config.envVarName} is not configured.`,
      };
    }
    const res = await fetch('https://api.replicate.com/v1/account', {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      return {
        connected: false,
        message: `Replicate authentication failed (${res.status}).`,
      };
    }
    const data = (await res.json()) as { username?: string };
    return {
      connected: true,
      message: `Connected to Replicate as "${data.username ?? 'account'}".`,
    };
  },
  async discoverModels(config) {
    return config.models;
  },
  async checkQuota() {
    return {
      exposedByApi: false,
      confirmedCreditsRemaining: null,
      confirmedSecondsRemaining: null,
      unitLabel: 'USD credits',
      note: 'Quota information unavailable via Replicate API.',
      checkedAt: new Date().toISOString(),
    };
  },
  async generateVideoSegment(config, req) {
    const token = getSecret(config.envVarName);
    if (!token) {
      throw new ProviderHttpError(
        'REPLICATE_API_TOKEN is not configured in server secrets.',
        { statusCode: 401, providerId: config.id }
      );
    }

    assertExternalModelCallable(config, req);

    const imageDataUrl = loadRefImageDataUrl(req);
    let predId = req.existingProviderJobId ?? null;
    let pollUrl = predId
      ? `https://api.replicate.com/v1/predictions/${predId}`
      : '';

    if (!predId) {
      const submitRes = await fetch(
        `https://api.replicate.com/v1/models/${req.modelId}/predictions`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            input: {
              prompt: req.prompt,
              ...(imageDataUrl ? { first_frame_image: imageDataUrl } : {}),
            },
          }),
        }
      );

      if (submitRes.status === 402 || submitRes.status === 429) {
        const txt = await submitRes.text();
        const msg = `Replicate billing/rate limit reached (${submitRes.status}): ${txt.slice(0, 180)}`;
        const rateMeta = parseRateLimitMetadata(msg, submitRes.headers.get('retry-after'));
        const qErr = new ProviderQuotaError(
          msg,
          submitRes.status,
          config.id,
          null,
          {
            retryAfterSec: rateMeta.retryAfterSec,
            quotaIdentifier: rateMeta.quotaIdentifier,
            dailyLimit: rateMeta.dailyLimit,
            isDailyQuota: rateMeta.isDailyQuota,
          }
        );
        recordExternalSubmission({ config, req, success: false, res: submitRes, error: qErr });
        throw qErr;
      }
      if (!submitRes.ok) {
        const txt = await submitRes.text();
        const err = new ProviderHttpError(
          `Replicate prediction creation failed (${submitRes.status}): ${txt.slice(0, 220)}`,
          { statusCode: submitRes.status, providerId: config.id }
        );
        recordExternalSubmission({ config, req, success: false, res: submitRes, error: err });
        throw err;
      }

      recordExternalSubmission({ config, req, success: true, res: submitRes });
      const pred = (await submitRes.json()) as {
        id: string;
        urls?: { get?: string };
      };
      predId = pred.id;
      pollUrl =
        pred.urls?.get || `https://api.replicate.com/v1/predictions/${predId}`;
      req.onJobCreated?.(predId);
    }

    const start = Date.now();
    let polls = 0;
    let outputUrl: string | null = null;
    while (true) {
      if (req.isCancelled?.()) {
        throw new ProviderHttpError('Replicate prediction cancelled by user.', {
          providerId: config.id,
          providerJobId: predId,
        });
      }
      if (Date.now() - start > 420000) {
        throw new ProviderHttpError(
          `Timed out waiting for Replicate prediction ${predId}.`,
          { statusCode: 504, providerId: config.id, providerJobId: predId }
        );
      }
      polls++;
      const stRes = await withRetry(
        () =>
          fetch(pollUrl, {
            headers: { Authorization: `Bearer ${token}` },
          }),
        { maxAttempts: 3, baseDelayMs: 1200 }
      );
      if (!stRes.ok) {
        throw new ProviderHttpError(
          `Replicate status polling failed (${stRes.status}).`,
          { statusCode: stRes.status, providerId: config.id, providerJobId: predId }
        );
      }
      const st = (await stRes.json()) as {
        status?: string;
        error?: string;
        output?: string | string[];
      };
      req.onPollProgress?.(st.status || 'processing', polls);
      if (st.status === 'succeeded') {
        outputUrl = Array.isArray(st.output) ? st.output[0] : (st.output ?? null);
        break;
      }
      if (st.status === 'failed' || st.status === 'canceled') {
        throw new ProviderHttpError(
          st.error || `Replicate prediction ${st.status}.`,
          { statusCode: 500, providerId: config.id, providerJobId: predId }
        );
      }
      await new Promise((r) => setTimeout(r, 4000));
    }

    if (!outputUrl) {
      throw new ProviderHttpError('Replicate prediction returned no video URL.', {
        statusCode: 502,
        providerId: config.id,
        providerJobId: predId,
      });
    }

    await downloadAndVerifyMp4({
      url: outputUrl,
      outPath: req.outSegmentPath,
      providerId: config.id,
      providerJobId: predId,
    });

    return {
      providerId: config.id,
      providerName: config.displayName,
      modelUsed: req.modelId,
      providerJobId: predId,
      isNativeResolution: false,
      creditsConsumed: 1,
      estimatedCostUsd: Math.round(req.durationSec * 0.1 * 100) / 100,
    };
  },
};

// ---------------------------------------------------------------------------
// 5. Runway API v1 Adapter
// ---------------------------------------------------------------------------
const runwayAdapter: ProviderAdapter = {
  providerType: 'runway',
  async testConnection(config) {
    const key = getSecret(config.envVarName);
    if (!key) {
      return {
        connected: false,
        message: `Server secret ${config.envVarName} is not configured. Runway requires paid API credits.`,
      };
    }
    const res = await fetch('https://api.dev.runwayml.com/v1/organization', {
      headers: {
        Authorization: `Bearer ${key}`,
        'X-Runway-Version': '2024-11-06',
      },
    });
    if (!res.ok) {
      return {
        connected: false,
        message: `Runway authentication/check returned HTTP ${res.status}.`,
      };
    }
    return {
      connected: true,
      message: 'Connected to Runway Developer API (paid credits active).',
    };
  },
  async discoverModels(config) {
    return config.models;
  },
  async checkQuota() {
    return {
      exposedByApi: false,
      confirmedCreditsRemaining: null,
      confirmedSecondsRemaining: null,
      unitLabel: 'credits',
      note: 'Runway requires paid API credits and does not expose a free-tier quota.',
      checkedAt: new Date().toISOString(),
    };
  },
  async generateVideoSegment(config, req) {
    const key = getSecret(config.envVarName);
    if (!key) {
      throw new ProviderHttpError(
        'RUNWAYML_API_SECRET is not configured in server secrets.',
        { statusCode: 401, providerId: config.id }
      );
    }

    assertExternalModelCallable(config, req);

    const imageDataUrl = loadRefImageDataUrl(req);
    if (!imageDataUrl) {
      throw new ProviderHttpError(
        'Runway image_to_video requires a reference frame or character image.',
        { statusCode: 400, providerId: config.id }
      );
    }

    let taskId = req.existingProviderJobId ?? null;
    if (!taskId) {
      const submitRes = await fetch(
        'https://api.dev.runwayml.com/v1/image_to_video',
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${key}`,
            'X-Runway-Version': '2024-11-06',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: req.modelId,
            promptImage: imageDataUrl,
            promptText: req.prompt.slice(0, 1000),
            duration: req.durationSec > 6 ? 10 : 5,
            ratio: req.aspectRatio === '9:16' ? '720:1280' : '1280:720',
          }),
        }
      );

      if (submitRes.status === 402 || submitRes.status === 429) {
        const txt = await submitRes.text();
        const msg = `Runway billing/rate limit reached (${submitRes.status}): ${txt.slice(0, 180)}`;
        const rateMeta = parseRateLimitMetadata(msg, submitRes.headers.get('retry-after'));
        const qErr = new ProviderQuotaError(
          msg,
          submitRes.status,
          config.id,
          null,
          {
            retryAfterSec: rateMeta.retryAfterSec,
            quotaIdentifier: rateMeta.quotaIdentifier,
            dailyLimit: rateMeta.dailyLimit,
            isDailyQuota: rateMeta.isDailyQuota,
          }
        );
        recordExternalSubmission({ config, req, success: false, res: submitRes, error: qErr });
        throw qErr;
      }
      if (!submitRes.ok) {
        const txt = await submitRes.text();
        const err = new ProviderHttpError(
          `Runway task creation failed (${submitRes.status}): ${txt.slice(0, 220)}`,
          { statusCode: submitRes.status, providerId: config.id }
        );
        recordExternalSubmission({ config, req, success: false, res: submitRes, error: err });
        throw err;
      }

      recordExternalSubmission({ config, req, success: true, res: submitRes });
      const task = (await submitRes.json()) as { id: string };
      taskId = task.id;
      req.onJobCreated?.(taskId);
    }

    const start = Date.now();
    let polls = 0;
    let outputUrl: string | null = null;
    while (true) {
      if (req.isCancelled?.()) {
        throw new ProviderHttpError('Runway task cancelled by user.', {
          providerId: config.id,
          providerJobId: taskId,
        });
      }
      if (Date.now() - start > 420000) {
        throw new ProviderHttpError(
          `Timed out waiting for Runway task ${taskId}.`,
          { statusCode: 504, providerId: config.id, providerJobId: taskId }
        );
      }
      polls++;
      const stRes = await withRetry(
        () =>
          fetch(`https://api.dev.runwayml.com/v1/tasks/${taskId}`, {
            headers: {
              Authorization: `Bearer ${key}`,
              'X-Runway-Version': '2024-11-06',
            },
          }),
        { maxAttempts: 3, baseDelayMs: 1200 }
      );
      if (!stRes.ok) {
        throw new ProviderHttpError(
          `Runway task polling failed (${stRes.status}).`,
          { statusCode: stRes.status, providerId: config.id, providerJobId: taskId }
        );
      }
      const st = (await stRes.json()) as {
        status?: string;
        failure?: string;
        output?: string[];
      };
      req.onPollProgress?.(st.status || 'RUNNING', polls);
      if (st.status === 'SUCCEEDED') {
        outputUrl = st.output?.[0] ?? null;
        break;
      }
      if (st.status === 'FAILED' || st.status === 'CANCELLED') {
        throw new ProviderHttpError(
          st.failure || `Runway task ${st.status}.`,
          { statusCode: 500, providerId: config.id, providerJobId: taskId }
        );
      }
      await new Promise((r) => setTimeout(r, 5000));
    }

    if (!outputUrl) {
      throw new ProviderHttpError('Runway task completed without output URL.', {
        statusCode: 502,
        providerId: config.id,
        providerJobId: taskId,
      });
    }

    await downloadAndVerifyMp4({
      url: outputUrl,
      outPath: req.outSegmentPath,
      providerId: config.id,
      providerJobId: taskId,
    });

    return {
      providerId: config.id,
      providerName: config.displayName,
      modelUsed: req.modelId,
      providerJobId: taskId,
      isNativeResolution: req.resolution === '1080p',
      creditsConsumed: 1,
      estimatedCostUsd: Math.round(req.durationSec * 0.12 * 100) / 100,
    };
  },
};

// ---------------------------------------------------------------------------
// 6. Luma Dream Machine API Adapter
// ---------------------------------------------------------------------------
const lumaAdapter: ProviderAdapter = {
  providerType: 'luma',
  async testConnection(config) {
    const key = getSecret(config.envVarName);
    if (!key) {
      return {
        connected: false,
        message: `Server secret ${config.envVarName} is not configured. Luma requires paid API credits.`,
      };
    }
    const res = await fetch('https://api.lumalabs.ai/dream-machine/v1/credits', {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (res.status === 401 || res.status === 403) {
      return {
        connected: false,
        message: `Luma authentication failed (${res.status}).`,
      };
    }
    return {
      connected: res.ok,
      message: res.ok
        ? 'Connected to Luma Dream Machine API.'
        : `Luma returned HTTP ${res.status}.`,
    };
  },
  async discoverModels(config) {
    return config.models;
  },
  async checkQuota() {
    return {
      exposedByApi: false,
      confirmedCreditsRemaining: null,
      confirmedSecondsRemaining: null,
      unitLabel: 'credits',
      note: 'Luma Dream Machine requires paid API credits.',
      checkedAt: new Date().toISOString(),
    };
  },
  async generateVideoSegment(config, req) {
    const key = getSecret(config.envVarName);
    if (!key) {
      throw new ProviderHttpError(
        'LUMA_API_KEY is not configured in server secrets.',
        { statusCode: 401, providerId: config.id }
      );
    }

    assertExternalModelCallable(config, req);

    let genId = req.existingProviderJobId ?? null;
    if (!genId) {
      const submitRes = await fetch(
        'https://api.lumalabs.ai/dream-machine/v1/generations',
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${key}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            prompt: req.prompt,
            model: req.modelId,
            aspect_ratio: req.aspectRatio === '9:16' ? '9:16' : '16:9',
            resolution: req.resolution,
          }),
        }
      );

      if (submitRes.status === 402 || submitRes.status === 429) {
        const txt = await submitRes.text();
        const msg = `Luma quota/rate limit reached (${submitRes.status}): ${txt.slice(0, 180)}`;
        const rateMeta = parseRateLimitMetadata(msg, submitRes.headers.get('retry-after'));
        const qErr = new ProviderQuotaError(
          msg,
          submitRes.status,
          config.id,
          null,
          {
            retryAfterSec: rateMeta.retryAfterSec,
            quotaIdentifier: rateMeta.quotaIdentifier,
            dailyLimit: rateMeta.dailyLimit,
            isDailyQuota: rateMeta.isDailyQuota,
          }
        );
        recordExternalSubmission({ config, req, success: false, res: submitRes, error: qErr });
        throw qErr;
      }
      if (!submitRes.ok) {
        const txt = await submitRes.text();
        const err = new ProviderHttpError(
          `Luma generation creation failed (${submitRes.status}): ${txt.slice(0, 220)}`,
          { statusCode: submitRes.status, providerId: config.id }
        );
        recordExternalSubmission({ config, req, success: false, res: submitRes, error: err });
        throw err;
      }

      recordExternalSubmission({ config, req, success: true, res: submitRes });
      const gen = (await submitRes.json()) as { id: string };
      genId = gen.id;
      req.onJobCreated?.(genId);
    }

    const start = Date.now();
    let polls = 0;
    let outputUrl: string | null = null;
    while (true) {
      if (req.isCancelled?.()) {
        throw new ProviderHttpError('Luma generation cancelled by user.', {
          providerId: config.id,
          providerJobId: genId,
        });
      }
      if (Date.now() - start > 420000) {
        throw new ProviderHttpError(
          `Timed out waiting for Luma generation ${genId}.`,
          { statusCode: 504, providerId: config.id, providerJobId: genId }
        );
      }
      polls++;
      const stRes = await withRetry(
        () =>
          fetch(`https://api.lumalabs.ai/dream-machine/v1/generations/${genId}`, {
            headers: { Authorization: `Bearer ${key}` },
          }),
        { maxAttempts: 3, baseDelayMs: 1200 }
      );
      if (!stRes.ok) {
        throw new ProviderHttpError(
          `Luma polling failed (${stRes.status}).`,
          { statusCode: stRes.status, providerId: config.id, providerJobId: genId }
        );
      }
      const st = (await stRes.json()) as {
        state?: string;
        failure_reason?: string;
        assets?: { video?: string };
      };
      req.onPollProgress?.(st.state || 'dreaming', polls);
      if (st.state === 'completed') {
        outputUrl = st.assets?.video ?? null;
        break;
      }
      if (st.state === 'failed') {
        throw new ProviderHttpError(
          st.failure_reason || 'Luma generation failed.',
          { statusCode: 500, providerId: config.id, providerJobId: genId }
        );
      }
      await new Promise((r) => setTimeout(r, 5000));
    }

    if (!outputUrl) {
      throw new ProviderHttpError('Luma generation completed without video URL.', {
        statusCode: 502,
        providerId: config.id,
        providerJobId: genId,
      });
    }

    await downloadAndVerifyMp4({
      url: outputUrl,
      outPath: req.outSegmentPath,
      providerId: config.id,
      providerJobId: genId,
    });

    return {
      providerId: config.id,
      providerName: config.displayName,
      modelUsed: req.modelId,
      providerJobId: genId,
      isNativeResolution: req.resolution === '1080p',
      creditsConsumed: 1,
      estimatedCostUsd: Math.round(req.durationSec * 0.12 * 100) / 100,
    };
  },
};

const ADAPTER_REGISTRY: Record<ProviderId, ProviderAdapter> = {
  local_gpu_worker: localGpuWorkerAdapter,
  google_gemini: googleGeminiAdapter,
  huggingface: huggingFaceAdapter,
  fal_ai: falAiAdapter,
  replicate: replicateAdapter,
  runway: runwayAdapter,
  luma: lumaAdapter,
};

export function getProviderAdapter(providerType: ProviderId): ProviderAdapter {
  return ADAPTER_REGISTRY[providerType];
}

export async function runProviderHealthCheck(
  config: ProviderConfigRecord
): Promise<ProviderConfigRecord> {
  const adapter = getProviderAdapter(config.providerType);
  const conn = await adapter.testConnection(config);
  const quota: ProviderQuotaInfo = await adapter.checkQuota(config);
  const models: ProviderModelSpec[] = await adapter.discoverModels(config);

  const updated: ProviderConfigRecord = {
    ...config,
    connectionStatus: !config.enabled
      ? 'disabled'
      : conn.connected
        ? 'connected'
        : isProviderConfigured(config)
          ? 'error'
          : 'unconfigured',
    lastCheckedAt: new Date().toISOString(),
    lastError: conn.connected ? null : conn.message,
    confirmedQuota: quota,
    models,
  };
  return updated;
}

export type {
  FrameEditRequest,
  FrameEditResult,
  SegmentGenerationRequest,
  SegmentGenerationResult,
};
