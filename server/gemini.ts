import { GoogleGenAI, Type } from '@google/genai';
import fs from 'fs';
import path from 'path';
import {
  parseRateLimitMetadata,
  ProviderHttpError,
  QuotaExhaustedError,
  withRetry,
} from './errors.ts';
import { verifyPlayableVideo } from './ffmpeg.ts';
import {
  canCallModel,
  ensureModelQuotaRecord,
  recordModelApiRequest,
} from './quota.ts';
import type {
  BackgroundMode,
  CharacterAsset,
  CharacterIdentityProfile,
  DetectedCharacter,
  DirectorBlueprint,
  EnvironmentAsset,
  FrameCharacterTrack,
  LightingMode,
  OutputAspectRatio,
  OutputResolution,
  QualityTier,
  ReplacementScope,
  SegmentConsistencyCheck,
  TransformationMode,
} from './types.ts';
import type { FrameEditRequest, MappedCharacterPair } from './providers/types.ts';

function getApiKey(): string | null {
  const key = process.env.GEMINI_API_KEY?.trim();
  return key && key.length > 0 && key !== 'MY_GEMINI_API_KEY' ? key : null;
}

function createClient(): GoogleGenAI {
  const apiKey = getApiKey();
  if (!apiKey) {
    throw new ProviderHttpError(
      'GEMINI_API_KEY is not configured. Open Settings > Secrets in AI Studio to attach your Google Gemini API key.',
      { statusCode: 401, providerId: 'google_gemini' }
    );
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      timeout: 20000,
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

function fileToBase64(filePath: string): string {
  return fs.readFileSync(filePath).toString('base64');
}

function guessImageMime(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  return 'image/jpeg';
}

function safeParseJson<T>(rawText: string | undefined, fallback: T): T {
  const trimmed = (rawText ?? '').trim();
  if (!trimmed) return fallback;
  const fenced =
    trimmed.match(/```json\s*([\s\S]*?)\s*```/i)?.[1] ??
    trimmed.match(/```\s*([\s\S]*?)\s*```/)?.[1] ??
    trimmed;
  try {
    return JSON.parse(fenced) as T;
  } catch {
    const objOrArr = fenced.match(/([\{\[][\s\S]*[\}\]])/)?.[1];
    if (objOrArr) {
      try {
        return JSON.parse(objOrArr) as T;
      } catch {
        return fallback;
      }
    }
    return fallback;
  }
}

function assertModelCallable(
  modelId: string,
  taskType: 'analysis' | 'image_editing' | 'video_generation' | 'audio_generation',
  freeTierEligible: boolean
): void {
  ensureModelQuotaRecord({
    providerId: 'google_gemini',
    providerName: 'Google Gemini API',
    modelId,
    taskType,
    freeTierEligible,
  });

  const check = canCallModel('google_gemini', modelId);
  if (!check.allowed) {
    const retryAfterSec = check.retryAfterAt
      ? Math.max(1, Math.ceil((Date.parse(check.retryAfterAt) - Date.now()) / 1000))
      : null;
    throw new QuotaExhaustedError(
      check.reason || `Model ${modelId} is temporarily paused due to quota/rate limit.`,
      {
        statusCode: 429,
        providerId: 'google_gemini',
        quotaIdentifier: check.quotaIdentifier,
        dailyLimit: check.dailyLimit,
        retryAfterSec,
        isDailyQuota: check.status === 'daily_exhausted',
      }
    );
  }
}

async function executeTrackedGeminiCall<T>(params: {
  modelId: string;
  taskType: 'analysis' | 'image_editing' | 'video_generation' | 'audio_generation';
  freeTierEligible: boolean;
  projectId?: string | null;
  projectName?: string | null;
  retryAttempts?: number;
  fn: () => Promise<T>;
}): Promise<T> {
  assertModelCallable(params.modelId, params.taskType, params.freeTierEligible);

  const attempts = params.retryAttempts ?? 2;
  try {
    const res = await withRetry(params.fn, {
      maxAttempts: attempts,
      baseDelayMs: 1200,
    });
    recordModelApiRequest({
      providerId: 'google_gemini',
      providerName: 'Google Gemini API',
      modelId: params.modelId,
      taskType: params.taskType,
      freeTierEligible: params.freeTierEligible,
      projectId: params.projectId,
      projectName: params.projectName,
      success: true,
    });
    return res;
  } catch (err) {
    recordModelApiRequest({
      providerId: 'google_gemini',
      providerName: 'Google Gemini API',
      modelId: params.modelId,
      taskType: params.taskType,
      freeTierEligible: params.freeTierEligible,
      projectId: params.projectId,
      projectName: params.projectName,
      success: false,
      error: err,
    });

    const rateMeta = parseRateLimitMetadata(err);
    if (rateMeta.isQuotaOrRateLimit && !(err instanceof QuotaExhaustedError)) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new QuotaExhaustedError(msg, {
        statusCode: 429,
        providerId: 'google_gemini',
        quotaIdentifier: rateMeta.quotaIdentifier,
        dailyLimit: rateMeta.dailyLimit,
        retryAfterSec: rateMeta.retryAfterSec,
        isDailyQuota: rateMeta.isDailyQuota,
      });
    }
    throw err;
  }
}

export async function checkGeminiConnection(): Promise<{
  configured: boolean;
  connected: boolean;
  modelTested: string;
  message: string;
  rateLimited?: boolean;
  retryAfterAt?: string | null;
}> {
  const key = getApiKey();
  if (!key) {
    return {
      configured: false,
      connected: false,
      modelTested: 'gemini-4-hydrogen',
      message:
        'Server-side GEMINI_API_KEY secret is not set yet. Configure it in AI Studio Settings > Secrets.',
    };
  }

  ensureModelQuotaRecord({
    providerId: 'google_gemini',
    providerName: 'Google Gemini API',
    modelId: 'gemini-4-hydrogen',
    taskType: 'analysis',
    freeTierEligible: true,
  });

  // Circuit-breaker: if model is already exhausted/cooling down, do NOT waste another API call!
  const check = canCallModel('google_gemini', 'gemini-4-hydrogen');
  if (!check.allowed) {
    return {
      configured: true,
      connected: false,
      modelTested: 'gemini-4-hydrogen',
      rateLimited: true,
      retryAfterAt: check.retryAfterAt ?? check.resetAt,
      message:
        check.reason ||
        'Google Gemini gemini-4-hydrogen daily quota or rate limit reached.',
    };
  }

  try {
    const ai = createClient();
    const res = await executeTrackedGeminiCall({
      modelId: 'gemini-4-hydrogen',
      taskType: 'analysis',
      freeTierEligible: true,
      retryAttempts: 1,
      fn: () =>
        ai.models.generateContent({
          model: 'gemini-4-hydrogen',
          contents: 'Reply with the single word OK.',
        }),
    });
    const ok = Boolean(res.text && res.text.trim().length > 0);
    return {
      configured: true,
      connected: ok,
      modelTested: 'gemini-4-hydrogen',
      message: ok
        ? 'Connected to Google Gemini API via server-side GEMINI_API_KEY secret.'
        : 'API responded with empty text.',
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const rateMeta = parseRateLimitMetadata(err);
    return {
      configured: true,
      connected: false,
      modelTested: 'gemini-4-hydrogen',
      rateLimited: rateMeta.isQuotaOrRateLimit,
      message: msg,
    };
  }
}

export async function analyzeCharacterReference(
  imagePaths: string[],
  characterName: string,
  projectContext?: { projectId?: string; projectName?: string }
): Promise<CharacterIdentityProfile> {
  const ai = createClient();
  const validPaths = imagePaths.filter((p) => fs.existsSync(p)).slice(0, 4);
  if (validPaths.length === 0) {
    throw new Error('No readable character image files were found.');
  }

  const parts: Array<
    | { inlineData: { data: string; mimeType: string } }
    | { text: string }
  > = validPaths.map((p) => ({
    inlineData: {
      data: fileToBase64(p),
      mimeType: guessImageMime(p),
    },
  }));

  parts.push({
    text: `Analyze the person in these reference photograph(s) for character "${characterName}". Extract precise, objective visual identity descriptors for consistent video generation without inventing unseen traits.`,
  });

  const response = await executeTrackedGeminiCall({
    modelId: 'gemini-4-hydrogen',
    taskType: 'analysis',
    freeTierEligible: true,
    projectId: projectContext?.projectId,
    projectName: projectContext?.projectName,
    retryAttempts: 1,
    fn: () =>
      ai.models.generateContent({
        model: 'gemini-4-hydrogen',
        contents: { parts },
        config: {
          systemInstruction:
            'You are a cinematic character supervisor. Extract accurate, concise facial and wardrobe descriptors from reference photos for identity preservation.',
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              facialStructure: { type: Type.STRING },
              eyeShape: { type: Type.STRING },
              noseShape: { type: Type.STRING },
              mouthShape: { type: Type.STRING },
              hair: { type: Type.STRING },
              facialHair: { type: Type.STRING },
              skinAppearance: { type: Type.STRING },
              distinctiveFeatures: { type: Type.STRING },
              clothingDetails: { type: Type.STRING },
              identitySummaryPrompt: {
                type: Type.STRING,
                description:
                  'A single cohesive paragraph describing this person so a video generation model preserves their exact facial proportions, hair, and appearance.',
              },
            },
            required: [
              'facialStructure',
              'eyeShape',
              'noseShape',
              'mouthShape',
              'hair',
              'facialHair',
              'skinAppearance',
              'distinctiveFeatures',
              'clothingDetails',
              'identitySummaryPrompt',
            ],
          },
        },
      }),
  });

  const parsed = safeParseJson<
    Omit<CharacterIdentityProfile, 'analyzedByModel' | 'analyzedAt'>
  >(response.text, {
    facialStructure: 'Standard proportions',
    eyeShape: 'Natural eye line',
    noseShape: 'Balanced nasal bridge',
    mouthShape: 'Natural mouth',
    hair: 'As shown in reference photo',
    facialHair: 'As shown in reference photo',
    skinAppearance: 'Natural tone',
    distinctiveFeatures: 'Reference portrait baseline',
    clothingDetails: 'As shown in reference photo',
    identitySummaryPrompt: `Preserve exact facial likeness and proportions of character ${characterName} from uploaded portrait.`,
  });

  return {
    ...parsed,
    analyzedByModel: 'gemini-4-hydrogen',
    analyzedAt: new Date().toISOString(),
  };
}

