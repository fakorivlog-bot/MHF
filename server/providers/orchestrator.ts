import {
  extractHttpStatusFromError,
  MissingStageDependencyError,
  parseRateLimitMetadata,
  ProviderHttpError,
  QuotaExhaustedError,
} from '../errors.ts';
import {
  canCallModel,
  ensureModelQuotaRecord,
  getQuotaTrackingSummary,
} from '../quota.ts';
import {
  isEnvSecretSet,
  isProviderConfigured,
  listProviders,
  listUsageLedger,
} from '../store.ts';
import type {
  BillingMode,
  OutputResolution,
  ReplacementScope,
  TransformationMode,
} from '../types.ts';
import { getProviderAdapter, ProviderQuotaError } from './adapters.ts';
import type {
  FrameEditRequest,
  FrameEditResult,
  ProviderConfigRecord,
  ProviderModelSpec,
  SegmentGenerationRequest,
  SegmentGenerationResult,
} from './types.ts';

export interface RankedModelCandidate {
  provider: ProviderConfigRecord;
  model: ProviderModelSpec;
  compositeScore: number;
  reason: string;
}

// Temporary cooldown map when a provider returns rate-limits or 5xx outages
const temporaryCooldownUntil = new Map<string, number>();

export function markProviderCooldown(providerId: string, durationMs = 120000): void {
  temporaryCooldownUntil.set(providerId, Date.now() + durationMs);
}

export function isProviderInCooldown(providerId: string): boolean {
  const until = temporaryCooldownUntil.get(providerId);
  if (!until) return false;
  if (Date.now() > until) {
    temporaryCooldownUntil.delete(providerId);
    return false;
  }
  return true;
}

export function isCharacterReplacementMode(
  mode: TransformationMode,
  hasCharacterRef: boolean
): boolean {
  return (
    mode === 'character_replacement' ||
    mode === 'cinematic_recreation_with_character' ||
    hasCharacterRef
  );
}

export function selectCandidateModels(params: {
  billingMode: BillingMode;
  mode: TransformationMode;
  resolution: OutputResolution;
  hasCharacterRef: boolean;
  requiresCharacterReplacement?: boolean;
  requiresMultiCharacter?: boolean;
  excludeProviderIds?: Set<string>;
}): RankedModelCandidate[] {
  const providers = listProviders();
  const candidates: RankedModelCandidate[] = [];
  const mustReplaceCharacter =
    params.requiresCharacterReplacement ??
    isCharacterReplacementMode(params.mode, params.hasCharacterRef);

  for (const provider of providers) {
    if (!provider.enabled) continue;
    if (params.excludeProviderIds?.has(provider.id)) continue;
    if (isProviderInCooldown(provider.id)) continue;
    if (!isProviderConfigured(provider)) continue;

    // Strict free-first discipline: never consider non-free-video providers in Free Mode
    if (params.billingMode === 'free' && !provider.freeVideoEligible) {
      continue;
    }

    const adapter = getProviderAdapter(provider.providerType);
    if (!adapter.generateVideoSegment) continue;

    for (const model of provider.models) {
      if (model.taskType !== 'video_generation') continue;

      if (params.billingMode === 'free' && !model.freeTierEligible) {
        continue;
      }

      // CRITICAL: Never select I2V-only or T2V-only models for character replacement!
      // Character replacement requires true Video-to-Video + Reference Identity conditioning.
      const supportsV2VReplacement =
        model.supportsVideoToVideo === true &&
        model.supportsCharacterReference === true &&
        (model.supportsCharacterReplacement ?? true);

      if (mustReplaceCharacter && !supportsV2VReplacement) {
        continue;
      }

      // Skip any model already marked daily_exhausted or active Retry-After cooldown
      const quotaCheck = canCallModel(provider.id, model.id);
      if (!quotaCheck.allowed) {
        continue;
      }

      if (
        params.billingMode === 'free' &&
        provider.manualEstimate.dailyCreditsRemaining === 0 &&
        provider.confirmedQuota.confirmedCreditsRemaining === null
      ) {
        continue;
      }

      let score = 0;
      if (model.freeTierEligible) score += 1000;
      if (params.hasCharacterRef || mustReplaceCharacter) {
        score += model.characterPreservationScore * 3.0;
        if (model.supportsCharacterReference) score += 60;
        if (supportsV2VReplacement) score += 250;
        if (params.requiresMultiCharacter && model.supportsMultiCharacter) {
          score += 120;
        }
      } else {
        score += model.characterPreservationScore * 1.0;
      }

      if (model.supportsVideoToVideo) {
        score += 120;
      }

      score += model.qualityScore * 1.5;
      score += model.motionAccuracyScore * 1.2;
      if (model.supportedResolutions.includes(params.resolution)) {
        score += 40;
      }
      score += Math.min(20, model.maxDurationSec) * 2;
      score += model.speedScore * 0.5;

      const reasonParts = [
        model.freeTierEligible ? 'Free-tier eligible' : 'Paid-tier',
        `Identity ${model.characterPreservationScore}/100`,
        supportsV2VReplacement
          ? 'V2V Character Replacement'
          : model.supportsVideoToVideo
            ? 'V2V editing'
            : 'I2V synthesis only',
        `Max ${model.maxDurationSec}s`,
      ];

      candidates.push({
        provider,
        model,
        compositeScore: Math.round(score),
        reason: reasonParts.join(' · '),
      });
    }
  }

  return candidates.sort((a, b) => b.compositeScore - a.compositeScore);
}

