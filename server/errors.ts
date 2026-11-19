import type {
  ErrorDiagnosticDetail,
  FailureCategory,
  ProcessingStageKey,
} from './types.ts';

export class ProviderHttpError extends Error {
  statusCode: number | null;
  providerId: string;
  providerJobId?: string | null;
  technicalDetails?: string;
  retryAfterSec?: number | null;
  quotaIdentifier?: string | null;
  dailyLimit?: number | null;
  isDailyQuota?: boolean;

  constructor(
    message: string,
    opts: {
      statusCode?: number | null;
      providerId: string;
      providerJobId?: string | null;
      technicalDetails?: string;
      retryAfterSec?: number | null;
      quotaIdentifier?: string | null;
      dailyLimit?: number | null;
      isDailyQuota?: boolean;
    }
  ) {
    super(message);
    this.statusCode = opts.statusCode ?? null;
    this.providerId = opts.providerId;
    this.providerJobId = opts.providerJobId ?? null;
    this.technicalDetails = opts.technicalDetails ?? message;
    this.retryAfterSec = opts.retryAfterSec ?? null;
    this.quotaIdentifier = opts.quotaIdentifier ?? null;
    this.dailyLimit = opts.dailyLimit ?? null;
    this.isDailyQuota = opts.isDailyQuota ?? false;
  }
}

export class QuotaExhaustedError extends ProviderHttpError {
  constructor(
    message: string,
    opts: {
      statusCode?: number | null;
      providerId: string;
      providerJobId?: string | null;
      retryAfterSec?: number | null;
      quotaIdentifier?: string | null;
      dailyLimit?: number | null;
      isDailyQuota?: boolean;
    }
  ) {
    super(message, {
      statusCode: opts.statusCode ?? 429,
      providerId: opts.providerId,
      providerJobId: opts.providerJobId,
      retryAfterSec: opts.retryAfterSec,
      quotaIdentifier: opts.quotaIdentifier,
      dailyLimit: opts.dailyLimit,
      isDailyQuota: opts.isDailyQuota ?? true,
    });
  }
}

export function sanitizeSecretText(input: string): string {
  if (!input) return '';
  return input
    .replace(/AIza[0-9A-Za-z\-_]{20,}/g, '[REDACTED_KEY]')
    .replace(/hf_[0-9A-Za-z]{16,}/g, '[REDACTED_TOKEN]')
    .replace(/r8_[0-9A-Za-z]{16,}/g, '[REDACTED_TOKEN]')
    .replace(/fal_[0-9A-Za-z\-_]{16,}/g, '[REDACTED_KEY]')
    .replace(/(Bearer|Key)\s+[A-Za-z0-9\-_.:/+=]{12,}/gi, '$1 [REDACTED]')
    .replace(/key=[A-Za-z0-9\-_]{12,}/gi, 'key=[REDACTED]');
}

export function extractHttpStatusFromError(err: unknown): number | null {
  if (!err || typeof err !== 'object') return null;
  const anyErr = err as {
    statusCode?: unknown;
    status?: unknown;
    response?: { status?: unknown };
    message?: unknown;
  };

  if (typeof anyErr.statusCode === 'number') return anyErr.statusCode;
  if (typeof anyErr.status === 'number') return anyErr.status;
  if (typeof anyErr.response?.status === 'number') return anyErr.response.status;

  const msg = typeof anyErr.message === 'string' ? anyErr.message : String(err);
  const codeMatch = msg.match(
    /\b(400|401|402|403|404|408|413|415|422|429|500|502|503|504)\b/
  );
  if (codeMatch) return Number(codeMatch[1]);
  return null;
}

export function parseRetryAfterHeader(headerVal: string | null | undefined): number | null {
  if (!headerVal) return null;
  const trimmed = headerVal.trim();
  if (/^\d+$/.test(trimmed)) {
    return Math.max(1, Number(trimmed));
  }
  const dateMs = Date.parse(trimmed);
  if (!Number.isNaN(dateMs)) {
    const diffSec = Math.ceil((dateMs - Date.now()) / 1000);
    return diffSec > 0 ? diffSec : 1;
  }
  return null;
}

export interface RateLimitMetadata {
  isQuotaOrRateLimit: boolean;
  isDailyQuota: boolean;
  quotaIdentifier: string | null;
  dailyLimit: number | null;
  retryAfterSec: number | null;
}

