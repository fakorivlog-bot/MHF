export type TransformationMode =
  | 'character_replacement'
  | 'cinematic_recreation'
  | 'cinematic_recreation_with_character'
  | 'environment_transformation'
  | 'creative_transformation';

export type ReplacementScope = 'full_character_replacement' | 'face_replacement';

export type BackgroundMode = 'preserve' | 'transform' | 'use_env_ref';

export type LightingMode = 'preserve' | 'enhance';

export type QualityTier = 'economy' | 'balanced' | 'maximum';

export type OutputResolution = '720p' | '1080p';

export type OutputAspectRatio = 'original' | '16:9' | '9:16' | '1:1';

export type AudioMode =
  | 'preserve_dialogue'
  | 'replace_ambient_sfx'
  | 'generate_score'
  | 'silent';

export type BillingMode = 'free' | 'paid';

export type FreeModeFallbackPolicy = 'ffmpeg_master' | 'require_generative_free';

export type ProcessingStageKey =
  | 'queued'
  | 'uploading'
  | 'upload_completed'
  | 'stage_1_ingestion'
  | 'stage_2_frame_extraction'
  | 'stage_3_character_tracking'
  | 'stage_4_character_replacement'
  | 'stage_5_temporal_consistency'
  | 'stage_6_video_reconstruction'
  | 'analyzing_scenes'
  | 'detecting_characters'
  | 'preparing_references'
  | 'connecting_provider'
  | 'selecting_model'
  | 'submitting_request'
  | 'generating_segments'
  | 'verifying_continuity'
  | 'processing_audio'
  | 'joining_segments'
  | 'encoding_final'
  | 'validating_output'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type FailureCategory =
  | 'quota_exhausted'
  | 'auth_failed'
  | 'provider_unavailable'
  | 'unsupported_video_generation'
  | 'missing_stage_dependency'
  | 'qc_failed'
  | 'processing_error';

export interface ErrorDiagnosticDetail {
  stage: ProcessingStageKey | string;
  provider: string;
  model?: string;
  httpStatus?: number | null;
  failureCategory?: FailureCategory;
  quotaIdentifier?: string | null;
  dailyLimit?: number | null;
  retryAfterAt?: string | null;
  providerJobId?: string | null;
  missingDependencies?: string[];
  userMessage: string;
  technicalError: string;
  timestamp: string;
}

export interface VideoMetadata {
  fileName: string;
  originalName: string;
  filePath: string;
  url: string;
  thumbnailUrl: string;
  durationSec: number;
  width: number;
  height: number;
  fps: number;
  codec: string;
  mimeType?: string;
  hasAudio: boolean;
  fileSizeBytes: number;
  verifiedPlayable?: boolean;
}

export interface CharacterIdentityProfile {
  facialStructure: string;
  eyeShape: string;
  noseShape: string;
  mouthShape: string;
  hair: string;
  facialHair: string;
  skinAppearance: string;
  distinctiveFeatures: string;
  clothingDetails: string;
  identitySummaryPrompt: string;
  analyzedByModel: string;
  analyzedAt: string;
}

export interface CharacterAsset {
  id: string;
  name: string;
  notes?: string;
  isPreset: boolean;
  primaryImageUrl: string;
  primaryImagePath: string;
  additionalImageUrls: string[];
  additionalImagePaths: string[];
  profile: CharacterIdentityProfile | null;
  createdAt: string;
}

export interface EnvironmentAsset {
  id: string;
  name: string;
  category: string;
  description: string;
  isPreset: boolean;
  imageUrl: string;
  imagePath: string;
  createdAt: string;
}

export interface DetectedCharacter {
  id: string;
  label: string;
  role: 'main' | 'secondary';
  appearanceTimestamps: string[];
  actions: string;
  visualDescription: string;
  thumbnailUrl: string;
  matchedCharacterId: string | null;
  confidenceNote: string;
}