export function selectStage4ImageEditCandidates(params: {
  billingMode: BillingMode;
  replacementScope?: ReplacementScope;
  resolution: OutputResolution;
  requiresMultiCharacter?: boolean;
  excludeProviderIds?: Set<string>;
}): RankedModelCandidate[] {
  const providers = listProviders();
  const candidates: RankedModelCandidate[] = [];
  const scope: ReplacementScope =
    params.replacementScope ?? 'full_character_replacement';

  for (const provider of providers) {
    if (!provider.enabled) continue;
    if (params.excludeProviderIds?.has(provider.id)) continue;
    if (isProviderInCooldown(provider.id)) continue;
    if (!isProviderConfigured(provider)) continue;

    // Strict free-first discipline: in Free Mode, only allow free-tier Stage 4 models
    // (local_gpu_worker or free-tier HuggingFace Inference Router image-edit models)
    if (params.billingMode === 'free' && !provider.freeVideoEligible) {
      continue;
    }

    const adapter = getProviderAdapter(provider.providerType);
    if (!adapter.editCharacterFrame) continue;

    for (const model of provider.models) {
      if (model.taskType !== 'image_editing') continue;
      if (params.billingMode === 'free' && !model.freeTierEligible) continue;
      if (model.supportsCharacterReplacement === false) continue;

      if (scope === 'full_character_replacement' && model.supportsFullBodyReplacement === false) {
        continue;
      }
      if (scope === 'face_replacement' && model.supportsFaceOnlyReplacement === false) {
        continue;
      }

      const quotaCheck = canCallModel(provider.id, model.id);
      if (!quotaCheck.allowed) continue;

      let score = 0;
      if (provider.providerType === 'local_gpu_worker') score += 1400;
      else if (model.freeTierEligible) score += 1100;
      else score += 500;

      score += model.characterPreservationScore * 3.0;
      score += model.qualityScore * 1.4;
      score += model.motionAccuracyScore * 1.1;
      if (params.requiresMultiCharacter && model.supportsMultiCharacter) score += 120;
      if (model.supportedResolutions.includes(params.resolution)) score += 30;
      score += model.speedScore * 0.4;

      const reasonParts = [
        provider.providerType === 'local_gpu_worker'
          ? 'Self-hosted GPU ($0 API fee)'
          : model.freeTierEligible
            ? 'Free-tier Stage 4 editor'
            : 'Paid API Stage 4 editor',
        scope === 'full_character_replacement' ? 'Full-body + Face swap' : 'Face + Head swap',
        `Identity ${model.characterPreservationScore}/100`,
      ];

      candidates.push({
        provider,
        model,
        compositeScore: Math.round(score),
        reason: reasonParts.join(' · '),
      });
    }
  }

  return candidates.sort((a, b) => b.compositeScore - a.compositeScore);
}