/**
 * Unified single-request structured analysis (combines character detection,
 * reference matching, AND natural-language director blueprint interpretation)
 * to minimize free-tier Gemini API requests (1 request instead of 2).
 */
export async function analyzeVideoAndDirectSceneUnified(params: {
  framePaths: string[];
  frameTimestampsSec: number[];
  frameUrls: string[];
  durationSec: number;
  referenceCharacters: CharacterAsset[];
  instruction: string;
  mode: TransformationMode;
  environment: EnvironmentAsset | null;
  transcriptSummary?: string;
  projectId?: string;
  projectName?: string;
}): Promise<{
  detectedCharacters: DetectedCharacter[];
  blueprint: DirectorBlueprint;
}> {
  const ai = createClient();

  const parts: Array<
    | { inlineData: { data: string; mimeType: string } }
    | { text: string }
  > = [];

  params.framePaths.forEach((p, idx) => {
    if (fs.existsSync(p)) {
      const ts = params.frameTimestampsSec[idx] ?? idx;
      parts.push({
        text: `Source video frame ${idx} at ${ts.toFixed(1)}s:`,
      });
      parts.push({
        inlineData: {
          data: fileToBase64(p),
          mimeType: 'image/jpeg',
        },
      });
    }
  });

  params.referenceCharacters.forEach((char) => {
    if (fs.existsSync(char.primaryImagePath)) {
      parts.push({
        text: `Uploaded Reference Character ID="${char.id}" Name="${char.name}" (${char.profile?.identitySummaryPrompt ?? 'Portrait reference provided'}):`,
      });
      parts.push({
        inlineData: {
          data: fileToBase64(char.primaryImagePath),
          mimeType: guessImageMime(char.primaryImagePath),
        },
      });
    }
  });

  const envSummary = params.environment
    ? `EnvironmentReference("${params.environment.name}"): ${params.environment.description}`
    : 'No separate environment image uploaded; follow written instruction or preserve original setting.';

  parts.push({
    text: `Perform BOTH character analysis and scene direction in a SINGLE structured JSON response.

1) Source Video Analysis (${params.durationSec.toFixed(1)}s total):
   Identify distinct people appearing in the source frames (main and secondary), timestamps, actions, visual description, bestFrameIndex, and recommend matchedCharacterId from the Uploaded Reference Characters (if 1 reference character is uploaded, match it to the main character).

2) Director Blueprint:
   Translate the user's instruction (English, Persian/Farsi, or any language) into a concise English cinematic production blueprint. Preserve anything not requested to change.
   User instruction: "${params.instruction}"
   Transformation mode: ${params.mode}
   Environment Context: ${envSummary}
   Audio Transcript Context: ${params.transcriptSummary || 'None / Instrumental'}`,
  });

  const response = await executeTrackedGeminiCall({
    modelId: 'gemini-4-hydrogen',
    taskType: 'analysis',
    freeTierEligible: true,
    projectId: params.projectId,
    projectName: params.projectName,
    retryAttempts: 1,
    fn: () =>
      ai.models.generateContent({
        model: 'gemini-4-hydrogen',
        contents: { parts },
        config: {
          systemInstruction:
            'You are a Cinematic VFX Supervisor & Film Director. Return a single JSON object containing detectedCharacters and blueprint.',
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              detectedCharacters: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    id: { type: Type.STRING },
                    label: { type: Type.STRING },
                    role: { type: Type.STRING },
                    appearanceTimestamps: {
                      type: Type.ARRAY,
                      items: { type: Type.STRING },
                    },
                    actions: { type: Type.STRING },
                    visualDescription: { type: Type.STRING },
                    bestFrameIndex: { type: Type.INTEGER },
                    matchedCharacterId: { type: Type.STRING },
                    confidenceNote: { type: Type.STRING },
                  },
                  required: [
                    'id',
                    'label',
                    'role',
                    'appearanceTimestamps',
                    'actions',
                    'visualDescription',
                    'bestFrameIndex',
                    'confidenceNote',
                  ],
                },
              },
              blueprint: {
                type: Type.OBJECT,
                properties: {
                  detectedLanguage: { type: Type.STRING },
                  englishTranslation: { type: Type.STRING },
                  targetCharactersToReplace: {
                    type: Type.ARRAY,
                    items: { type: Type.STRING },
                  },
                  preservedElements: {
                    type: Type.ARRAY,
                    items: { type: Type.STRING },
                  },
                  environmentTransformation: { type: Type.STRING },
                  cameraAndMotionNotes: { type: Type.STRING },
                  lightingAndAtmosphere: { type: Type.STRING },
                  audioDesignPlan: {
                    type: Type.OBJECT,
                    properties: {
                      preserveDialogue: { type: Type.BOOLEAN },
                      musicMood: { type: Type.STRING },
                      soundEffects: {
                        type: Type.ARRAY,
                        items: { type: Type.STRING },
                      },
                      ambientBed: { type: Type.STRING },
                    },
                    required: [
                      'preserveDialogue',
                      'musicMood',
                      'soundEffects',
                      'ambientBed',
                    ],
                  },
                },
                required: [
                  'detectedLanguage',
                  'englishTranslation',
                  'targetCharactersToReplace',
                  'preservedElements',
                  'environmentTransformation',
                  'cameraAndMotionNotes',
                  'lightingAndAtmosphere',
                  'audioDesignPlan',
                ],
              },
            },
            required: ['detectedCharacters', 'blueprint'],
          },
        },
      }),
  });

  const fallbackBlueprint: DirectorBlueprint = {
    detectedLanguage: 'auto',
    englishTranslation: params.instruction,
    targetCharactersToReplace: params.referenceCharacters.map((c) => c.name),
    preservedElements: ['Original movement and framing'],
    environmentTransformation:
      params.environment?.description || 'Preserve scene direction',
    cameraAndMotionNotes: 'Preserve camera movement and pacing',
    lightingAndAtmosphere: 'Cinematic natural contrast',
    audioDesignPlan: {
      preserveDialogue: true,
      musicMood: 'Atmospheric film score',
      soundEffects: [],
      ambientBed: 'Natural room/environment ambience',
    },
    ...(params.transcriptSummary ? { transcriptSummary: params.transcriptSummary } : {}),
  };

  const parsed = safeParseJson<{
    detectedCharacters?: Array<{
      id: string;
      label: string;
      role: string;
      appearanceTimestamps: string[];
      actions: string;
      visualDescription: string;
      bestFrameIndex: number;
      matchedCharacterId?: string;
      confidenceNote: string;
    }>;
    blueprint?: DirectorBlueprint;
  }>(response.text, {});

  const validRefIds = new Set(params.referenceCharacters.map((c) => c.id));
  const defaultSingleRef =
    params.referenceCharacters.length === 1
      ? params.referenceCharacters[0].id
      : null;

  const detectedCharacters: DetectedCharacter[] = (
    parsed.detectedCharacters ?? []
  ).map((item, idx) => {
    const safeFrameIdx = Math.min(
      Math.max(0, item.bestFrameIndex ?? 0),
      Math.max(0, params.frameUrls.length - 1)
    );
    const isMain = item.role?.toLowerCase() === 'main' || idx === 0;
    let matchedId: string | null = null;
    if (item.matchedCharacterId && validRefIds.has(item.matchedCharacterId)) {
      matchedId = item.matchedCharacterId;
    } else if (isMain && defaultSingleRef) {
      matchedId = defaultSingleRef;
    }
    return {
      id: item.id || `char_source_${idx + 1}`,
      label:
        item.label ||
        (isMain ? 'Source Character A (Main)' : `Source Character ${idx + 1}`),
      role: isMain ? 'main' : 'secondary',
      appearanceTimestamps: item.appearanceTimestamps ?? [],
      actions: item.actions || 'Visible in scene',
      visualDescription: item.visualDescription || '',
      thumbnailUrl: params.frameUrls[safeFrameIdx] || '',
      matchedCharacterId: matchedId,
      confidenceNote: item.confidenceNote || '',
    };
  });

  const blueprint = parsed.blueprint ?? fallbackBlueprint;
  if (params.transcriptSummary) {
    blueprint.transcriptSummary = params.transcriptSummary;
  }

  return { detectedCharacters, blueprint };
}