export interface DirectorBlueprint {
  detectedLanguage: string;
  englishTranslation: string;
  targetCharactersToReplace: string[];
  preservedElements: string[];
  environmentTransformation: string;
  cameraAndMotionNotes: string;
  lightingAndAtmosphere: string;
  audioDesignPlan: {
    preserveDialogue: boolean;
    musicMood: string;
    soundEffects: string[];
    ambientBed: string;
  };
  transcriptSummary?: string;
}

export interface SegmentConsistencyCheck {
  checked: boolean;
  consistent: boolean;
  needsReview: boolean;
  notes: string;
  checkedFramesCount?: number;
  originalFaceStillPresent?: boolean;
  identityScore?: number | null;
  anatomicalValid?: boolean;
  motionMatched?: boolean;
  temporalFlicker?: boolean;
  backgroundDamaged?: boolean;
  failureReasons?: string[];
}

export interface ProjectSegment {
  index: number;
  startSec: number;
  durationSec: number;
  sourceSegmentPath: string;
  sourceSegmentUrl: string;
  keyframePath: string;
  keyframeUrl: string;
  outputSegmentPath: string | null;
  outputSegmentUrl: string | null;
  promptUsed: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  consistencyCheck: SegmentConsistencyCheck | null;
  errorMessage: string | null;
  providerUsed: string;
  modelUsed: string;
  providerJobId?: string | null;
  providerJobStatus?: string | null;
  httpStatusCode?: number | null;
  isNativeResolution: boolean;
  isEstimatedDuration: boolean;
}

export interface FrameCharacterTrack {
  characterId: string;
  label: string;
  bbox: [number, number, number, number]; // normalized [x, y, w, h]
  faceBox?: [number, number, number, number]; // normalized [x, y, w, h]
  poseSummary: string;
  occluded: boolean;
  maskPath?: string | null;
  maskUrl?: string | null;
}

export interface PipelineFrameRecord {
  index: number;
  timestampSec: number;
  sourceFramePath: string;
  sourceFrameUrl: string;
  unionMaskPath?: string | null;
  unionMaskUrl?: string | null;
  editedFramePath?: string | null;
  editedFrameUrl?: string | null;
  tracks: FrameCharacterTrack[];
  status: 'extracted' | 'tracked' | 'edited' | 'reprocessed' | 'failed';
  temporalSimilarityToPrev?: number | null;
  ssimVsSource?: number | null;
  identityScore?: number | null;
  providerUsed?: string | null;
  modelUsed?: string | null;
  errorMessage?: string | null;
}

export interface MultiStagePipelineState {
  workflowType: 'native_v2v' | 'multistage_frame_replacement' | 'legacy_recreation';
  samplingFps: number;
  sourceAudioPath: string | null;
  frames: PipelineFrameRecord[];
  lastCompletedStageNumber: number; // 0..6
  stageModels: {
    detection?: string;
    segmentation?: string;
    pose?: string;
    frameEditing?: string;
    temporal?: string;
    reconstruction?: string;
  };
  missingDependency?: {
    stage: ProcessingStageKey;
    title: string;
    description: string;
    setupOptions: Array<{
      id: string;
      label: string;
      costLabel: string;
      hardwareRequirement: string;
      instructions: string;
    }>;
  } | null;
}

export interface ProjectQcSummary {
  passed: boolean;
  inspectedFrames: number;
  originalFaceStillPresent: boolean;
  minIdentityScore: number | null;
  anatomicalValid?: boolean;
  motionMatched?: boolean;
  temporalFlickerDetected?: boolean;
  backgroundDamaged?: boolean;
  playableVerified?: boolean;
  issues: string[];
  checkedAt: string;
}

export interface ProcessingLogEntry {
  timestamp: string;
  stage: ProcessingStageKey;
  message: string;
  level: 'info' | 'warning' | 'error' | 'success';
}