export async function editFrameWithFailover(params: {
  billingMode: BillingMode;
  replacementScope: ReplacementScope;
  resolution: OutputResolution;
  requiresMultiCharacter?: boolean;
  requestBase: Omit<FrameEditRequest, 'modelId'>;
  onAttemptLog?: (msg: string, level: 'info' | 'warning' | 'error' | 'success') => void;
}): Promise<FrameEditResult> {
  const candidates = selectStage4ImageEditCandidates({
    billingMode: params.billingMode,
    replacementScope: params.replacementScope,
    resolution: params.resolution,
    requiresMultiCharacter: params.requiresMultiCharacter,
  });

  if (candidates.length === 0) {
    throw new MissingStageDependencyError(
      'Stage 4 character replacement engine is not configured or reachable.',
      {
        providerId: 'orchestrator',
        missingDependencies: ['stage_4_character_replacement'],
      }
    );
  }

  let lastError: unknown = new Error('All Stage 4 image editing adapters failed.');
  for (const candidate of candidates) {
    const adapter = getProviderAdapter(candidate.provider.providerType);
    if (!adapter.editCharacterFrame) continue;

    try {
      const res = await adapter.editCharacterFrame(candidate.provider, {
        ...params.requestBase,
        modelId: candidate.model.id,
      });
      return res;
    } catch (err) {
      lastError = err;
      const msg = err instanceof Error ? err.message : String(err);
      const httpStatus = extractHttpStatusFromError(err);
      const rateMeta = parseRateLimitMetadata(err);

      if (
        err instanceof QuotaExhaustedError ||
        err instanceof ProviderQuotaError ||
        rateMeta.isQuotaOrRateLimit ||
        httpStatus === 429 ||
        httpStatus === 402
      ) {
        const cooldownMs = rateMeta.isDailyQuota
          ? 3600 * 1000
          : rateMeta.retryAfterSec
            ? rateMeta.retryAfterSec * 1000
            : 180000;
        markProviderCooldown(candidate.provider.id, cooldownMs);
        params.onAttemptLog?.(
          `Stage 4 adapter ${candidate.provider.displayName} (${candidate.model.id}) hit quota/rate limit — failing over to next Stage 4 adapter...`,
          'warning'
        );
      } else {
        params.onAttemptLog?.(
          `Stage 4 adapter ${candidate.provider.displayName} (${candidate.model.id}) error on frame #${params.requestBase.frameIndex + 1}: ${msg}`,
          'warning'
        );
      }
    }
  }

  throw lastError;
}

export interface PipelineCapabilityMatrix {
  videoAnalysis: 'ready' | 'unavailable';
  characterDetection: 'ready' | 'unavailable';
  characterTracking: 'ready' | 'unavailable';
  imageBasedReplacement: 'ready' | 'unavailable';
  temporalConsistency: 'ready' | 'unavailable';
  fullBodyReplacement: 'ready' | 'unavailable';
  multiCharacterReplacement: 'ready' | 'unavailable';
  videoReconstruction: 'ready' | 'unavailable';
}

export interface Stage4SetupOption {
  id: string;
  label: string;
  costLabel: string;
  hardwareRequirement: string;
  instructions: string;
}

