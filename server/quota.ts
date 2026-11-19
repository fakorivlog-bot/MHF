import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import {
  extractHttpStatusFromError,
  parseRateLimitMetadata,
  sanitizeSecretText,
} from './errors.ts';
import type {
  DetectedCharacter,
  DirectorBlueprint,
  ModelQuotaRecord,
  ModelRateLimitStatus,
  ProjectQuotaUsageRecord,
} from './types.ts';

const DATA_DIR = path.join(process.cwd(), 'data');
const QUOTA_STATE_FILE = path.join(DATA_DIR, 'quota_state.json');
const ANALYSIS_CACHE_FILE = path.join(DATA_DIR, 'analysis_cache.json');

fs.mkdirSync(DATA_DIR, { recursive: true });

interface QuotaStateStore {
  models: Record<string, ModelQuotaRecord>;
  projects: Record<string, ProjectQuotaUsageRecord>;
  cacheHitsByDay: Record<string, number>;
}

export interface CachedAnalysisRecord {
  cacheKey: string;
  createdAt: string;
  analyzedByModel: string;
  detectedCharacters: DetectedCharacter[];
  blueprint: DirectorBlueprint;
  transcript: string;
}

function readJsonSafe<T>(filePath: string, fallback: T): T {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(filePath: string, data: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, filePath);
}

/**
 * Google AI Studio Free Tier daily quotas reset at midnight Pacific Time (America/Los_Angeles).
 */