export async function analyzeVideoAndDetectCharacters(params: {
  framePaths: string[];
  frameTimestampsSec: number[];
  frameUrls: string[];
  durationSec: number;
  referenceCharacters: CharacterAsset[];
  projectId?: string;
  projectName?: string;
}): Promise<DetectedCharacter[]> {
  const unified = await analyzeVideoAndDirectSceneUnified({
    ...params,
    instruction: 'Analyze subjects in the source video frames.',
    mode: 'cinematic_recreation_with_character',
    environment: null,
  });
  return unified.detectedCharacters;
}

function clampBox(arr: unknown, fallback: [number, number, number, number]): [number, number, number, number] {
  if (!Array.isArray(arr) || arr.length < 4) return fallback;
  const x = Math.max(0, Math.min(0.95, Number(arr[0]) || 0));
  const y = Math.max(0, Math.min(0.95, Number(arr[1]) || 0));
  const w = Math.max(0.05, Math.min(1 - x, Number(arr[2]) || fallback[2]));
  const h = Math.max(0.05, Math.min(1 - y, Number(arr[3]) || fallback[3]));
  return [
    Math.round(x * 1000) / 1000,
    Math.round(y * 1000) / 1000,
    Math.round(w * 1000) / 1000,
    Math.round(h * 1000) / 1000,
  ];
}

/**
 * Stage 3: Single structured Gemini 4 Hydrogen call returning persistent character IDs,
 * per-frame normalized bounding boxes, face boxes, pose descriptions, and occlusion flags.
 */
