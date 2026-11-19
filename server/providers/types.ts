import type {
  BackgroundMode,
  CharacterAsset,
  EnvironmentAsset,
  LightingMode,
  OutputAspectRatio,
  OutputResolution,
  QualityTier,
  ReplacementScope,
} from '../types.ts';

export type ProviderId =
  | 'google_gemini'
  | 'huggingface'
  | 'local_gpu_worker'
  | 'fal_ai'
  | 'replicate'
  | 'runway'
  | 'luma';

export type ReplacementWorkflow =
  | 'v2v_multi_ref'
  | 'v2v_single_ref'
  | 'multistage_image_edit'
  | 'i2v_only'
  | 't2v_only'
  | 'analysis_only';

export type PipelineStageRole =
  | 'character_detection'
  | 'segmentation'
  | 'pose_estimation'
  | 'face_image_editing'
  | 'reference_image_generation'
  | 'temporal_consistency'
  | 'video_reconstruction';

export interface ProviderModelSpec {
  id: string;
  name: string;
  taskType: 'analysis' | 'image_editing' | 'video_generation' | 'audio_generation';
  stageRoles?: PipelineStageRole[];
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
  replacementWorkflow?: ReplacementWorkflow;
  characterPreservationScore: number; // 1..100
  qualityScore: number; // 1..100
  motionAccuracyScore: number; // 1..100
  speedScore: number; // 1..100
  estimatedCostPerSecUsd: number;
  estimatedCostPerFrameUsd?: number;
}

export interface ProviderQuotaInfo {
  exposedByApi: boolean;
  confirmedCreditsRemaining: number | null;
  confirmedSecondsRemaining: number | null;
  unitLabel: string;
  note: string;
  checkedAt: string | null;
}

export interface ManualQuotaEstimate {
  dailyCreditsRemaining: number | null;
  monthlyCreditsRemaining: number | null;
  estimatedSecondsRemaining: number | null;
  nextResetAt: string | null;
  note: string;
}

export interface ProviderConfigRecord {
  id: string; // e.g. 'google_gemini', 'huggingface', 'local_gpu_worker'
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
  confirmedQuota: ProviderQuotaInfo;
  manualEstimate: ManualQuotaEstimate;
  models: ProviderModelSpec[];
}

export interface MappedCharacterPair {
  sourceCharacterId: string;
  sourceLabel: string;
  sourceRole: 'main' | 'secondary';
  sourceVisualDescription: string;
  targetCharacter: CharacterAsset;
}

export interface SegmentGenerationRequest {
  sourceSegmentPath: string;
  keyframePath: string;
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
  modelId: string;
  existingProviderJobId?: string | null;
  projectId?: string;
  projectName?: string;
  onJobCreated?: (jobId: string) => void;
  onPollProgress?: (providerStatus: string, pollCount: number) => void;
  isCancelled?: () => boolean;
}

export interface SegmentGenerationResult {
  providerId: string;
  providerName: string;
  modelUsed: string;
  providerJobId?: string | null;
  isNativeResolution: boolean;
  creditsConsumed: number;
  estimatedCostUsd: number;
}

export interface FrameTrackBinding {
  sourceCharacterId: string;
  sourceLabel: string;
  bbox: [number, number, number, number];
  faceBox?: [number, number, number, number];
  poseSummary: string;
  occluded: boolean;
  maskPath?: string | null;
  targetCharacter: CharacterAsset;
}

export interface FrameEditRequest {
  frameIndex: number;
  totalFrames: number;
  timestampSec: number;
  sourceFramePath: string;
  outFramePath: string;
  unionMaskPath?: string | null;
  previousEditedFramePath?: string | null;
  sourceWidth: number;
  sourceHeight: number;
  aspectRatio: OutputAspectRatio;
  replacementScope: ReplacementScope;
  backgroundMode: BackgroundMode;
  lightingMode: LightingMode;
  environmentRef: EnvironmentAsset | null;
  bindings: FrameTrackBinding[];
  preservedCharacterLabels: string[];
  prompt: string;
  modelId: string;
  projectId?: string;
  projectName?: string;
}

export interface FrameEditResult {
  providerId: string;
  providerName: string;
  modelUsed: string;
  creditsConsumed: number;
  estimatedCostUsd: number;
}

export interface ProviderAdapter {
  providerType: ProviderId;
  testConnection(config: ProviderConfigRecord): Promise<{
    connected: boolean;
    message: string;
  }>;
  discoverModels(config: ProviderConfigRecord): Promise<ProviderModelSpec[]>;
  checkQuota(config: ProviderConfigRecord): Promise<ProviderQuotaInfo>;
  generateVideoSegment?(
    config: ProviderConfigRecord,
    req: SegmentGenerationRequest
  ): Promise<SegmentGenerationResult>;
  editCharacterFrame?(
    config: ProviderConfigRecord,
    req: FrameEditRequest
  ): Promise<FrameEditResult>;
}