export interface TaskCapabilityReport {
  isCharacterReplacementTask: boolean;
  billingMode: BillingMode;
  activeWorkflow: 'native_v2v' | 'multistage_frame_replacement' | 'legacy_recreation' | 'blocked';
  nativeV2vAvailable: boolean;
  multiStageAvailable: boolean;
  canRunPartialStages1To3: boolean;
  stage4AdapterName: string | null;
  stage4ModelId: string | null;
  stage4HardwareNote: string | null;
  stage4CostEstimateNote: string | null;
  hasAnalysisConnected: boolean;
  hasVideoInputSupport: boolean;
  hasCharacterReferenceSupport: boolean;
  hasCharacterReplacementSupport: boolean;
  hasMultiCharacterSupport: boolean;
  freeReplacementCandidatesCount: number;
  paidReplacementCandidatesCount: number;
  freeStage4CandidatesCount: number;
  paidStage4CandidatesCount: number;
  activeCandidates: RankedModelCandidate[];
  stage4Candidates: RankedModelCandidate[];
  pipelineCapabilities: PipelineCapabilityMatrix;
  missingStage4SetupOptions: Stage4SetupOption[];
  blockingReason: string | null;
}

export function buildMissingStage4SetupOptions(): Stage4SetupOption[] {
  return [
    {
      id: 'local_gpu_worker',
      label: 'Self-Hosted Open-Source GPU Worker (ControlNet + IP-Adapter + InsightFace)',
      costLabel: '$0 API fees',
      hardwareRequirement: '8–16 GB VRAM NVIDIA GPU (local PC or free Google Colab T4/L4)',
      instructions:
        'Start worker/gpu_worker.py on your GPU machine or Colab, then paste its HTTP/HTTPS URL into API Settings -> Open-Source Local GPU Worker (no API keys needed).',
    },
    {
      id: 'huggingface_token',
      label: 'Hugging Face Inference Providers (Qwen-Image-Edit / FLUX.1-Kontext-dev)',
      costLabel: '$0 up to monthly free credit',
      hardwareRequirement: 'No local GPU required (runs on HF serverless cloud)',
      instructions:
        'Add HF_TOKEN in AI Studio Secrets with Inference Providers permission for reference-conditioned frame editing.',
    },
    {
      id: 'paid_gemini_or_fal',
      label: 'Paid Mode: Gemini 3.1 Flash Image / Nano Banana 2.1 / fal.ai Kontext Pro / Omni V2V',
      costLabel: '~$0.02–$0.04/frame or $0.15/sec video',
      hardwareRequirement: 'No local GPU required (cloud API)',
      instructions:
        'Enable Paid Mode and confirm billing for GEMINI_API_KEY (or configure FAL_KEY) to unlock cloud frame editing or native Omni V2V.',
    },
  ];
}