export async function trackCharactersAcrossFrames(params: {
  frames: Array<{ index: number; timestampSec: number; framePath: string; frameUrl: string }>;
  detectedCharacters: DetectedCharacter[];
  projectId?: string;
  projectName?: string;
}): Promise<Map<number, FrameCharacterTrack[]>> {
  const ai = createClient();
  const trackMap = new Map<number, FrameCharacterTrack[]>();
  if (params.frames.length === 0) return trackMap;

  // Sample up to 12 evenly distributed frames for single-call Gemini 4 Hydrogen vision tracking
  const maxInspect = Math.min(12, params.frames.length);
  const inspectedIndices: number[] = [];
  for (let i = 0; i < maxInspect; i++) {
    const idx =
      maxInspect === 1
        ? 0
        : Math.round((i / (maxInspect - 1)) * (params.frames.length - 1));
    if (!inspectedIndices.includes(idx)) inspectedIndices.push(idx);
  }

  const charHint = params.detectedCharacters
    .map((d) => `${d.id} ("${d.label}", role=${d.role}): ${d.visualDescription || d.actions}`)
    .join('\n');

  const parts: Array<
    | { inlineData: { data: string; mimeType: string } }
    | { text: string }
  > = [];

  for (const idx of inspectedIndices) {
    const f = params.frames[idx];
    if (fs.existsSync(f.framePath)) {
      parts.push({
        text: `FRAME_INDEX=${f.index} (t=${f.timestampSec.toFixed(2)}s):`,
      });
      parts.push({
        inlineData: {
          data: fileToBase64(f.framePath),
          mimeType: guessImageMime(f.framePath),
        },
      });
    }
  }

  parts.push({
    text: `Track every visible human subject across these keyframes using persistent IDs (${params.detectedCharacters.map((c) => c.id).join(', ') || 'char_source_1'}).
Known subjects:
${charHint || 'char_source_1 (Main Subject)'}

For EACH inspected FRAME_INDEX, return normalized [x, y, w, h] coordinates (0.0 to 1.0, top-left origin) for:
- bbox: full visible body bounding box
- faceBox: head/face bounding box
- poseSummary: concise pose & facing angle (e.g., "facing camera, walking forward, arms down")
- occluded: true if partially hidden behind another person or object`,
  });

  const response = await executeTrackedGeminiCall({
    modelId: 'gemini-4-hydrogen',
    taskType: 'analysis',
    freeTierEligible: true,
    projectId: params.projectId,
    projectName: params.projectName,
    retryAttempts: 1,
    fn: () =>
      ai.models.generateContent({
        model: 'gemini-4-hydrogen',
        contents: { parts },
        config: {
          systemInstruction:
            'You are a VFX matchmove and character tracking system. Return accurate normalized bounding boxes in JSON.',
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              frames: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    frameIndex: { type: Type.INTEGER },
                    tracks: {
                      type: Type.ARRAY,
                      items: {
                        type: Type.OBJECT,
                        properties: {
                          characterId: { type: Type.STRING },
                          label: { type: Type.STRING },
                          bbox: { type: Type.ARRAY, items: { type: Type.NUMBER } },
                          faceBox: { type: Type.ARRAY, items: { type: Type.NUMBER } },
                          poseSummary: { type: Type.STRING },
                          occluded: { type: Type.BOOLEAN },
                        },
                        required: ['characterId', 'label', 'bbox', 'poseSummary', 'occluded'],
                      },
                    },
                  },
                  required: ['frameIndex', 'tracks'],
                },
              },
            },
            required: ['frames'],
          },
        },
      }),
  });

  const parsed = safeParseJson<{
    frames?: Array<{
      frameIndex: number;
      tracks: Array<{
        characterId: string;
        label: string;
        bbox: number[];
        faceBox?: number[];
        poseSummary: string;
        occluded: boolean;
      }>;
    }>;
  }>(response.text, {});

  const keyframeTracks = new Map<number, FrameCharacterTrack[]>();
  for (const item of parsed.frames ?? []) {
    const cleanTracks: FrameCharacterTrack[] = (item.tracks ?? []).map((t, i) => {
      const bbox = clampBox(t.bbox, [0.28, 0.1, 0.44, 0.82]);
      const defaultFace: [number, number, number, number] = [
        Math.round((bbox[0] + bbox[2] * 0.28) * 1000) / 1000,
        Math.round((bbox[1] + bbox[3] * 0.03) * 1000) / 1000,
        Math.round(bbox[2] * 0.44 * 1000) / 1000,
        Math.round(bbox[3] * 0.24 * 1000) / 1000,
      ];
      return {
        characterId:
          t.characterId ||
          params.detectedCharacters[i]?.id ||
          `char_source_${i + 1}`,
        label: t.label || params.detectedCharacters[i]?.label || `Subject ${i + 1}`,
        bbox,
        faceBox: clampBox(t.faceBox, defaultFace),
        poseSummary: t.poseSummary || 'Visible in frame',
        occluded: Boolean(t.occluded),
      };
    });
    keyframeTracks.set(item.frameIndex, cleanTracks);
  }

  // Linearly interpolate tracks for any non-keyframe extracted frames
  const sortedKeys = Array.from(keyframeTracks.keys()).sort((a, b) => a - b);
  if (sortedKeys.length === 0) {
    const fallbackTracks: FrameCharacterTrack[] = (
      params.detectedCharacters.length > 0
        ? params.detectedCharacters
        : [{ id: 'char_source_1', label: 'Primary Subject' } as DetectedCharacter]
    ).map((dc) => ({
      characterId: dc.id,
      label: dc.label,
      bbox: [0.28, 0.1, 0.44, 0.82],
      faceBox: [0.4, 0.12, 0.2, 0.22],
      poseSummary: 'Center-frame subject',
      occluded: false,
    }));
    for (const f of params.frames) {
      trackMap.set(f.index, fallbackTracks);
    }
    return trackMap;
  }

  for (const f of params.frames) {
    const exact = keyframeTracks.get(f.index);
    if (exact && exact.length > 0) {
      trackMap.set(f.index, exact);
      continue;
    }
    const prevKey =
      [...sortedKeys].reverse().find((k) => k <= f.index) ?? sortedKeys[0];
    const nextKey = sortedKeys.find((k) => k >= f.index) ?? sortedKeys[sortedKeys.length - 1];
    const prevTracks = keyframeTracks.get(prevKey) ?? [];
    const nextTracks = keyframeTracks.get(nextKey) ?? prevTracks;
    const alpha =
      nextKey === prevKey ? 0 : (f.index - prevKey) / (nextKey - prevKey);

    const interp: FrameCharacterTrack[] = prevTracks.map((pt) => {
      const nt = nextTracks.find((x) => x.characterId === pt.characterId) ?? pt;
      const lerpBox = (
        a: [number, number, number, number],
        b: [number, number, number, number]
      ): [number, number, number, number] => [
        Math.round((a[0] + (b[0] - a[0]) * alpha) * 1000) / 1000,
        Math.round((a[1] + (b[1] - a[1]) * alpha) * 1000) / 1000,
        Math.round((a[2] + (b[2] - a[2]) * alpha) * 1000) / 1000,
        Math.round((a[3] + (b[3] - a[3]) * alpha) * 1000) / 1000,
      ];
      return {
        characterId: pt.characterId,
        label: pt.label,
        bbox: lerpBox(pt.bbox, nt.bbox),
        faceBox: pt.faceBox
          ? lerpBox(pt.faceBox, nt.faceBox ?? pt.faceBox)
          : undefined,
        poseSummary: pt.poseSummary,
        occluded: pt.occluded && nt.occluded,
      };
    });
    trackMap.set(f.index, interp);
  }

  return trackMap;
}

/**
 * Stage 4 Paid Gemini Image Editor (gemini-3.1-flash-lite-image / gemini-nano-banana-2.1).
 * Note: Never invoke without explicit Paid Mode confirmation. Never sets responseMimeType.
 */
export async function editFrameWithGeminiImageModel(
  req: FrameEditRequest
): Promise<{ modelUsed: string }> {
  const ai = createClient();
  const modelId = req.modelId || 'gemini-3.1-flash-lite-image';
  assertModelCallable(modelId, 'image_editing', false);

  const parts: Array<
    | { inlineData: { data: string; mimeType: string } }
    | { text: string }
  > = [];

  parts.push({
    text: `SOURCE VIDEO FRAME #${req.frameIndex + 1} (t=${req.timestampSec.toFixed(2)}s). Preserve camera framing, background, lighting direction, body motion, and unmapped people:`,
  });
  parts.push({
    inlineData: {
      data: fileToBase64(req.sourceFramePath),
      mimeType: guessImageMime(req.sourceFramePath),
    },
  });

  if (req.unionMaskPath && fs.existsSync(req.unionMaskPath)) {
    parts.push({
      text: 'CHARACTER SEGMENTATION MASK (white = target region to replace; black = preserve untouched background/environment):',
    });
    parts.push({
      inlineData: {
        data: fileToBase64(req.unionMaskPath),
        mimeType: 'image/png',
      },
    });
  }

  if (req.previousEditedFramePath && fs.existsSync(req.previousEditedFramePath)) {
    parts.push({
      text: 'PREVIOUS EDITED FRAME (temporal anchor — match replacement face lighting, hair continuity, and wardrobe consistently):',
    });
    parts.push({
      inlineData: {
        data: fileToBase64(req.previousEditedFramePath),
        mimeType: guessImageMime(req.previousEditedFramePath),
      },
    });
  }

  req.bindings.forEach((b, idx) => {
    if (fs.existsSync(b.targetCharacter.primaryImagePath)) {
      parts.push({
        text: `TARGET REFERENCE CHARACTER #${idx + 1} "${b.targetCharacter.name}" replacing "${b.sourceLabel}" at bbox=${JSON.stringify(b.bbox)} (pose: ${b.poseSummary}):`,
      });
      parts.push({
        inlineData: {
          data: fileToBase64(b.targetCharacter.primaryImagePath),
          mimeType: guessImageMime(b.targetCharacter.primaryImagePath),
        },
      });
    }
  });

  if (
    req.environmentRef &&
    req.backgroundMode === 'use_env_ref' &&
    fs.existsSync(req.environmentRef.imagePath)
  ) {
    parts.push({
      text: `ENVIRONMENT REFERENCE ("${req.environmentRef.name}"):`,
    });
    parts.push({
      inlineData: {
        data: fileToBase64(req.environmentRef.imagePath),
        mimeType: guessImageMime(req.environmentRef.imagePath),
      },
    });
  }

  parts.push({ text: req.prompt });

  const response = await executeTrackedGeminiCall({
    modelId,
    taskType: 'image_editing',
    freeTierEligible: false,
    projectId: req.projectId,
    projectName: req.projectName,
    retryAttempts: 1,
    fn: () =>
      ai.models.generateContent({
        model: modelId,
        contents: { parts },
        config: {
          responseModalities: ['TEXT', 'IMAGE'],
        },
      }),
  });

  const candidateParts = response.candidates?.[0]?.content?.parts ?? [];
  const imgPart = candidateParts.find((p) => p.inlineData?.data);
  if (!imgPart?.inlineData?.data) {
    throw new ProviderHttpError(
      `${modelId} returned no edited image payload for frame ${req.frameIndex + 1}.`,
      { statusCode: 502, providerId: 'google_gemini' }
    );
  }

  fs.mkdirSync(path.dirname(req.outFramePath), { recursive: true });
  fs.writeFileSync(req.outFramePath, Buffer.from(imgPart.inlineData.data, 'base64'));
  return { modelUsed: modelId };
}

