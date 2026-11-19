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

export type NavSection =
  | 'create'
  | 'projects'
  | 'characters'
  | 'environments'
  | 'models'
  | 'settings'
  | 'usage'
  | 'diagnostics'
  | 'help';

export type FailureCategory =
  | 'quota_exhausted'
  | 'auth_failed'
  | 'provider_unavailable'
  | 'unsupported_video_generation'
  | 'missing_stage_dependency'
  | 'qc_failed'
  | 'processing_error';

export interface ErrorDiagnosticDetail {
  stage: string;
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
  additionalImageUrls: string[];
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
  sourceSegmentUrl: string;
  keyframeUrl: string;
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
}

export interface FrameCharacterTrack {
  characterId: string;
  label: string;
  bbox: [number, number, number, number];
  faceBox?: [number, number, number, number];
  poseSummary: string;
  occluded: boolean;
  maskUrl?: string | null;
}

export interface PipelineFrameRecord {
  index: number;
  timestampSec: number;
  sourceFrameUrl: string;
  unionMaskUrl?: string | null;
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
  frames: PipelineFrameRecord[];
  lastCompletedStageNumber: number;
  stageModels: {
    detection?: string;
    segmentation?: string;
    pose?: string;
    frameEditing?: string;
    temporal?: string;
    reconstruction?: string;
  };
  missingDependency?: {
    stage: string;
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
  stage: string;
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
  currentStage: string;
  completedStages: string[];
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

export type ProviderId =
  | 'google_gemini'
  | 'huggingface'
  | 'local_gpu_worker'
  | 'fal_ai'
  | 'replicate'
  | 'runway'
  | 'luma';

export interface ProviderModelSpec {
  id: string;
  name: string;
  taskType: 'analysis' | 'image_editing' | 'video_generation' | 'audio_generation';
  stageRoles?: string[];
  freeTierEligible: boolean;
  freeTierNotes: string;
  hardwareRequirement?: string;
  maxDurationSec: number;
  supportedResolutions: Array<'480p' | '720p' | '1080p'>;
  supportedAspectRatios?: Array<'16:9' | '9:16' | '1:1'>;
  supportsImageToVideo: boolean;
  supportsVideoToVideo: boolean;
  supportsImageEditing?: boolean;
  supportsCharacterReference: boolean;
  supportsCharacterReplacement?: boolean;
  supportsFullBodyReplacement?: boolean;
  supportsFaceOnlyReplacement?: boolean;
  supportsMultiCharacter?: boolean;
  replacementWorkflow?: string;
  characterPreservationScore: number;
  qualityScore: number;
  motionAccuracyScore: number;
  speedScore: number;
  estimatedCostPerSecUsd: number;
  estimatedCostPerFrameUsd?: number;
}

export interface ProviderConfigRecord {
  id: string;
  providerType: ProviderId;
  displayName: string;
  isBuiltin: boolean;
  enabled: boolean;
  envVarName: string;
  endpointUrl?: string | null;
  officialPortalUrl: string;
  apiSupportStatus: 'official_api' | 'paid_only_api' | 'local_worker' | 'unsupported_free_video';
  freeVideoEligible: boolean;
  hardwareRequirement?: string;
  connectionStatus: 'connected' | 'unconfigured' | 'error' | 'disabled';
  lastCheckedAt: string | null;
  lastError: string | null;
  confirmedQuota: {
    exposedByApi: boolean;
    confirmedCreditsRemaining: number | null;
    confirmedSecondsRemaining: number | null;
    unitLabel: string;
    note: string;
    checkedAt: string | null;
  };
  manualEstimate: {
    dailyCreditsRemaining: number | null;
    monthlyCreditsRemaining: number | null;
    estimatedSecondsRemaining: number | null;
    nextResetAt: string | null;
    note: string;
  };
  models: ProviderModelSpec[];
}

export interface ModelCatalogItem {
  id: string;
  name: string;
  provider: string;
  category: string;
  billingTier: 'free_eligible' | 'paid_required';
  capabilities: string[];
  limits: string;
  hardwareRequirement?: string;
  estimatedCostPerSecUsd?: number;
  estimatedCostPerFrameUsd?: number;
  estimatedCostPerClipUsd?: number;
  status: string;
}

export interface QuotaDashboardResponse {
  totals: {
    totalConfirmedFreeCredits: number | null;
    hasConfirmedFreeVideoQuota: boolean;
    manualEstimatedDailyCredits: number | null;
    manualEstimatedMonthlyCredits: number | null;
    manualEstimatedSecondsRemaining: number | null;
    secondsGeneratedToday: number;
    minutesGeneratedToday: number;
    minutesGeneratedThisMonth: number;
    totalSegments: number;
    totalSeconds: number;
    totalEstimatedCostUsd: number;
    freeRuns: number;
    paidRuns: number;
    failedAttempts: number;
  };
  consumedByProvider: Record<
    string,
    { credits: number; seconds: number; failed: number }
  >;
  modelQuotas?: ModelQuotaRecord[];
  projectQuotas?: ProjectQuotaUsageRecord[];
  cacheStats?: {
    cachedEntries: number;
    cacheHitsToday: number;
  };
  providers: ProviderConfigRecord[];
  entries: Array<{
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
  }>;
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

export interface QueueOverview {
  pending: ProjectRecord[];
  active: ProjectRecord[];
  completed: ProjectRecord[];
  failed: ProjectRecord[];
}

export interface SettingsStatus {
  provider: string;
  configured: boolean;
  storageMode: string;
  officialKeyPortalUrl: string;
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

export interface TaskCapabilityPreview {
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
  pipelineCapabilities: PipelineCapabilityMatrix;
  missingStage4SetupOptions: Array<{
    id: string;
    label: string;
    costLabel: string;
    hardwareRequirement: string;
    instructions: string;
  }>;
  blockingReason: string | null;
}