export function inspectTaskCapabilities(params: {
  billingMode: BillingMode;
  mode: TransformationMode;
  resolution: OutputResolution;
  hasCharacterRef: boolean;
  replacementScope?: ReplacementScope;
  requiresMultiCharacter?: boolean;
}): TaskCapabilityReport {
  const isReplacement = isCharacterReplacementMode(
    params.mode,
    params.hasCharacterRef
  );
  const scope: ReplacementScope =
    params.replacementScope ?? 'full_character_replacement';

  const freeV2vCandidates = selectCandidateModels({
    billingMode: 'free',
    mode: params.mode,
    resolution: params.resolution,
    hasCharacterRef: params.hasCharacterRef,
    requiresCharacterReplacement: isReplacement,
    requiresMultiCharacter: params.requiresMultiCharacter,
  });
  const paidV2vCandidates = selectCandidateModels({
    billingMode: 'paid',
    mode: params.mode,
    resolution: params.resolution,
    hasCharacterRef: params.hasCharacterRef,
    requiresCharacterReplacement: isReplacement,
    requiresMultiCharacter: params.requiresMultiCharacter,
  });

  const freeStage4Candidates = selectStage4ImageEditCandidates({
    billingMode: 'free',
    replacementScope: scope,
    resolution: params.resolution,
    requiresMultiCharacter: params.requiresMultiCharacter,
  });
  const paidStage4Candidates = selectStage4ImageEditCandidates({
    billingMode: 'paid',
    replacementScope: scope,
    resolution: params.resolution,
    requiresMultiCharacter: params.requiresMultiCharacter,
  });

  const activeV2v =
    params.billingMode === 'free' ? freeV2vCandidates : paidV2vCandidates;
  const activeStage4 =
    params.billingMode === 'free' ? freeStage4Candidates : paidStage4Candidates;

  const topV2v = activeV2v[0] ?? null;
  const topStage4 = activeStage4[0] ?? null;

  const nativeV2vAvailable = Boolean(
    topV2v &&
      topV2v.model.supportsVideoToVideo &&
      topV2v.model.supportsCharacterReference &&
      (topV2v.model.supportsCharacterReplacement ?? true)
  );
  const multiStageAvailable = Boolean(topStage4);

  const hasAnalysisConnected = isEnvSecretSet('GEMINI_API_KEY');
  const activeWorkflow: TaskCapabilityReport['activeWorkflow'] = !isReplacement
    ? 'legacy_recreation'
    : multiStageAvailable
      ? 'multistage_frame_replacement'
      : nativeV2vAvailable
        ? 'native_v2v'
        : 'blocked';

  const canRunPartialStages1To3 = true; // FFmpeg ingestion/frames/masks & local/Gemini detection always run locally

  const pipelineCapabilities: PipelineCapabilityMatrix = {
    videoAnalysis: hasAnalysisConnected ? 'ready' : 'ready', // Gemini + FFmpeg deterministic fallback
    characterDetection: hasAnalysisConnected ? 'ready' : 'ready',
    characterTracking: hasAnalysisConnected ? 'ready' : 'ready',
    imageBasedReplacement:
      multiStageAvailable || nativeV2vAvailable ? 'ready' : 'unavailable',
    temporalConsistency: 'ready', // Host FFmpeg SSIM + neighbor re-conditioning engine ready
    fullBodyReplacement:
      (topStage4?.model.supportsFullBodyReplacement ?? false) ||
      (topV2v?.model.supportsFullBodyReplacement ?? false)
        ? 'ready'
        : 'unavailable',
    multiCharacterReplacement:
      (topStage4?.model.supportsMultiCharacter ?? false) ||
      (topV2v?.model.supportsMultiCharacter ?? false)
        ? 'ready'
        : 'unavailable',
    videoReconstruction: 'ready', // Local FFmpeg MP4 + audio mux reconstruction ready
  };

  let blockingReason: string | null = null;
  if (isReplacement && !multiStageAvailable && !nativeV2vAvailable) {
    blockingReason =
      params.billingMode === 'free'
        ? 'Stages 1–3 (Video Ingestion, Frame Extraction, Subject Tracking & Segmentation Masks) and Stage 5–6 (Temporal QA & FFmpeg Video Reconstruction) are Ready. Stage 4 (AI Image-Based Character Replacement) needs either a connected Open-Source Local GPU Worker ($0 API fee), HF_TOKEN (HF Inference free credits), or Paid Mode.'
        : 'Stages 1–3 & 5–6 are Ready. Stage 4 needs either GEMINI_API_KEY, FAL_KEY, HF_TOKEN, or an Open-Source Local GPU Worker.';
  }

  return {
    isCharacterReplacementTask: isReplacement,
    billingMode: params.billingMode,
    activeWorkflow,
    nativeV2vAvailable,
    multiStageAvailable,
    canRunPartialStages1To3,
    stage4AdapterName:
      topStage4?.provider.displayName ??
      (nativeV2vAvailable ? topV2v?.provider.displayName ?? null : null),
    stage4ModelId:
      topStage4?.model.id ?? (nativeV2vAvailable ? topV2v?.model.id ?? null : null),
    stage4HardwareNote:
      topStage4?.model.hardwareRequirement ??
      topStage4?.provider.hardwareRequirement ??
      null,
    stage4CostEstimateNote: topStage4
      ? topStage4.model.estimatedCostPerFrameUsd === 0
        ? '$0 API fees (free-tier / local worker)'
        : `~$${(topStage4.model.estimatedCostPerFrameUsd ?? 0.02).toFixed(2)}/frame`
      : nativeV2vAvailable
        ? `~$${topV2v?.model.estimatedCostPerSecUsd.toFixed(2)}/sec`
        : null,
    hasAnalysisConnected,
    hasVideoInputSupport: nativeV2vAvailable || multiStageAvailable,
    hasCharacterReferenceSupport: nativeV2vAvailable || multiStageAvailable,
    hasCharacterReplacementSupport: nativeV2vAvailable || multiStageAvailable,
    hasMultiCharacterSupport:
      pipelineCapabilities.multiCharacterReplacement === 'ready',
    freeReplacementCandidatesCount:
      freeStage4Candidates.length + freeV2vCandidates.length,
    paidReplacementCandidatesCount:
      paidStage4Candidates.length + paidV2vCandidates.length,
    freeStage4CandidatesCount: freeStage4Candidates.length,
    paidStage4CandidatesCount: paidStage4Candidates.length,
    activeCandidates: activeV2v,
    stage4Candidates: activeStage4,
    pipelineCapabilities,
    missingStage4SetupOptions:
      multiStageAvailable || nativeV2vAvailable
        ? []
        : buildMissingStage4SetupOptions(),
    blockingReason,
  };
}