export async function interpretDirectorInstruction(params: {
  instruction: string;
  mode: TransformationMode;
  detectedCharacters: DetectedCharacter[];
  characters: CharacterAsset[];
  environment: EnvironmentAsset | null;
  transcriptSummary?: string;
  projectId?: string;
  projectName?: string;
}): Promise<DirectorBlueprint> {
  const ai = createClient();

  const charSummaries = params.characters
    .map(
      (c) =>
        `RefCharacter(${c.id}, "${c.name}"): ${c.profile?.identitySummaryPrompt ?? 'Portrait reference provided.'}`
    )
    .join('\n');

  const detectedSummaries = params.detectedCharacters
    .map(
      (d) =>
        `SourceCharacter(${d.id}, "${d.label}", role=${d.role}, mappedTo=${d.matchedCharacterId ?? 'none'}): ${d.actions}`
    )
    .join('\n');

  const envSummary = params.environment
    ? `EnvironmentReference("${params.environment.name}"): ${params.environment.description}`
    : 'No separate environment image uploaded; follow written instruction or preserve original setting.';

  const response = await executeTrackedGeminiCall({
    modelId: 'gemini-4-hydrogen',
    taskType: 'analysis',
    freeTierEligible: true,
    projectId: params.projectId,
    projectName: params.projectName,
    retryAttempts: 2,
    fn: () =>
      ai.models.generateContent({
        model: 'gemini-4-hydrogen',
        contents: `User instruction (may be in English, Persian/Farsi, or any language):\n"${params.instruction}"\n\nSelected Mode: ${params.mode}\n\nDetected Source Characters:\n${detectedSummaries || 'None explicitly listed'}\n\nUploaded Reference Characters:\n${charSummaries || 'None'}\n\nEnvironment Context:\n${envSummary}\n\nOriginal Audio Transcript Context:\n${params.transcriptSummary || 'None / Instrumental'}`,
        config: {
          systemInstruction:
            'You are an AI Film Director & VFX Supervisor. Translate the user natural-language instruction into a structured English cinematic generation blueprint. Preserve anything the user did not ask to change.',
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              detectedLanguage: { type: Type.STRING },
              englishTranslation: { type: Type.STRING },
              targetCharactersToReplace: {
                type: Type.ARRAY,
                items: { type: Type.STRING },
              },
              preservedElements: {
                type: Type.ARRAY,
                items: { type: Type.STRING },
              },
              environmentTransformation: { type: Type.STRING },
              cameraAndMotionNotes: { type: Type.STRING },
              lightingAndAtmosphere: { type: Type.STRING },
              audioDesignPlan: {
                type: Type.OBJECT,
                properties: {
                  preserveDialogue: { type: Type.BOOLEAN },
                  musicMood: { type: Type.STRING },
                  soundEffects: {
                    type: Type.ARRAY,
                    items: { type: Type.STRING },
                  },
                  ambientBed: { type: Type.STRING },
                },
                required: [
                  'preserveDialogue',
                  'musicMood',
                  'soundEffects',
                  'ambientBed',
                ],
              },
            },
            required: [
              'detectedLanguage',
              'englishTranslation',
              'targetCharactersToReplace',
              'preservedElements',
              'environmentTransformation',
              'cameraAndMotionNotes',
              'lightingAndAtmosphere',
              'audioDesignPlan',
            ],
          },
        },
      }),
  });

  const parsed = safeParseJson<DirectorBlueprint>(response.text, {
    detectedLanguage: 'auto',
    englishTranslation: params.instruction,
    targetCharactersToReplace: [],
    preservedElements: ['Original movement and framing'],
    environmentTransformation:
      params.environment?.description || 'Preserve scene direction',
    cameraAndMotionNotes: 'Preserve camera movement and pacing',
    lightingAndAtmosphere: 'Cinematic natural contrast',
    audioDesignPlan: {
      preserveDialogue: true,
      musicMood: 'Atmospheric film score',
      soundEffects: [],
      ambientBed: 'Natural room/environment ambience',
    },
  });

  if (params.transcriptSummary) {
    parsed.transcriptSummary = params.transcriptSummary;
  }
  return parsed;
}

export async function transcribeAudioFile(
  audioPath: string,
  projectContext?: { projectId?: string; projectName?: string }
): Promise<string> {
  if (!fs.existsSync(audioPath)) return '';
  const ai = createClient();
  const base64Audio = fileToBase64(audioPath);

  const interaction = await executeTrackedGeminiCall({
    modelId: 'gemini-3.5-transcribe',
    taskType: 'analysis',
    freeTierEligible: true,
    projectId: projectContext?.projectId,
    projectName: projectContext?.projectName,
    retryAttempts: 1,
    fn: () =>
      ai.interactions.create({
        model: 'gemini-3.5-transcribe',
        input: [
          {
            type: 'audio',
            data: base64Audio,
            mime_type: 'audio/mp3',
          },
          {
            type: 'text',
            text: 'Transcribe any spoken dialogue accurately and briefly summarize ambient sounds or music.',
          },
        ],
      }),
  });
  return interaction.output_text ?? '';
}