export function getPacificDayKey(date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

export function getNextPacificMidnightIso(now = new Date()): string {
  // Compute current PT hour/minute/second and add remaining seconds to midnight PT
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(now);
  const h = Number(parts.find((p) => p.type === 'hour')?.value ?? '0') % 24;
  const m = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
  const s = Number(parts.find((p) => p.type === 'second')?.value ?? '0');
  const elapsedSec = h * 3600 + m * 60 + s;
  const remainingSec = Math.max(60, 86400 - elapsedSec);
  return new Date(now.getTime() + remainingSec * 1000).toISOString();
}

function loadQuotaState(): QuotaStateStore {
  const store = readJsonSafe<QuotaStateStore>(QUOTA_STATE_FILE, {
    models: {},
    projects: {},
    cacheHitsByDay: {},
  });
  const today = getPacificDayKey();

  // Roll over daily counters cleanly when day changes
  for (const [key, rec] of Object.entries(store.models)) {
    if (rec.dayKey !== today) {
      rec.dayKey = today;
      rec.usedRequestsToday = 0;
      rec.remainingRequestsToday =
        rec.confirmedDailyLimit !== null ? rec.confirmedDailyLimit : null;
      if (rec.rateLimitStatus === 'daily_exhausted' || rec.rateLimitStatus === 'rate_limited') {
        rec.rateLimitStatus = 'available';
        rec.retryAfterAt = null;
        rec.resetAt = null;
        rec.lastError = null;
      }
      store.models[key] = rec;
    } else {
      // Clear expired short cooldown or passed reset time
      const nowMs = Date.now();
      if (
        rec.rateLimitStatus === 'rate_limited' &&
        rec.retryAfterAt &&
        nowMs > Date.parse(rec.retryAfterAt)
      ) {
        rec.rateLimitStatus = 'available';
        rec.retryAfterAt = null;
      }
      if (
        rec.rateLimitStatus === 'daily_exhausted' &&
        rec.resetAt &&
        nowMs > Date.parse(rec.resetAt)
      ) {
        rec.rateLimitStatus = 'available';
        rec.resetAt = null;
        rec.usedRequestsToday = 0;
        rec.remainingRequestsToday =
          rec.confirmedDailyLimit !== null ? rec.confirmedDailyLimit : null;
      }
    }
  }
  return store;
}

function modelKey(providerId: string, modelId: string): string {
  return `${providerId}::${modelId}`;
}

export function ensureModelQuotaRecord(params: {
  providerId: string;
  providerName: string;
  modelId: string;
  taskType: 'analysis' | 'image_editing' | 'video_generation' | 'audio_generation';
  freeTierEligible: boolean;
}): ModelQuotaRecord {
  const store = loadQuotaState();
  const key = modelKey(params.providerId, params.modelId);
  const existing = store.models[key];
  if (existing) return existing;

  const rec: ModelQuotaRecord = {
    providerId: params.providerId,
    providerName: params.providerName,
    modelId: params.modelId,
    taskType: params.taskType,
    freeTierEligible: params.freeTierEligible,
    confirmedDailyLimit: null, // Never invent limits until API or official error reports one
    usedRequestsToday: 0,
    remainingRequestsToday: null,
    rateLimitStatus: 'available',
    quotaIdentifier: null,
    retryAfterAt: null,
    resetAt: null,
    lastUpdatedAt: new Date().toISOString(),
    lastHttpStatus: null,
    lastError: null,
    dayKey: getPacificDayKey(),
  };
  store.models[key] = rec;
  writeJsonAtomic(QUOTA_STATE_FILE, store);
  return rec;
}

export function canCallModel(
  providerId: string,
  modelId: string
): {
  allowed: boolean;
  status: ModelRateLimitStatus;
  reason?: string;
  retryAfterAt: string | null;
  resetAt: string | null;
  quotaIdentifier: string | null;
  dailyLimit: number | null;
} {
  const store = loadQuotaState();
  const rec = store.models[modelKey(providerId, modelId)];
  if (!rec) {
    return {
      allowed: true,
      status: 'available',
      retryAfterAt: null,
      resetAt: null,
      quotaIdentifier: null,
      dailyLimit: null,
    };
  }

  const nowMs = Date.now();
  if (rec.rateLimitStatus === 'daily_exhausted') {
    const resetMsg = rec.resetAt
      ? `Resets at ${new Date(rec.resetAt).toLocaleString()}.`
      : 'Waiting for daily quota reset.';
    return {
      allowed: false,
      status: 'daily_exhausted',
      reason: `Daily quota exhausted for ${modelId}${rec.confirmedDailyLimit !== null ? ` (${rec.confirmedDailyLimit} req/day)` : ''}${rec.quotaIdentifier ? ` [${rec.quotaIdentifier}]` : ''}. ${resetMsg}`,
      retryAfterAt: rec.retryAfterAt,
      resetAt: rec.resetAt,
      quotaIdentifier: rec.quotaIdentifier,
      dailyLimit: rec.confirmedDailyLimit,
    };
  }

  if (
    rec.rateLimitStatus === 'rate_limited' &&
    rec.retryAfterAt &&
    nowMs < Date.parse(rec.retryAfterAt)
  ) {
    const waitSec = Math.max(
      1,
      Math.ceil((Date.parse(rec.retryAfterAt) - nowMs) / 1000)
    );
    return {
      allowed: false,
      status: 'rate_limited',
      reason: `${modelId} is rate-limited for ${waitSec}s (respecting provider Retry-After).`,
      retryAfterAt: rec.retryAfterAt,
      resetAt: rec.resetAt,
      quotaIdentifier: rec.quotaIdentifier,
      dailyLimit: rec.confirmedDailyLimit,
    };
  }

  return {
    allowed: true,
    status: rec.rateLimitStatus,
    retryAfterAt: rec.retryAfterAt,
    resetAt: rec.resetAt,
    quotaIdentifier: rec.quotaIdentifier,
    dailyLimit: rec.confirmedDailyLimit,
  };
}

export function recordModelApiRequest(params: {
  providerId: string;
  providerName: string;
  modelId: string;
  taskType: 'analysis' | 'image_editing' | 'video_generation' | 'audio_generation';
  freeTierEligible: boolean;
  projectId?: string | null;
  projectName?: string | null;
  success: boolean;
  error?: unknown;
  retryAfterHeader?: string | null;
  confirmedLimitHeader?: number | null;
  remainingHeader?: number | null;
}): ModelQuotaRecord {
  const store = loadQuotaState();
  const today = getPacificDayKey();
  const key = modelKey(params.providerId, params.modelId);

  const rec: ModelQuotaRecord = store.models[key] ?? {
    providerId: params.providerId,
    providerName: params.providerName,
    modelId: params.modelId,
    taskType: params.taskType,
    freeTierEligible: params.freeTierEligible,
    confirmedDailyLimit: null,
    usedRequestsToday: 0,
    remainingRequestsToday: null,
    rateLimitStatus: 'available',
    quotaIdentifier: null,
    retryAfterAt: null,
    resetAt: null,
    lastUpdatedAt: new Date().toISOString(),
    lastHttpStatus: null,
    lastError: null,
    dayKey: today,
  };

  rec.usedRequestsToday += 1;
  rec.lastUpdatedAt = new Date().toISOString();

  if (typeof params.confirmedLimitHeader === 'number') {
    rec.confirmedDailyLimit = params.confirmedLimitHeader;
  }

  let failed429 = false;
  if (params.success) {
    rec.rateLimitStatus = 'available';
    rec.lastHttpStatus = 200;
    rec.lastError = null;
    rec.retryAfterAt = null;
    if (typeof params.remainingHeader === 'number') {
      rec.remainingRequestsToday = params.remainingHeader;
    } else if (rec.confirmedDailyLimit !== null) {
      rec.remainingRequestsToday = Math.max(
        0,
        rec.confirmedDailyLimit - rec.usedRequestsToday
      );
    }
  } else {
    const httpStatus = extractHttpStatusFromError(params.error);
    const rateMeta = parseRateLimitMetadata(params.error, params.retryAfterHeader);
    const errText = sanitizeSecretText(
      params.error instanceof Error
        ? params.error.message
        : String(params.error ?? 'Unknown error')
    );

    rec.lastHttpStatus = httpStatus;
    rec.lastError = errText.slice(0, 320);

    if (rateMeta.dailyLimit !== null) {
      rec.confirmedDailyLimit = rateMeta.dailyLimit;
    }
    if (rateMeta.quotaIdentifier) {
      rec.quotaIdentifier = rateMeta.quotaIdentifier;
    }

    if (httpStatus === 401 || httpStatus === 403) {
      rec.rateLimitStatus = 'auth_failed';
    } else if (rateMeta.isQuotaOrRateLimit) {
      failed429 = true;
      if (rateMeta.isDailyQuota) {
        rec.rateLimitStatus = 'daily_exhausted';
        rec.remainingRequestsToday = 0;
        rec.resetAt =
          params.providerId === 'google_gemini'
            ? getNextPacificMidnightIso()
            : rateMeta.retryAfterSec
              ? new Date(Date.now() + rateMeta.retryAfterSec * 1000).toISOString()
              : null;
        rec.retryAfterAt = rec.resetAt;
      } else {
        rec.rateLimitStatus = 'rate_limited';
        const waitSec = rateMeta.retryAfterSec ?? 60;
        rec.retryAfterAt = new Date(Date.now() + waitSec * 1000).toISOString();
      }
    } else if (httpStatus && httpStatus >= 500) {
      rec.rateLimitStatus = 'unavailable';
      rec.retryAfterAt = new Date(Date.now() + 60 * 1000).toISOString();
    }
  }

  store.models[key] = rec;

  if (params.projectId) {
    const pKey = `${params.projectId}::${today}`;
    const pRec: ProjectQuotaUsageRecord = store.projects[pKey] ?? {
      projectId: params.projectId,
      projectName: params.projectName || params.projectId,
      dayKey: today,
      byProviderModel: {},
    };
    const subKey = `${params.providerId}::${params.modelId}`;
    const sub = pRec.byProviderModel[subKey] ?? {
      providerId: params.providerId,
      modelId: params.modelId,
      requestsMade: 0,
      succeeded: 0,
      failed429: 0,
      lastUsedAt: new Date().toISOString(),
    };
    sub.requestsMade += 1;
    if (params.success) sub.succeeded += 1;
    if (failed429) sub.failed429 += 1;
    sub.lastUsedAt = new Date().toISOString();
    pRec.byProviderModel[subKey] = sub;
    store.projects[pKey] = pRec;
  }

  writeJsonAtomic(QUOTA_STATE_FILE, store);
  return rec;
}

export function getQuotaTrackingSummary(): {
  modelQuotas: ModelQuotaRecord[];
  projectQuotas: ProjectQuotaUsageRecord[];
  cacheStats: { cachedEntries: number; cacheHitsToday: number };
} {
  const store = loadQuotaState();
  const today = getPacificDayKey();
  const cacheMap = readJsonSafe<Record<string, CachedAnalysisRecord>>(
    ANALYSIS_CACHE_FILE,
    {}
  );
  return {
    modelQuotas: Object.values(store.models).sort((a, b) =>
      a.providerName.localeCompare(b.providerName)
    ),
    projectQuotas: Object.values(store.projects)
      .filter((p) => p.dayKey === today)
      .sort((a, b) => a.projectName.localeCompare(b.projectName)),
    cacheStats: {
      cachedEntries: Object.keys(cacheMap).length,
      cacheHitsToday: store.cacheHitsByDay[today] ?? 0,
    },
  };
}

// ---------------------------------------------------------------------------
// Reusable Analysis Cache (Zero Duplicate Gemini Calls for Unchanged Inputs)
// ---------------------------------------------------------------------------
export function computeAnalysisCacheKey(input: {
  sourceFileName: string;
  sourceFileSizeBytes: number;
  sourceDurationSec: number;
  characterIds: string[];
  environmentId: string | null;
  environmentVideoName: string | null;
  instruction: string;
  mode: string;
}): string {
  const canonical = JSON.stringify({
    f: input.sourceFileName,
    s: input.sourceFileSizeBytes,
    d: input.sourceDurationSec,
    c: [...input.characterIds].sort(),
    e: input.environmentId,
    ev: input.environmentVideoName,
    i: input.instruction.trim().toLowerCase(),
    m: input.mode,
  });
  return crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 32);
}