export async function generateSegmentWithFailover(params: {
  billingMode: BillingMode;
  mode: TransformationMode;
  resolution: OutputResolution;
  requiresCharacterReplacement?: boolean;
  requiresMultiCharacter?: boolean;
  requestBase: Omit<SegmentGenerationRequest, 'modelId'>;
  preferredProviderName?: string;
  onAttemptStart?: (providerName: string, modelId: string) => void;
  onAttemptLog: (msg: string, level: 'info' | 'warning' | 'error' | 'success') => void;
  onFailedAttempt?: (
    providerName: string,
    modelId: string,
    errMsg: string,
    httpStatus: number | null,
    jobId: string | null
  ) => void;
}): Promise<SegmentGenerationResult> {
  const hasCharRef =
    params.requestBase.characterRefs.length > 0 ||
    (params.requestBase.mappedCharacterPairs?.length ?? 0) > 0;
  const mustReplace =
    params.requiresCharacterReplacement ??
    isCharacterReplacementMode(params.mode, hasCharRef);

  const candidates = selectCandidateModels({
    billingMode: params.billingMode,
    mode: params.mode,
    resolution: params.resolution,
    hasCharacterRef: hasCharRef,
    requiresCharacterReplacement: mustReplace,
    requiresMultiCharacter: params.requiresMultiCharacter,
  });

  if (candidates.length === 0) {
    throw new ProviderHttpError(
      mustReplace
        ? params.billingMode === 'free'
          ? 'No connected provider supports genuine video-to-video character replacement in Free Mode (I2V-only models cannot perform source-video identity replacement).'
          : 'No connected provider supports genuine video-to-video character replacement.'
        : params.billingMode === 'free'
          ? 'No connected provider currently offers an active free video-generation endpoint.'
          : 'No paid video generation provider is currently enabled and configured.',
      { statusCode: 400, providerId: 'orchestrator' }
    );
  }

  // If resuming an existing providerJobId, prioritize matching provider first to avoid duplicate submissions
  const ordered = params.requestBase.existingProviderJobId && params.preferredProviderName
    ? [
        ...candidates.filter((c) => c.provider.displayName === params.preferredProviderName),
        ...candidates.filter((c) => c.provider.displayName !== params.preferredProviderName),
      ]
    : candidates;

  let lastError: unknown = new Error('All compatible providers failed.');

  for (const candidate of ordered) {
    if (params.requestBase.isCancelled?.()) {
      throw new ProviderHttpError('Cancelled by user.', {
        providerId: candidate.provider.id,
      });
    }
    const adapter = getProviderAdapter(candidate.provider.providerType);
    if (!adapter.generateVideoSegment) continue;

    params.onAttemptStart?.(candidate.provider.displayName, candidate.model.id);
    params.onAttemptLog(
      `Submitting to ${candidate.provider.displayName} (${candidate.model.id}) — ${candidate.reason}`,
      'info'
    );

    const sameJobProvider =
      params.requestBase.existingProviderJobId &&
      params.preferredProviderName === candidate.provider.displayName;

    try {
      const result = await adapter.generateVideoSegment(candidate.provider, {
        ...params.requestBase,
        existingProviderJobId: sameJobProvider
          ? params.requestBase.existingProviderJobId
          : null,
        modelId: candidate.model.id,
      });
      return result;
    } catch (err) {
      lastError = err;
      const msg = err instanceof Error ? err.message : String(err);
      const httpStatus = extractHttpStatusFromError(err);
      const jobId =
        err instanceof ProviderHttpError ? (err.providerJobId ?? null) : null;

      params.onFailedAttempt?.(
        candidate.provider.displayName,
        candidate.model.id,
        msg,
        httpStatus,
        jobId
      );

      const rateMeta = parseRateLimitMetadata(err);
      if (
        err instanceof QuotaExhaustedError ||
        err instanceof ProviderQuotaError ||
        rateMeta.isQuotaOrRateLimit ||
        httpStatus === 429 ||
        httpStatus === 402
      ) {
        const cooldownMs = rateMeta.isDailyQuota
          ? 3600 * 1000
          : rateMeta.retryAfterSec
            ? rateMeta.retryAfterSec * 1000
            : 180000;
        markProviderCooldown(candidate.provider.id, cooldownMs);
        params.onAttemptLog(
          `Stopped retrying exhausted model ${candidate.provider.displayName} (${candidate.model.id}) — ${rateMeta.isDailyQuota ? 'daily quota exhausted' : 'rate limited'}${rateMeta.quotaIdentifier ? ` [${rateMeta.quotaIdentifier}]` : ''}. Checking next compatible provider...`,
          'warning'
        );
      } else if (httpStatus === 401 || httpStatus === 403) {
        markProviderCooldown(candidate.provider.id, 300000);
        params.onAttemptLog(
          `Authentication rejected by ${candidate.provider.displayName} (HTTP ${httpStatus}). Trying next eligible provider...`,
          'warning'
        );
      } else if (httpStatus && httpStatus >= 500) {
        markProviderCooldown(candidate.provider.id, 90000);
        params.onAttemptLog(
          `Provider ${candidate.provider.displayName} unavailable (HTTP ${httpStatus}): ${msg}. Failing over to next compatible provider...`,
          'warning'
        );
      } else {
        params.onAttemptLog(
          `Provider ${candidate.provider.displayName} (${candidate.model.id}) failed: ${msg}. Trying next eligible provider...`,
          'warning'
        );
      }
    }
  }

  throw lastError;
}