export interface ProjectRecord {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  status:
    | 'draft'
    | 'queued'
    | 'analyzing'
    | 'awaiting_paid_confirmation'
    | 'processing'
    | 'completed'
    | 'partial_failure'
    | 'failed'
    | 'cancelled';
  currentStage: ProcessingStageKey;
  completedStages: ProcessingStageKey[];
  progressPercent: number;
  progressIsEstimate: boolean;
  providerProgressAvailable?: boolean;
  estimatedRemainingSec: number | null;
  statusMessage: string;
  errorMessage: string | null;
  diagnosticDetail?: ErrorDiagnosticDetail | null;

  sourceVideo: VideoMetadata;
  characterIds: string[];
  environmentId: string | null;
  environmentVideo: VideoMetadata | null;
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
  freeFallbackPolicy: FreeModeFallbackPolicy;
  paidConfirmed: boolean;

  detectedCharacters: DetectedCharacter[];
  characterMapping: Record<string, string | null>;
  blueprint: DirectorBlueprint | null;
  segments: ProjectSegment[];
  pipelineState?: MultiStagePipelineState | null;
  qcSummary?: ProjectQcSummary | null;

  outputVideoUrl: string | null;
  outputVideoPath: string | null;
  outputVideoMetadata: {
    width: number;
    height: number;
    durationSec: number;
    fileSizeBytes: number;
    codec: string;
    hasAudio: boolean;
    isNative1080p?: boolean;
    verifiedPlayable?: boolean;
  } | null;
  outputAudioUrl: string | null;
  outputAudioPath: string | null;

  selectedModels: {
    analysisModel: string;
    videoProvider: string;
    videoModel: string;
    audioModel: string | null;
    selectionReason?: string;
  };
  usageStats: {
    segmentsGenerated: number;
    generatedSeconds: number;
    estimatedCostUsd: number;
    billingNote: string;
  };
  history: ProcessingLogEntry[];
}

export interface UsageLedgerEntry {
  id: string;
  projectId: string;
  projectName: string;
  timestamp: string;
  provider: string;
  model: string;
  operation: string;
  billingMode: BillingMode;
  status: 'succeeded' | 'failed';
  segmentsCount: number;
  secondsGenerated: number;
  creditsConsumed: number;
  estimatedCostUsd: number;
  errorMessage?: string;
}

export interface SelfTestItem {
  id: string;
  name: string;
  status: 'PASS' | 'FAIL';
  durationMs: number;
  httpStatus?: number | null;
  summary: string;
  detail: string;
}

export interface SelfTestReport {
  ranAt: string;
  overallStatus: 'PASS' | 'PARTIAL_FAIL' | 'FAIL';
  passedCount: number;
  failedCount: number;
  tests: SelfTestItem[];
}

export type ModelRateLimitStatus =
  | 'available'
  | 'rate_limited'
  | 'daily_exhausted'
  | 'auth_failed'
  | 'unavailable'
  | 'unconfigured';

export interface ModelQuotaRecord {
  providerId: string;
  providerName: string;
  modelId: string;
  taskType: 'analysis' | 'image_editing' | 'video_generation' | 'audio_generation';
  freeTierEligible: boolean;
  confirmedDailyLimit: number | null;
  usedRequestsToday: number;
  remainingRequestsToday: number | null;
  rateLimitStatus: ModelRateLimitStatus;
  quotaIdentifier: string | null;
  retryAfterAt: string | null;
  resetAt: string | null;
  lastUpdatedAt: string;
  lastHttpStatus: number | null;
  lastError: string | null;
  dayKey: string;
}

export interface ProjectQuotaUsageRecord {
  projectId: string;
  projectName: string;
  dayKey: string;
  byProviderModel: Record<
    string,
    {
      providerId: string;
      modelId: string;
      requestsMade: number;
      succeeded: number;
      failed429: number;
      lastUsedAt: string;
    }
  >;
}