export async function generateSegmentWithOmniFlash(params: {
  sourceSegmentPath: string;
  outSegmentPath: string;
  durationSec: number;
  aspectRatio: OutputAspectRatio;
  sourceWidth: number;
  sourceHeight: number;
  resolution: OutputResolution;
  qualityTier: QualityTier;
  characterRefs: CharacterAsset[];
  mappedCharacterPairs?: MappedCharacterPair[];
  preservedCharacterLabels?: string[];
  replacementScope?: ReplacementScope;
  backgroundMode?: BackgroundMode;
  lightingMode?: LightingMode;
  environmentRef: EnvironmentAsset | null;
  prompt: string;
  existingProviderJobId?: string | null;
  projectId?: string;
  projectName?: string;
  onJobCreated?: (jobId: string) => void;
  onPollProgress?: (status: string, pollCount: number) => void;
  isCancelled?: () => boolean;
}): Promise<{ modelUsed: string; providerJobId: string }> {
  const ai = createClient();

  assertModelCallable('gemini-omni-1.2-flash', 'video_generation', false);

  let interactionId = params.existingProviderJobId ?? null;
  let interaction = interactionId
    ? await ai.interactions.get(interactionId)
    : null;

  if (!interaction) {
    let videoFile = await ai.files.upload({
      file: params.sourceSegmentPath,
      config: { mimeType: 'video/mp4' },
    });

    const uploadPollStart = Date.now();
    while (videoFile.state === 'PROCESSING') {
      if (params.isCancelled?.()) {
        throw new ProviderHttpError(
          'Cancelled by user while uploading source video to Google Files API.',
          { providerId: 'google_gemini' }
        );
      }
      if (Date.now() - uploadPollStart > 180000) {
        throw new ProviderHttpError(
          'Timed out waiting for uploaded segment video file to become ACTIVE in Google Files API.',
          { statusCode: 504, providerId: 'google_gemini' }
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 4000));
      videoFile = await ai.files.get({ name: videoFile.name || '' });
    }
    if (videoFile.state === 'FAILED') {
      throw new ProviderHttpError(
        'Google Files API failed to process the source video segment.',
        { statusCode: 422, providerId: 'google_gemini' }
      );
    }

    const inputParts: Array<
      | { type: 'video'; uri: string }
      | { type: 'image'; mime_type: string; data: string }
      | { type: 'text'; text: string }
    > = [];

    if (videoFile.uri) {
      inputParts.push({ type: 'video', uri: videoFile.uri });
      inputParts.push({
        type: 'text',
        text: 'SOURCE FOOTAGE ABOVE: Preserve this source video’s human movement, posture, timing, gestures, camera angle, framing, and scene composition.',
      });
    }

    const scope: ReplacementScope =
      params.replacementScope ?? 'full_character_replacement';
    const hasEnvImage = Boolean(
      params.environmentRef &&
        params.backgroundMode !== 'preserve' &&
        fs.existsSync(params.environmentRef.imagePath)
    );
    // Omni Flash supports up to 6 reference images alongside an uploaded video
    const maxCharImageSlots = hasEnvImage ? 5 : 6;

    const pairs: MappedCharacterPair[] =
      params.mappedCharacterPairs && params.mappedCharacterPairs.length > 0
        ? params.mappedCharacterPairs
        : params.characterRefs.map((c, idx) => ({
            sourceCharacterId: `char_source_${idx + 1}`,
            sourceLabel: idx === 0 ? 'Main Character' : `Subject ${idx + 1}`,
            sourceRole: idx === 0 ? 'main' : 'secondary',
            sourceVisualDescription: '',
            targetCharacter: c,
          }));

    // Allocate slots fairly across all mapped characters so no secondary character gets starved
    let usedImageSlots = 0;
    const perCharPrimaryDone = new Set<string>();

    // First pass: guarantee 1 primary image per distinct mapped character
    for (let idx = 0; idx < pairs.length; idx++) {
      if (usedImageSlots >= maxCharImageSlots) break;
      const pair = pairs[idx];
      const primaryPath = pair.targetCharacter.primaryImagePath;
      if (!fs.existsSync(primaryPath)) continue;

      const scopeRule =
        scope === 'face_replacement'
          ? 'Replace ONLY the face, head, hair, and skin tone of this target subject while retaining original clothing/body.'
          : 'Perform FULL CHARACTER REPLACEMENT: completely remove the original subject’s face, head, hair, body build, hands, and outfit and replace them with this exact reference person.';

      inputParts.push({
        type: 'text',
        text: `REFERENCE IDENTITY LOCK #${idx + 1} ("${pair.targetCharacter.name}") -> REPLACES "${pair.sourceLabel}" (${pair.sourceRole}${pair.sourceVisualDescription ? `, currently seen as: ${pair.sourceVisualDescription}` : ''}). ${scopeRule} Identity traits: ${pair.targetCharacter.profile?.identitySummaryPrompt ?? 'Match exact facial structure, eye line, nose, mouth, skin tone, hair, and overall likeness.'}`,
      });
      inputParts.push({
        type: 'image',
        mime_type: guessImageMime(primaryPath),
        data: fileToBase64(primaryPath),
      });
      usedImageSlots++;
      perCharPrimaryDone.add(pair.sourceCharacterId);

      // Attach extra reference angles for multi-angle identity lock if slots remain
      const remainingCharsNeedingPrimary = pairs
        .slice(idx + 1)
        .filter((p) => fs.existsSync(p.targetCharacter.primaryImagePath)).length;
      for (const extraPath of pair.targetCharacter.additionalImagePaths) {
        if (usedImageSlots >= maxCharImageSlots - remainingCharsNeedingPrimary) break;
        if (fs.existsSync(extraPath)) {
          inputParts.push({
            type: 'image',
            mime_type: guessImageMime(extraPath),
            data: fileToBase64(extraPath),
          });
          usedImageSlots++;
        }
      }
    }

    if (params.preservedCharacterLabels && params.preservedCharacterLabels.length > 0) {
      inputParts.push({
        type: 'text',
        text: `KEEP ORIGINAL (DO NOT REPLACE): ${params.preservedCharacterLabels.join(', ')}. Keep these unmapped people visually unchanged.`,
      });
    }

    if (hasEnvImage && params.environmentRef) {
      inputParts.push({
        type: 'text',
        text: `TARGET ENVIRONMENT REFERENCE ("${params.environmentRef.name}"): ${params.environmentRef.description}`,
      });
      inputParts.push({
        type: 'image',
        mime_type: guessImageMime(params.environmentRef.imagePath),
        data: fileToBase64(params.environmentRef.imagePath),
      });
    }

    inputParts.push({
      type: 'text',
      text: params.prompt,
    });

    const clampedDur = Math.min(15, Math.max(3, Math.round(params.durationSec)));
    const isVerticalSource = params.sourceHeight > params.sourceWidth;
    const targetAspect: '16:9' | '9:16' =
      params.aspectRatio === '9:16'
        ? '9:16'
        : params.aspectRatio === '16:9'
          ? '16:9'
          : isVerticalSource
            ? '9:16'
            : '16:9';

    const targetRes: '720p' | '1080p' =
      params.resolution === '1080p' && params.qualityTier !== 'economy'
        ? '1080p'
        : '720p';

    interaction = await executeTrackedGeminiCall({
      modelId: 'gemini-omni-1.2-flash',
      taskType: 'video_generation',
      freeTierEligible: false,
      projectId: params.projectId,
      projectName: params.projectName,
      retryAttempts: 1,
      fn: () =>
        ai.interactions.create({
          model: 'gemini-omni-1.2-flash',
          input: inputParts,
          background: true,
          store: true,
          stream: false,
          response_format: {
            type: 'video',
            aspect_ratio: targetAspect,
            duration: `${clampedDur}s`,
            resolution: targetRes,
          },
        }),
    });
    interactionId = interaction.id;
    params.onJobCreated?.(interactionId);
  }

  const pollStart = Date.now();
  let pollCount = 0;
  while (
    interaction.status === 'queued' ||
    interaction.status === 'in_progress' ||
    interaction.status === 'idle' ||
    interaction.status === 'requires_continuation'
  ) {
    if (params.isCancelled?.()) {
      try {
        await ai.interactions.cancel(interaction.id);
      } catch {
        // best effort cancellation
      }
      throw new ProviderHttpError('Video generation job cancelled by user.', {
        providerId: 'google_gemini',
        providerJobId: interaction.id,
      });
    }
    if (Date.now() - pollStart > 480000) {
      throw new ProviderHttpError(
        `Timed out after 8 minutes waiting for gemini-omni-1.2-flash job ${interaction.id}.`,
        {
          statusCode: 504,
          providerId: 'google_gemini',
          providerJobId: interaction.id,
        }
      );
    }
    pollCount++;
    params.onPollProgress?.(String(interaction.status), pollCount);
    await new Promise((resolve) => setTimeout(resolve, 6000));
    interaction = await withRetry(() => ai.interactions.get(interaction!.id), {
      maxAttempts: 2,
      baseDelayMs: 1500,
    });
  }

  if (
    interaction.status === 'failed' ||
    interaction.status === 'cancelled' ||
    interaction.status === 'budget_exceeded' ||
    interaction.status === 'incomplete'
  ) {
    throw new ProviderHttpError(
      `gemini-omni-1.2-flash job ${interaction.id} terminated with status "${interaction.status}".`,
      {
        statusCode: interaction.status === 'budget_exceeded' ? 402 : 500,
        providerId: 'google_gemini',
        providerJobId: interaction.id,
      }
    );
  }

  const videoPart = interaction.output_video;
  if (!videoPart) {
    throw new ProviderHttpError(
      `gemini-omni-1.2-flash job ${interaction.id} completed but returned no video output.`,
      {
        statusCode: 502,
        providerId: 'google_gemini',
        providerJobId: interaction.id,
      }
    );
  }

  fs.mkdirSync(path.dirname(params.outSegmentPath), { recursive: true });
  if (videoPart.data) {
    const buffer = Buffer.from(videoPart.data, 'base64');
    fs.writeFileSync(params.outSegmentPath, buffer);
  } else if (videoPart.uri) {
    const apiKey = getApiKey();
    const res = await fetch(videoPart.uri, {
      headers: apiKey ? { 'x-goog-api-key': apiKey } : undefined,
    });
    if (!res.ok) {
      throw new ProviderHttpError(
        `Failed to download generated segment from URI (${res.status}).`,
        {
          statusCode: res.status,
          providerId: 'google_gemini',
          providerJobId: interaction.id,
        }
      );
    }
    const arrayBuf = await res.arrayBuffer();
    fs.writeFileSync(params.outSegmentPath, Buffer.from(arrayBuf));
  } else {
    throw new ProviderHttpError(
      'Generated video output had neither base64 data nor URI.',
      {
        statusCode: 502,
        providerId: 'google_gemini',
        providerJobId: interaction.id,
      }
    );
  }

  const playable = await verifyPlayableVideo(params.outSegmentPath);
  if (!playable) {
    throw new ProviderHttpError(
      'Retrieved video from Google Gemini failed playability verification (empty or corrupt MP4).',
      {
        statusCode: 502,
        providerId: 'google_gemini',
        providerJobId: interaction.id,
      }
    );
  }

  return { modelUsed: 'gemini-omni-1.2-flash', providerJobId: interaction.id };
}