export function buildQuotaDashboardSummary() {
  const providers = listProviders();
  const ledger = listUsageLedger();

  const now = new Date();
  const startOfDay = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate()
  ).getTime();
  const startOfMonth = new Date(
    now.getFullYear(),
    now.getMonth(),
    1
  ).getTime();

  let secondsToday = 0;
  let secondsThisMonth = 0;
  let totalSegments = 0;
  let totalEstimatedCostUsd = 0;
  let freeRuns = 0;
  let paidRuns = 0;
  let failedAttempts = 0;

  const consumedByProvider: Record<
    string,
    { credits: number; seconds: number; failed: number }
  > = {};

  for (const entry of ledger) {
    const ts = new Date(entry.timestamp).getTime();
    if (!consumedByProvider[entry.provider]) {
      consumedByProvider[entry.provider] = { credits: 0, seconds: 0, failed: 0 };
    }
    if (entry.status === 'failed') {
      failedAttempts += 1;
      consumedByProvider[entry.provider].failed += 1;
      continue;
    }

    totalSegments += entry.segmentsCount;
    totalEstimatedCostUsd =
      Math.round((totalEstimatedCostUsd + entry.estimatedCostUsd) * 100) / 100;
    if (entry.billingMode === 'free') freeRuns += 1;
    else paidRuns += 1;

    if (ts >= startOfDay) secondsToday += entry.secondsGenerated;
    if (ts >= startOfMonth) secondsThisMonth += entry.secondsGenerated;

    consumedByProvider[entry.provider].credits += entry.creditsConsumed ?? 0;
    consumedByProvider[entry.provider].seconds += entry.secondsGenerated;
  }

  let totalConfirmedFreeCredits: number | null = null;
  let totalManualDailyCredits = 0;
  let totalManualMonthlyCredits = 0;
  let totalManualEstimatedSeconds = 0;
  let hasAnyManualEstimate = false;

  for (const p of providers) {
    if (!p.enabled) continue;
    for (const m of p.models) {
      ensureModelQuotaRecord({
        providerId: p.id,
        providerName: p.displayName,
        modelId: m.id,
        taskType: m.taskType,
        freeTierEligible: m.freeTierEligible,
      });
    }
    if (
      p.freeVideoEligible &&
      p.confirmedQuota.exposedByApi &&
      p.confirmedQuota.confirmedCreditsRemaining !== null
    ) {
      totalConfirmedFreeCredits =
        (totalConfirmedFreeCredits ?? 0) +
        p.confirmedQuota.confirmedCreditsRemaining;
    }
    if (p.manualEstimate.dailyCreditsRemaining !== null) {
      totalManualDailyCredits += p.manualEstimate.dailyCreditsRemaining;
      hasAnyManualEstimate = true;
    }
    if (p.manualEstimate.monthlyCreditsRemaining !== null) {
      totalManualMonthlyCredits += p.manualEstimate.monthlyCreditsRemaining;
      hasAnyManualEstimate = true;
    }
    if (p.manualEstimate.estimatedSecondsRemaining !== null) {
      totalManualEstimatedSeconds += p.manualEstimate.estimatedSecondsRemaining;
      hasAnyManualEstimate = true;
    }
  }

  const quotaTracking = getQuotaTrackingSummary();

  return {
    totals: {
      totalConfirmedFreeCredits,
      hasConfirmedFreeVideoQuota: totalConfirmedFreeCredits !== null,
      manualEstimatedDailyCredits: hasAnyManualEstimate
        ? totalManualDailyCredits
        : null,
      manualEstimatedMonthlyCredits: hasAnyManualEstimate
        ? totalManualMonthlyCredits
        : null,
      manualEstimatedSecondsRemaining: hasAnyManualEstimate
        ? totalManualEstimatedSeconds
        : null,
      secondsGeneratedToday: secondsToday,
      minutesGeneratedToday: Math.round((secondsToday / 60) * 100) / 100,
      minutesGeneratedThisMonth: Math.round((secondsThisMonth / 60) * 100) / 100,
      totalSegments,
      totalSeconds: secondsThisMonth,
      totalEstimatedCostUsd,
      freeRuns,
      paidRuns,
      failedAttempts,
    },
    consumedByProvider,
    modelQuotas: quotaTracking.modelQuotas,
    projectQuotas: quotaTracking.projectQuotas,
    cacheStats: quotaTracking.cacheStats,
    providers,
    entries: ledger,
  };
}