export function getCachedAnalysis(cacheKey: string): CachedAnalysisRecord | null {
  const cache = readJsonSafe<Record<string, CachedAnalysisRecord>>(
    ANALYSIS_CACHE_FILE,
    {}
  );
  const hit = cache[cacheKey] ?? null;
  if (hit) {
    const store = loadQuotaState();
    const today = getPacificDayKey();
    store.cacheHitsByDay[today] = (store.cacheHitsByDay[today] ?? 0) + 1;
    writeJsonAtomic(QUOTA_STATE_FILE, store);
  }
  return hit;
}

export function saveCachedAnalysis(
  cacheKey: string,
  payload: Omit<CachedAnalysisRecord, 'cacheKey' | 'createdAt'>
): void {
  const cache = readJsonSafe<Record<string, CachedAnalysisRecord>>(
    ANALYSIS_CACHE_FILE,
    {}
  );
  const entries = Object.entries(cache);
  if (entries.length > 60) {
    // Keep most recent 50 cached entries
    const trimmed = Object.fromEntries(entries.slice(-50));
    trimmed[cacheKey] = {
      cacheKey,
      createdAt: new Date().toISOString(),
      ...payload,
    };
    writeJsonAtomic(ANALYSIS_CACHE_FILE, trimmed);
    return;
  }
  cache[cacheKey] = {
    cacheKey,
    createdAt: new Date().toISOString(),
    ...payload,
  };
  writeJsonAtomic(ANALYSIS_CACHE_FILE, cache);
}