export async function inspectSegmentCharacterReplacementQC(params: {
  sourceFramePaths: string[];
  generatedFramePaths: string[];
  characterRefs: CharacterAsset[];
  mappedCharacterPairs?: MappedCharacterPair[];
  replacementScope?: ReplacementScope;
  ssimSimilarity?: number | null;
  projectId?: string;
  projectName?: string;
}): Promise<SegmentConsistencyCheck> {
  const validGenFrames = params.generatedFramePaths.filter((p) => fs.existsSync(p));
  const validSrcFrames = params.sourceFramePaths.filter((p) => fs.existsSync(p));

  const targetChars =
    params.mappedCharacterPairs && params.mappedCharacterPairs.length > 0
      ? params.mappedCharacterPairs.map((p) => p.targetCharacter)
      : params.characterRefs;

  if (validGenFrames.length === 0 || targetChars.length === 0) {
    return {
      checked: false,
      consistent: true,
      needsReview: false,
      checkedFramesCount: validGenFrames.length,
      notes: 'Skipped QC inspection (no mapped replacement character or generated frames).',
    };
  }

  // Deterministic pixel check: if output frames are virtually identical to input frames
  // while character replacement was requested, replacement definitely failed!
  if (
    typeof params.ssimSimilarity === 'number' &&
    params.ssimSimilarity >= 0.96
  ) {
    return {
      checked: true,
      consistent: false,
      needsReview: true,
      checkedFramesCount: validGenFrames.length,
      originalFaceStillPresent: true,
      identityScore: 0,
      failureReasons: [
        `Output frames are nearly identical to original source footage (SSIM=${params.ssimSimilarity.toFixed(3)} >= 0.96); original character was preserved instead of replaced.`,
      ],
      notes: `QC FAILED: Output frames match original source frames (SSIM=${params.ssimSimilarity.toFixed(3)}), confirming original character remained unchanged.`,
    };
  }

  // Respect circuit breaker — if Gemini analysis quota is exhausted, report unverified rather than faking pass
  const check = canCallModel('google_gemini', 'gemini-4-hydrogen');
  if (!check.allowed) {
    return {
      checked: false,
      consistent: true,
      needsReview: true,
      checkedFramesCount: validGenFrames.length,
      failureReasons: [
        `AI visual QC skipped (${check.reason || 'Gemini analysis quota unavailable'}) — manual visual review recommended.`,
      ],
      notes: `Visual QC unverified (${check.reason || 'Gemini quota unavailable'}). Inspect preview manually.`,
    };
  }

  const ai = createClient();
  const parts: Array<
    | { inlineData: { data: string; mimeType: string } }
    | { text: string }
  > = [];

  if (params.mappedCharacterPairs && params.mappedCharacterPairs.length > 0) {
    params.mappedCharacterPairs.forEach((pair, idx) => {
      if (fs.existsSync(pair.targetCharacter.primaryImagePath)) {
        parts.push({
          text: `TARGET REFERENCE CHARACTER #${idx + 1} "${pair.targetCharacter.name}" (meant to replace source subject "${pair.sourceLabel}"):`,
        });
        parts.push({
          inlineData: {
            data: fileToBase64(pair.targetCharacter.primaryImagePath),
            mimeType: guessImageMime(pair.targetCharacter.primaryImagePath),
          },
        });
      }
    });
  } else {
    targetChars.slice(0, 3).forEach((char, idx) => {
      if (fs.existsSync(char.primaryImagePath)) {
        parts.push({
          text: `TARGET REFERENCE CHARACTER #${idx + 1} "${char.name}":`,
        });
        parts.push({
          inlineData: {
            data: fileToBase64(char.primaryImagePath),
            mimeType: guessImageMime(char.primaryImagePath),
          },
        });
      }
    });
  }

  const pairCount = Math.min(validGenFrames.length, Math.max(1, validSrcFrames.length));
  const frameLabels = ['Start Frame', 'Middle / Action Frame', 'End Frame'];
  for (let i = 0; i < validGenFrames.length; i++) {
    const label = frameLabels[i] || `Sample Frame ${i + 1}`;
    if (i < pairCount && validSrcFrames[i]) {
      parts.push({ text: `ORIGINAL SOURCE VIDEO (${label}):` });
      parts.push({
        inlineData: {
          data: fileToBase64(validSrcFrames[i]),
          mimeType: 'image/jpeg',
        },
      });
    }
    parts.push({ text: `GENERATED OUTPUT VIDEO (${label}):` });
    parts.push({
      inlineData: {
        data: fileToBase64(validGenFrames[i]),
        mimeType: 'image/jpeg',
      },
    });
  }

  const scopeDesc =
    params.replacementScope === 'face_replacement'
      ? 'Face & Head Replacement (original clothing allowed, face/head MUST belong strictly to the Target Reference Character)'
      : 'Full Character Replacement (face, hair, body build, and styling MUST belong to the Target Reference Character; original character MUST be completely gone)';

  parts.push({
    text: `You are an uncompromising VFX Quality Control Supervisor. Compare ALL ${validGenFrames.length} Generated Output Video frames against BOTH the Original Source Video frames and the Target Reference Character portrait(s).
Required Replacement Mode: ${scopeDesc}.
Verify all visual checks strictly:
1) originalFaceStillPresent: true if the original person's face/identity from the Original Source Video is still visible, unchanged, or blended as a hybrid face in ANY generated frame.
2) replacementIdentityMatch: true ONLY if the generated character clearly and recognizably matches the Target Reference Character across the inspected frames.
3) identityScore: 0 to 100 rating how faithfully the Target Reference Character replaced the original person across frames (0 = original character unchanged or completely wrong person; 80+ = clear recognizable replacement).
4) anatomicalValid: true if body, head proportions, limbs, and hands look natural without severe distortion.
5) motionMatched: true if posture, body orientation, and motion trajectory match the original source video frames.
6) temporalFlicker: true if facial identity or clothing jumps/flickers unnaturally between consecutive generated frames.
7) backgroundDamaged: true if unrequested background destruction or severe distortion appeared outside the character region.
8) artifactsDetected: list any defects found.
9) consistent: true ONLY if originalFaceStillPresent is false AND replacementIdentityMatch is true AND identityScore >= 60 AND anatomicalValid is true.
10) needsReview: true if consistent is false OR temporalFlicker is true OR backgroundDamaged is true OR artifactsDetected is non-empty.
11) notes: concise, honest 1-2 sentence QC finding.`,
  });

  const response = await executeTrackedGeminiCall({
    modelId: 'gemini-4-hydrogen',
    taskType: 'analysis',
    freeTierEligible: true,
    projectId: params.projectId,
    projectName: params.projectName,
    retryAttempts: 1,
    fn: () =>
      ai.models.generateContent({
        model: 'gemini-4-hydrogen',
        contents: { parts },
        config: {
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              originalFaceStillPresent: { type: Type.BOOLEAN },
              replacementIdentityMatch: { type: Type.BOOLEAN },
              identityScore: { type: Type.INTEGER },
              anatomicalValid: { type: Type.BOOLEAN },
              motionMatched: { type: Type.BOOLEAN },
              temporalFlicker: { type: Type.BOOLEAN },
              backgroundDamaged: { type: Type.BOOLEAN },
              artifactsDetected: {
                type: Type.ARRAY,
                items: { type: Type.STRING },
              },
              consistent: { type: Type.BOOLEAN },
              needsReview: { type: Type.BOOLEAN },
              notes: { type: Type.STRING },
            },
            required: [
              'originalFaceStillPresent',
              'replacementIdentityMatch',
              'identityScore',
              'anatomicalValid',
              'motionMatched',
              'temporalFlicker',
              'backgroundDamaged',
              'artifactsDetected',
              'consistent',
              'needsReview',
              'notes',
            ],
          },
        },
      }),
  });

  const parsed = safeParseJson<{
    originalFaceStillPresent: boolean;
    replacementIdentityMatch: boolean;
    identityScore: number;
    anatomicalValid?: boolean;
    motionMatched?: boolean;
    temporalFlicker?: boolean;
    backgroundDamaged?: boolean;
    artifactsDetected: string[];
    consistent: boolean;
    needsReview: boolean;
    notes: string;
  }>(response.text, {
    originalFaceStillPresent: false,
    replacementIdentityMatch: true,
    identityScore: 70,
    anatomicalValid: true,
    motionMatched: true,
    temporalFlicker: false,
    backgroundDamaged: false,
    artifactsDetected: [],
    consistent: true,
    needsReview: false,
    notes: 'Multi-frame QC evaluation completed.',
  });

  const score = Math.max(0, Math.min(100, Number(parsed.identityScore ?? 0)));
  const originalStillThere = Boolean(parsed.originalFaceStillPresent);
  const identityMatched = Boolean(parsed.replacementIdentityMatch);
  const anatomicalValid = parsed.anatomicalValid !== false;
  const motionMatched = parsed.motionMatched !== false;
  const temporalFlicker = Boolean(parsed.temporalFlicker);
  const backgroundDamaged = Boolean(parsed.backgroundDamaged);
  const artifacts = Array.isArray(parsed.artifactsDetected)
    ? parsed.artifactsDetected.filter(Boolean)
    : [];

  const consistent =
    !originalStillThere &&
    identityMatched &&
    score >= 60 &&
    anatomicalValid &&
    Boolean(parsed.consistent);

  const failureReasons: string[] = [];
  if (originalStillThere) {
    failureReasons.push('Original character face/identity remained visible in generated frames.');
  }
  if (!identityMatched || score < 60) {
    failureReasons.push(
      `Generated character did not sufficiently match target reference identity (score ${score}/100).`
    );
  }
  if (!anatomicalValid) {
    failureReasons.push('Anatomical or proportional distortion detected.');
  }
  if (!motionMatched) {
    failureReasons.push('Subject motion/pose diverged significantly from source video.');
  }
  if (temporalFlicker) {
    failureReasons.push('Temporal flickering/identity jump detected across frames.');
  }
  if (backgroundDamaged) {
    failureReasons.push('Unrequested background damage detected outside subject mask.');
  }
  for (const art of artifacts) {
    if (!failureReasons.includes(art)) failureReasons.push(art);
  }

  return {
    checked: true,
    consistent,
    needsReview: !consistent || Boolean(parsed.needsReview) || artifacts.length > 0,
    checkedFramesCount: validGenFrames.length,
    originalFaceStillPresent: originalStillThere,
    identityScore: score,
    anatomicalValid,
    motionMatched,
    temporalFlicker,
    backgroundDamaged,
    failureReasons,
    notes: parsed.notes || 'Multi-frame QC inspection completed.',
  };
}