export function parseRateLimitMetadata(
  err: unknown,
  retryAfterHeader?: string | null
): RateLimitMetadata {
  const status = extractHttpStatusFromError(err);
  const rawMsg = err instanceof Error ? err.message : String(err ?? '');
  const lower = rawMsg.toLowerCase();

  let quotaId: string | null =
    err instanceof ProviderHttpError && err.quotaIdentifier
      ? err.quotaIdentifier
      : null;
  let dailyLimit: number | null =
    err instanceof ProviderHttpError && typeof err.dailyLimit === 'number'
      ? err.dailyLimit
      : null;
  let retryAfterSec: number | null =
    err instanceof ProviderHttpError && typeof err.retryAfterSec === 'number'
      ? err.retryAfterSec
      : parseRetryAfterHeader(retryAfterHeader);
  let isDailyQuota =
    err instanceof ProviderHttpError ? Boolean(err.isDailyQuota) : false;

  if (!quotaId) {
    const qidMatch =
      rawMsg.match(/quotaId["':\s]+([A-Za-z0-9\-_]+)/i) ||
      rawMsg.match(/(GenerateRequestsPerDayPerModel-FreeTier|GenerateContentInputTokensPerModelPerMinute-FreeTier|[A-Za-z0-9]+PerDay[A-Za-z0-9\-_]*)/);
    if (qidMatch) quotaId = qidMatch[1];
  }

  if (dailyLimit === null) {
    const limMatch =
      rawMsg.match(/quotaValue["':\s]+(\d+)/i) ||
      rawMsg.match(/limit[:\s]+(\d+)/i);
    if (limMatch) dailyLimit = Number(limMatch[1]);
  }

  if (retryAfterSec === null) {
    const delayMatch =
      rawMsg.match(/retryDelay["':\s]+"?(\d+)(?:\.\d+)?s"?/i) ||
      rawMsg.match(/retry in\s+(\d+(?:\.\d+)?)s/i);
    if (delayMatch) {
      retryAfterSec = Math.max(1, Math.ceil(Number(delayMatch[1])));
    }
  }

  if (
    lower.includes('perday') ||
    lower.includes('per day') ||
    lower.includes('requestsperday') ||
    lower.includes('daily') ||
    (quotaId && /perday/i.test(quotaId)) ||
    status === 402
  ) {
    isDailyQuota = true;
  }

  const isQuotaOrRateLimit =
    err instanceof QuotaExhaustedError ||
    status === 429 ||
    status === 402 ||
    lower.includes('resource_exhausted') ||
    lower.includes('rate limit') ||
    lower.includes('quota');

  return {
    isQuotaOrRateLimit,
    isDailyQuota,
    quotaIdentifier: quotaId,
    dailyLimit,
    retryAfterSec,
  };
}

export function isTransientRetryableError(err: unknown): boolean {
  if (err instanceof QuotaExhaustedError) return false;
  const meta = parseRateLimitMetadata(err);
  if (meta.isDailyQuota) {
    // NEVER retry daily quota exhaustion — stop immediately and fail over
    return false;
  }

  const status = extractHttpStatusFromError(err);
  if (status === 401 || status === 402 || status === 403 || status === 400 || status === 404) {
    return false;
  }

  if (status === 429) {
    // Only retry short transient RPM 429s when official retryDelay is short (<= 12s)
    return meta.retryAfterSec !== null && meta.retryAfterSec <= 12;
  }

  if (status && [408, 500, 502, 503, 504].includes(status)) {
    return true;
  }

  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return (
    msg.includes('timeout') ||
    msg.includes('timed out') ||
    msg.includes('econnreset') ||
    msg.includes('etimedout') ||
    msg.includes('fetch failed') ||
    msg.includes('temporarily unavailable') ||
    msg.includes('model is currently loading')
  );
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: {
    maxAttempts?: number;
    baseDelayMs?: number;
    shouldRetry?: (err: unknown) => boolean;
    onRetry?: (attempt: number, delayMs: number, err: unknown) => void;
  } = {}
): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? 3;
  const baseDelayMs = opts.baseDelayMs ?? 1500;
  const shouldRetry = opts.shouldRetry ?? isTransientRetryableError;

  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt >= maxAttempts || !shouldRetry(err)) {
        throw err;
      }
      const meta = parseRateLimitMetadata(err);
      const jitter = Math.floor(Math.random() * 400);
      const computedDelay =
        meta.retryAfterSec !== null
          ? meta.retryAfterSec * 1000 + jitter
          : baseDelayMs * Math.pow(2, attempt - 1) + jitter;
      const cappedDelay = Math.min(computedDelay, 16000);
      opts.onRetry?.(attempt, cappedDelay, err);
      await new Promise((resolve) => setTimeout(resolve, cappedDelay));
    }
  }
  throw lastErr;
}

export class MissingStageDependencyError extends ProviderHttpError {
  missingDependencies: string[];

  constructor(
    message: string,
    opts: {
      providerId?: string;
      missingDependencies?: string[];
    } = {}
  ) {
    super(message, {
      statusCode: 424,
      providerId: opts.providerId ?? 'orchestrator',
    });
    this.missingDependencies = opts.missingDependencies ?? [];
  }
}

export function classifyPipelineError(
  err: unknown,
  ctx: {
    stage: ProcessingStageKey | string;
    provider: string;
    model?: string;
    providerJobId?: string | null;
    retryAfterAt?: string | null;
    missingDependencies?: string[];
  }
): ErrorDiagnosticDetail {
  const raw = err instanceof Error ? err.message : String(err);
  const technicalError = sanitizeSecretText(raw);
  const httpStatus = extractHttpStatusFromError(err);
  const lower = technicalError.toLowerCase();
  const rateMeta = parseRateLimitMetadata(err);

  const providerJobId =
    err instanceof ProviderHttpError && err.providerJobId
      ? err.providerJobId
      : (ctx.providerJobId ?? null);

  const missingDependencies =
    err instanceof MissingStageDependencyError && err.missingDependencies.length > 0
      ? err.missingDependencies
      : ctx.missingDependencies;

  let failureCategory: FailureCategory = 'processing_error';
  let userMessage: string;

  if (
    err instanceof MissingStageDependencyError ||
    lower.includes('missing stage 4') ||
    lower.includes('stage 4 character replacement engine unavailable') ||
    lower.includes('missing_stage_dependency')
  ) {
    failureCategory = 'missing_stage_dependency';
    userMessage = technicalError;
  } else if (
    ctx.stage === 'uploading' ||
    ctx.stage === 'stage_1_ingestion' ||
    lower.includes('unsupported video') ||
    lower.includes('invalid video') ||
    lower.includes('exceeds the 60-second')
  ) {
    failureCategory = 'processing_error';
    userMessage = `Upload/ingestion failed: ${technicalError}`;
  } else if (
    httpStatus === 401 ||
    httpStatus === 403 ||
    lower.includes('api_key_invalid') ||
    lower.includes('permission_denied') ||
    lower.includes('not configured') ||
    lower.includes('authentication failed') ||
    lower.includes('unauthorized')
  ) {
    failureCategory = 'auth_failed';
    userMessage = `API authentication failed (${ctx.provider}): Verify your API secret/token in AI Studio Settings > Secrets.`;
  } else if (
    ctx.stage === 'verifying_continuity' ||
    ctx.stage === 'stage_5_temporal_consistency' ||
    lower.includes('quality control failed') ||
    lower.includes('original character remained visible') ||
    lower.includes('identity did not match')
  ) {
    failureCategory = 'qc_failed';
    userMessage = `Character Replacement QC Failed: ${technicalError}`;
  } else if (
    lower.includes('does not include free video') ||
    lower.includes('unsupported video generation') ||
    lower.includes('unsupported_video_generation') ||
    lower.includes('no free external generative video') ||
    lower.includes('no connected provider currently exposes active free generative video') ||
    lower.includes('genuine video-to-video character replacement') ||
    lower.includes('supports video-to-video character replacement') ||
    lower.includes('does not support video-to-video character replacement')
  ) {
    failureCategory = 'unsupported_video_generation';
    userMessage = `Unsupported Character Replacement Configuration: ${technicalError}`;
  } else if (rateMeta.isQuotaOrRateLimit) {
    failureCategory = 'quota_exhausted';
    const limitNote =
      rateMeta.dailyLimit !== null ? ` (limit: ${rateMeta.dailyLimit}/day)` : '';
    const qidNote = rateMeta.quotaIdentifier ? ` [${rateMeta.quotaIdentifier}]` : '';
    userMessage = rateMeta.isDailyQuota
      ? `Daily free-tier quota exhausted on ${ctx.provider}${ctx.model ? ` (${ctx.model})` : ''}${limitNote}${qidNote}. Retrying this model is paused until quota resets; switch providers or resume after reset.`
      : `Rate limit reached on ${ctx.provider}${ctx.model ? ` (${ctx.model})` : ''} (HTTP ${httpStatus ?? 429}). Wait ${rateMeta.retryAfterSec ?? 'a few'}s or use another compatible provider.`;
  } else if (
    httpStatus === 404 ||
    httpStatus === 502 ||
    httpStatus === 503 ||
    httpStatus === 504 ||
    lower.includes('unavailable') ||
    lower.includes('fetch failed') ||
    lower.includes('timed out')
  ) {
    failureCategory = 'provider_unavailable';
    userMessage = `Provider unavailable (${ctx.provider}): Upstream service returned HTTP ${httpStatus ?? 'error'} or timed out. Retry shortly or switch providers.`;
  } else if (
    ctx.stage === 'validating_output' ||
    ctx.stage === 'stage_6_video_reconstruction' ||
    lower.includes('download')
  ) {
    failureCategory = 'processing_error';
    userMessage = `Reconstruction/validation failed: ${technicalError}`;
  } else {
    failureCategory = 'processing_error';
    userMessage = `Processing error: ${technicalError}`;
  }

  return {
    stage: ctx.stage,
    provider: ctx.provider,
    model: ctx.model,
    httpStatus,
    failureCategory,
    quotaIdentifier: rateMeta.quotaIdentifier,
    dailyLimit: rateMeta.dailyLimit,
    retryAfterAt:
      ctx.retryAfterAt ??
      (rateMeta.retryAfterSec
        ? new Date(Date.now() + rateMeta.retryAfterSec * 1000).toISOString()
        : null),
    providerJobId,
    ...(missingDependencies && missingDependencies.length > 0
      ? { missingDependencies }
      : {}),
    userMessage,
    technicalError,
    timestamp: new Date().toISOString(),
  };
}