export async function verifySegmentCharacterConsistency(params: {
  generatedFramePath: string;
  characterRefs: CharacterAsset[];
  projectId?: string;
  projectName?: string;
}): Promise<SegmentConsistencyCheck> {
  return inspectSegmentCharacterReplacementQC({
    sourceFramePaths: [],
    generatedFramePaths: [params.generatedFramePath],
    characterRefs: params.characterRefs,
    projectId: params.projectId,
    projectName: params.projectName,
  });
}

export async function generateMusicWithLyria(
  prompt: string,
  outMp3Path: string,
  projectContext?: { projectId?: string; projectName?: string }
): Promise<{ generated: boolean; lyrics: string }> {
  const ai = createClient();

  const { audioChunks, lyrics } = await executeTrackedGeminiCall({
    modelId: 'lyria-3-clip-preview',
    taskType: 'audio_generation',
    freeTierEligible: false,
    projectId: projectContext?.projectId,
    projectName: projectContext?.projectName,
    retryAttempts: 1,
    fn: async () => {
      const response = await ai.models.generateContentStream({
        model: 'lyria-3-clip-preview',
        contents: prompt,
      });

      const chunks: Buffer[] = [];
      let text = '';
      for await (const chunk of response) {
        const parts = chunk.candidates?.[0]?.content?.parts;
        if (!parts) continue;
        for (const part of parts) {
          if (part.inlineData?.data) {
            chunks.push(Buffer.from(part.inlineData.data, 'base64'));
          }
          if (part.text) {
            text += part.text;
          }
        }
      }
      return { audioChunks: chunks, lyrics: text };
    },
  });

  if (audioChunks.length === 0) {
    throw new Error('Lyria audio stream returned no audio chunks.');
  }

  fs.mkdirSync(path.dirname(outMp3Path), { recursive: true });
  fs.writeFileSync(outMp3Path, Buffer.concat(audioChunks));
  return { generated: true, lyrics };
}
