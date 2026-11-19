import fs from 'fs';
import path from 'path';
import type { ProviderConfigRecord } from './providers/types.ts';
import type {
  CharacterAsset,
  EnvironmentAsset,
  ProjectRecord,
  UsageLedgerEntry,
} from './types.ts';

const ROOT_DIR = process.cwd();
export const DATA_DIR = path.join(ROOT_DIR, 'data');
export const STORAGE_DIR = path.join(ROOT_DIR, 'storage');
export const UPLOADS_DIR = path.join(STORAGE_DIR, 'uploads');
export const CHUNKS_DIR = path.join(STORAGE_DIR, 'chunks');
export const CHARACTERS_DIR = path.join(STORAGE_DIR, 'characters');
export const ENVIRONMENTS_DIR = path.join(STORAGE_DIR, 'environments');
export const PROJECTS_DIR = path.join(STORAGE_DIR, 'projects');

for (const dir of [
  DATA_DIR,
  STORAGE_DIR,
  UPLOADS_DIR,
  CHUNKS_DIR,
  CHARACTERS_DIR,
  ENVIRONMENTS_DIR,
  PROJECTS_DIR,
]) {
  fs.mkdirSync(dir, { recursive: true });
}

const PROJECTS_FILE = path.join(DATA_DIR, 'projects.json');
const CHARACTERS_FILE = path.join(DATA_DIR, 'characters.json');
const ENVIRONMENTS_FILE = path.join(DATA_DIR, 'environments.json');
const USAGE_FILE = path.join(DATA_DIR, 'usage.json');
const PROVIDERS_FILE = path.join(DATA_DIR, 'providers.json');

function readJson<T>(filePath: string, fallback: T): T {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(filePath: string, data: unknown): void {
  const tmpPath = `${filePath}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmpPath, filePath);
}

export function isEnvSecretSet(envVarName: string): boolean {
  const val = process.env[envVarName]?.trim();
  return Boolean(val && val.length > 0 && !val.startsWith('MY_'));
}

export function isProviderConfigured(p: ProviderConfigRecord): boolean {
  if (p.providerType === 'local_gpu_worker') {
    return Boolean(
      (p.endpointUrl && p.endpointUrl.trim().length > 0) ||
        isEnvSecretSet(p.envVarName)
    );
  }
  return isEnvSecretSet(p.envVarName);
}

export function buildDefaultProviders(): ProviderConfigRecord[] {
  const localWorkerEnvUrl = process.env.LOCAL_GPU_BACKEND_URL?.trim() || null;
  return [
    {
      id: 'local_gpu_worker',
      providerType: 'local_gpu_worker',
      displayName: 'Open-Source Local / External GPU Worker',
      isBuiltin: true,
      enabled: true,
      envVarName: 'LOCAL_GPU_BACKEND_URL',
      endpointUrl: localWorkerEnvUrl,
      officialPortalUrl: 'https://github.com/s0md3v/roop',
      apiSupportStatus: 'local_worker',
      freeVideoEligible: true,
      hardwareRequirement:
        'Requires NVIDIA GPU with 8–16 GB VRAM running worker/gpu_worker.py (local PC, RunPod, or free Colab GPU). $0 API fees.',
      connectionStatus: localWorkerEnvUrl ? 'connected' : 'unconfigured',
      lastCheckedAt: null,
      lastError: null,
      confirmedQuota: {
        exposedByApi: true,
        confirmedCreditsRemaining: localWorkerEnvUrl ? 9999 : null,
        confirmedSecondsRemaining: null,
        unitLabel: 'frames ($0 API cost)',
        note: 'Self-hosted open-source worker running InsightFace / ControlNet / IP-Adapter + LivePortrait on your own GPU. Zero third-party API billing.',
        checkedAt: null,
      },
      manualEstimate: {
        dailyCreditsRemaining: null,
        monthlyCreditsRemaining: null,
        estimatedSecondsRemaining: null,
        nextResetAt: null,
        note: 'Unlimited local GPU execution once worker/gpu_worker.py is reachable.',
      },
      models: [
        {
          id: 'flux-controlnet-ipadapter',
          name: 'Open-Source Full-Body Character Swap (ControlNet + IP-Adapter + InsightFace)',
          taskType: 'image_editing',
          stageRoles: ['segmentation', 'pose_estimation', 'face_image_editing', 'temporal_consistency'],
          freeTierEligible: true,
          freeTierNotes: 'Self-hosted open-source ($0 API cost). Full-body + face character replacement using pose & identity masks.',
          hardwareRequirement: '12–16 GB VRAM NVIDIA GPU (or Colab T4/L4)',
          maxDurationSec: 60,
          supportedResolutions: ['480p', '720p', '1080p'],
          supportedAspectRatios: ['16:9', '9:16', '1:1'],
          supportsImageToVideo: false,
          supportsVideoToVideo: false,
          supportsImageEditing: true,
          supportsCharacterReference: true,
          supportsCharacterReplacement: true,
          supportsFullBodyReplacement: true,
          supportsFaceOnlyReplacement: true,
          supportsMultiCharacter: true,
          replacementWorkflow: 'multistage_image_edit',
          characterPreservationScore: 95,
          qualityScore: 92,
          motionAccuracyScore: 95,
          speedScore: 78,
          estimatedCostPerSecUsd: 0,
          estimatedCostPerFrameUsd: 0,
        },
        {
          id: 'insightface-inswapper-128',
          name: 'InsightFace InSwapper 128 + CodeFormer (Face Replacement)',
          taskType: 'image_editing',
          stageRoles: ['face_image_editing'],
          freeTierEligible: true,
          freeTierNotes: 'Self-hosted open-source ($0 API cost). Fast face & head identity replacement preserving original body/clothes.',
          hardwareRequirement: '8 GB VRAM NVIDIA GPU (fast per-frame inference)',
          maxDurationSec: 60,
          supportedResolutions: ['480p', '720p', '1080p'],
          supportedAspectRatios: ['16:9', '9:16', '1:1'],
          supportsImageToVideo: false,
          supportsVideoToVideo: false,
          supportsImageEditing: true,
          supportsCharacterReference: true,
          supportsCharacterReplacement: true,
          supportsFullBodyReplacement: false,
          supportsFaceOnlyReplacement: true,
          supportsMultiCharacter: true,
          replacementWorkflow: 'multistage_image_edit',
          characterPreservationScore: 94,
          qualityScore: 88,
          motionAccuracyScore: 96,
          speedScore: 92,
          estimatedCostPerSecUsd: 0,
          estimatedCostPerFrameUsd: 0,
        },
      ],
    },
    {
      id: 'google_gemini',
      providerType: 'google_gemini',
      displayName: 'Google Gemini API (Official)',
      isBuiltin: true,
      enabled: true,
      envVarName: 'GEMINI_API_KEY',
      officialPortalUrl: 'https://aistudio.google.com/app/apikey',
      apiSupportStatus: 'official_api',
      freeVideoEligible: false,
      connectionStatus: isEnvSecretSet('GEMINI_API_KEY')
        ? 'connected'
        : 'unconfigured',
      lastCheckedAt: null,
      lastError: null,
      confirmedQuota: {
        exposedByApi: false,
        confirmedCreditsRemaining: null,
        confirmedSecondsRemaining: null,
        unitLabel: 'credits',
        note: 'Quota information unavailable via API. gemini-4-hydrogen (Stages 2–3 detection, tracking & Stage 5/6 QA) uses free tier; frame image editing & Omni V2V require a billing-enabled key.',
        checkedAt: null,
      },
      manualEstimate: {
        dailyCreditsRemaining: null,
        monthlyCreditsRemaining: null,
        estimatedSecondsRemaining: null,
        nextResetAt: null,
        note: 'Analysis & tracking free-tier active; paid key required for frame image editing & Omni V2V.',
      },
      models: [
        {
          id: 'gemini-4-hydrogen',
          name: 'Gemini 4 Hydrogen (Detection, Tracking & QA)',
          taskType: 'analysis',
          stageRoles: ['character_detection', 'pose_estimation', 'temporal_consistency'],
          freeTierEligible: true,
          freeTierNotes: 'Free-tier eligible for character profiling, multi-frame detection/tracking, and 7-point QC inspection',
          maxDurationSec: 120,
          supportedResolutions: ['720p', '1080p'],
          supportedAspectRatios: ['16:9', '9:16', '1:1'],
          supportsImageToVideo: false,
          supportsVideoToVideo: false,
          supportsImageEditing: false,
          supportsCharacterReference: true,
          supportsCharacterReplacement: false,
          supportsFullBodyReplacement: false,
          supportsFaceOnlyReplacement: false,
          supportsMultiCharacter: true,
          replacementWorkflow: 'analysis_only',
          characterPreservationScore: 95,
          qualityScore: 92,
          motionAccuracyScore: 90,
          speedScore: 95,
          estimatedCostPerSecUsd: 0,
        },
        {
          id: 'gemini-3.1-flash-lite-image',
          name: 'Gemini 3.1 Flash Image (Stage 4 Frame Editor)',
          taskType: 'image_editing',
          stageRoles: ['face_image_editing', 'reference_image_generation'],
          freeTierEligible: false,
          freeTierNotes: 'Paid-tier multimodal image editor for mask/reference-conditioned Stage 4 character replacement',
          maxDurationSec: 60,
          supportedResolutions: ['720p', '1080p'],
          supportedAspectRatios: ['16:9', '9:16', '1:1'],
          supportsImageToVideo: false,
          supportsVideoToVideo: false,
          supportsImageEditing: true,
          supportsCharacterReference: true,
          supportsCharacterReplacement: true,
          supportsFullBodyReplacement: true,
          supportsFaceOnlyReplacement: true,
          supportsMultiCharacter: true,
          replacementWorkflow: 'multistage_image_edit',
          characterPreservationScore: 92,
          qualityScore: 93,
          motionAccuracyScore: 91,
          speedScore: 86,
          estimatedCostPerSecUsd: 0.08,
          estimatedCostPerFrameUsd: 0.02,
        },
        {
          id: 'gemini-nano-banana-2.1',
          name: 'Gemini Nano Banana 2.1 (High-Fidelity Frame Editor)',
          taskType: 'image_editing',
          stageRoles: ['face_image_editing', 'reference_image_generation'],
          freeTierEligible: false,
          freeTierNotes: 'Paid-tier Nano Banana Pro image editor for highest facial consistency across Stage 4 frames',
          maxDurationSec: 60,
          supportedResolutions: ['720p', '1080p'],
          supportedAspectRatios: ['16:9', '9:16', '1:1'],
          supportsImageToVideo: false,
          supportsVideoToVideo: false,
          supportsImageEditing: true,
          supportsCharacterReference: true,
          supportsCharacterReplacement: true,
          supportsFullBodyReplacement: true,
          supportsFaceOnlyReplacement: true,
          supportsMultiCharacter: true,
          replacementWorkflow: 'multistage_image_edit',
          characterPreservationScore: 96,
          qualityScore: 96,
          motionAccuracyScore: 93,
          speedScore: 76,
          estimatedCostPerSecUsd: 0.16,
          estimatedCostPerFrameUsd: 0.04,
        },
        {
          id: 'gemini-omni-1.2-flash',
          name: 'Gemini Omni 1.2 Flash (Native V2V Engine)',
          taskType: 'video_generation',
          freeTierEligible: false,
          freeTierNotes: 'Requires billing-enabled API key (native V2V multi-ref character replacement)',
          maxDurationSec: 15,
          supportedResolutions: ['720p', '1080p'],
          supportedAspectRatios: ['16:9', '9:16'],
          supportsImageToVideo: true,
          supportsVideoToVideo: true,
          supportsImageEditing: false,
          supportsCharacterReference: true,
          supportsCharacterReplacement: true,
          supportsFullBodyReplacement: true,
          supportsFaceOnlyReplacement: true,
          supportsMultiCharacter: true,
          replacementWorkflow: 'v2v_multi_ref',
          characterPreservationScore: 94,
          qualityScore: 94,
          motionAccuracyScore: 92,
          speedScore: 72,
          estimatedCostPerSecUsd: 0.15,
        },
      ],
    },
    {
      id: 'huggingface',
      providerType: 'huggingface',
      displayName: 'Hugging Face Inference Providers',
      isBuiltin: true,
      enabled: true,
      envVarName: 'HF_TOKEN',
      officialPortalUrl: 'https://huggingface.co/settings/tokens',
      apiSupportStatus: 'official_api',
      freeVideoEligible: true,
      connectionStatus: isEnvSecretSet('HF_TOKEN')
        ? 'connected'
        : 'unconfigured',
      lastCheckedAt: null,
      lastError: null,
      confirmedQuota: {
        exposedByApi: false,
        confirmedCreditsRemaining: null,
        confirmedSecondsRemaining: null,
        unitLabel: 'USD inference credit',
        note: 'Quota information unavailable via API. Free HF accounts include monthly Inference Providers credits; check huggingface.co/settings/billing and enter an optional manual estimate.',
        checkedAt: null,
      },
      manualEstimate: {
        dailyCreditsRemaining: null,
        monthlyCreditsRemaining: null,
        estimatedSecondsRemaining: null,
        nextResetAt: null,
        note: 'Official monthly free inference credit varies by account tier.',
      },
      models: [
        {
          id: 'Qwen/Qwen-Image-Edit',
          name: 'Qwen Image Edit (Stage 4 HF Inference Router)',
          taskType: 'image_editing',
          stageRoles: ['face_image_editing', 'reference_image_generation'],
          freeTierEligible: true,
          freeTierNotes: 'Uses HF monthly free inference credits for Stage 4 reference-conditioned frame editing',
          maxDurationSec: 60,
          supportedResolutions: ['480p', '720p', '1080p'],
          supportedAspectRatios: ['16:9', '9:16', '1:1'],
          supportsImageToVideo: false,
          supportsVideoToVideo: false,
          supportsImageEditing: true,
          supportsCharacterReference: true,
          supportsCharacterReplacement: true,
          supportsFullBodyReplacement: true,
          supportsFaceOnlyReplacement: true,
          supportsMultiCharacter: true,
          replacementWorkflow: 'multistage_image_edit',
          characterPreservationScore: 86,
          qualityScore: 88,
          motionAccuracyScore: 86,
          speedScore: 74,
          estimatedCostPerSecUsd: 0,
          estimatedCostPerFrameUsd: 0,
        },
        {
          id: 'black-forest-labs/FLUX.1-Kontext-dev',
          name: 'FLUX.1 Kontext Dev (Stage 4 HF Inference Router)',
          taskType: 'image_editing',
          stageRoles: ['face_image_editing', 'reference_image_generation'],
          freeTierEligible: true,
          freeTierNotes: 'Uses HF monthly free inference credits for subject/character-preserving image editing',
          maxDurationSec: 60,
          supportedResolutions: ['480p', '720p', '1080p'],
          supportedAspectRatios: ['16:9', '9:16', '1:1'],
          supportsImageToVideo: false,
          supportsVideoToVideo: false,
          supportsImageEditing: true,
          supportsCharacterReference: true,
          supportsCharacterReplacement: true,
          supportsFullBodyReplacement: true,
          supportsFaceOnlyReplacement: true,
          supportsMultiCharacter: false,
          replacementWorkflow: 'multistage_image_edit',
          characterPreservationScore: 85,
          qualityScore: 89,
          motionAccuracyScore: 85,
          speedScore: 72,
          estimatedCostPerSecUsd: 0,
          estimatedCostPerFrameUsd: 0,
        },
        {
          id: 'Wan-AI/Wan2.2-TI2V-5B',
          name: 'Wan 2.2 TI2V 5B (via HF Router)',
          taskType: 'video_generation',
          freeTierEligible: true,
          freeTierNotes: 'I2V/T2V only — does not accept source video motion input for character replacement',
          maxDurationSec: 5,
          supportedResolutions: ['480p', '720p'],
          supportedAspectRatios: ['16:9', '9:16'],
          supportsImageToVideo: true,
          supportsVideoToVideo: false,
          supportsCharacterReference: true,
          supportsCharacterReplacement: false,
          supportsMultiCharacter: false,
          replacementWorkflow: 'i2v_only',
          characterPreservationScore: 70,
          qualityScore: 76,
          motionAccuracyScore: 74,
          speedScore: 68,
          estimatedCostPerSecUsd: 0,
        },
        {
          id: 'Lightricks/LTX-Video',
          name: 'LTX-Video (via HF Router)',
          taskType: 'video_generation',
          freeTierEligible: true,
          freeTierNotes: 'I2V/T2V only — does not support video-to-video character replacement',
          maxDurationSec: 5,
          supportedResolutions: ['480p', '720p'],
          supportedAspectRatios: ['16:9'],
          supportsImageToVideo: true,
          supportsVideoToVideo: false,
          supportsCharacterReference: false,
          supportsCharacterReplacement: false,
          supportsMultiCharacter: false,
          replacementWorkflow: 'i2v_only',
          characterPreservationScore: 62,
          qualityScore: 72,
          motionAccuracyScore: 72,
          speedScore: 80,
          estimatedCostPerSecUsd: 0,
        },
      ],
    },
    {
      id: 'fal_ai',
      providerType: 'fal_ai',
      displayName: 'fal.ai Platform API',
      isBuiltin: true,
      enabled: true,
      envVarName: 'FAL_KEY',
      officialPortalUrl: 'https://fal.ai/dashboard/keys',
      apiSupportStatus: 'official_api',
      freeVideoEligible: false,
      connectionStatus: isEnvSecretSet('FAL_KEY') ? 'connected' : 'unconfigured',
      lastCheckedAt: null,
      lastError: null,
      confirmedQuota: {
        exposedByApi: true,
        confirmedCreditsRemaining: null,
        confirmedSecondsRemaining: null,
        unitLabel: 'USD credits',
        note: 'Supports live credit balance inspection via api.fal.ai/v1/billing when FAL_KEY has billing:usage:read scope.',
        checkedAt: null,
      },
      manualEstimate: {
        dailyCreditsRemaining: null,
        monthlyCreditsRemaining: null,
        estimatedSecondsRemaining: null,
        nextResetAt: null,
        note: 'Pay-as-you-go after initial developer grant.',
      },
      models: [
        {
          id: 'fal-ai/flux-pro/kontext',
          name: 'FLUX.1 Kontext Pro (Stage 4 Image Editor)',
          taskType: 'image_editing',
          stageRoles: ['face_image_editing', 'reference_image_generation'],
          freeTierEligible: false,
          freeTierNotes: 'Paid frame editing model on fal.ai for Stage 4 character replacement (~$0.04/frame)',
          maxDurationSec: 60,
          supportedResolutions: ['720p', '1080p'],
          supportedAspectRatios: ['16:9', '9:16', '1:1'],
          supportsImageToVideo: false,
          supportsVideoToVideo: false,
          supportsImageEditing: true,
          supportsCharacterReference: true,
          supportsCharacterReplacement: true,
          supportsFullBodyReplacement: true,
          supportsFaceOnlyReplacement: true,
          supportsMultiCharacter: true,
          replacementWorkflow: 'multistage_image_edit',
          characterPreservationScore: 91,
          qualityScore: 92,
          motionAccuracyScore: 90,
          speedScore: 85,
          estimatedCostPerSecUsd: 0.16,
          estimatedCostPerFrameUsd: 0.04,
        },
        {
          id: 'fal-ai/wan-i2v',
          name: 'Wan 2.1 Image-to-Video',
          taskType: 'video_generation',
          freeTierEligible: false,
          freeTierNotes: 'I2V only — uses account credit balance; does not preserve source video motion',
          maxDurationSec: 5,
          supportedResolutions: ['480p', '720p'],
          supportedAspectRatios: ['16:9', '9:16'],
          supportsImageToVideo: true,
          supportsVideoToVideo: false,
          supportsCharacterReference: true,
          supportsCharacterReplacement: false,
          supportsMultiCharacter: false,
          replacementWorkflow: 'i2v_only',
          characterPreservationScore: 74,
          qualityScore: 80,
          motionAccuracyScore: 78,
          speedScore: 82,
          estimatedCostPerSecUsd: 0.08,
        },
      ],
    },
    {
      id: 'replicate',
      providerType: 'replicate',
      displayName: 'Replicate API',
      isBuiltin: true,
      enabled: false,
      envVarName: 'REPLICATE_API_TOKEN',
      officialPortalUrl: 'https://replicate.com/account/api-tokens',
      apiSupportStatus: 'paid_only_api',
      freeVideoEligible: false,
      connectionStatus: isEnvSecretSet('REPLICATE_API_TOKEN')
        ? 'connected'
        : 'unconfigured',
      lastCheckedAt: null,
      lastError: null,
      confirmedQuota: {
        exposedByApi: false,
        confirmedCreditsRemaining: null,
        confirmedSecondsRemaining: null,
        unitLabel: 'USD credits',
        note: 'Quota information unavailable via Replicate API. Requires paid billing after limited initial trial.',
        checkedAt: null,
      },
      manualEstimate: {
        dailyCreditsRemaining: null,
        monthlyCreditsRemaining: null,
        estimatedSecondsRemaining: null,
        nextResetAt: null,
        note: 'Paid usage per prediction second.',
      },
      models: [
        {
          id: 'minimax/video-01',
          name: 'MiniMax Video-01 (via Replicate)',
          taskType: 'video_generation',
          freeTierEligible: false,
          freeTierNotes: 'I2V only — paid per prediction',
          maxDurationSec: 6,
          supportedResolutions: ['720p'],
          supportedAspectRatios: ['16:9'],
          supportsImageToVideo: true,
          supportsVideoToVideo: false,
          supportsCharacterReference: true,
          supportsCharacterReplacement: false,
          supportsMultiCharacter: false,
          replacementWorkflow: 'i2v_only',
          characterPreservationScore: 78,
          qualityScore: 82,
          motionAccuracyScore: 79,
          speedScore: 70,
          estimatedCostPerSecUsd: 0.1,
        },
      ],
    },
    {
      id: 'runway',
      providerType: 'runway',
      displayName: 'Runway API',
      isBuiltin: true,
      enabled: false,
      envVarName: 'RUNWAYML_API_SECRET',
      officialPortalUrl: 'https://dev.runwayml.com/',
      apiSupportStatus: 'paid_only_api',
      freeVideoEligible: false,
      connectionStatus: isEnvSecretSet('RUNWAYML_API_SECRET')
        ? 'connected'
        : 'unconfigured',
      lastCheckedAt: null,
      lastError: null,
      confirmedQuota: {
        exposedByApi: false,
        confirmedCreditsRemaining: null,
        confirmedSecondsRemaining: null,
        unitLabel: 'credits',
        note: 'Paid API plan required. Does not provide a recurring free API tier.',
        checkedAt: null,
      },
      manualEstimate: {
        dailyCreditsRemaining: null,
        monthlyCreditsRemaining: null,
        estimatedSecondsRemaining: null,
        nextResetAt: null,
        note: 'Paid API credits required.',
      },
      models: [
        {
          id: 'gen4_turbo',
          name: 'Runway Gen-4 Turbo (I2V)',
          taskType: 'video_generation',
          freeTierEligible: false,
          freeTierNotes: 'I2V only — paid API credits required',
          maxDurationSec: 10,
          supportedResolutions: ['720p', '1080p'],
          supportedAspectRatios: ['16:9', '9:16'],
          supportsImageToVideo: true,
          supportsVideoToVideo: false,
          supportsCharacterReference: true,
          supportsCharacterReplacement: false,
          supportsMultiCharacter: false,
          replacementWorkflow: 'i2v_only',
          characterPreservationScore: 85,
          qualityScore: 88,
          motionAccuracyScore: 86,
          speedScore: 84,
          estimatedCostPerSecUsd: 0.12,
        },
      ],
    },
    {
      id: 'luma',
      providerType: 'luma',
      displayName: 'Luma Dream Machine API',
      isBuiltin: true,
      enabled: false,
      envVarName: 'LUMA_API_KEY',
      officialPortalUrl: 'https://lumalabs.ai/dream-machine/api',
      apiSupportStatus: 'paid_only_api',
      freeVideoEligible: false,
      connectionStatus: isEnvSecretSet('LUMA_API_KEY')
        ? 'connected'
        : 'unconfigured',
      lastCheckedAt: null,
      lastError: null,
      confirmedQuota: {
        exposedByApi: false,
        confirmedCreditsRemaining: null,
        confirmedSecondsRemaining: null,
        unitLabel: 'credits',
        note: 'Paid API credits required. No recurring free API tier exposed.',
        checkedAt: null,
      },
      manualEstimate: {
        dailyCreditsRemaining: null,
        monthlyCreditsRemaining: null,
        estimatedSecondsRemaining: null,
        nextResetAt: null,
        note: 'Paid API credits required.',
      },
      models: [
        {
          id: 'ray-2',
          name: 'Luma Ray 2',
          taskType: 'video_generation',
          freeTierEligible: false,
          freeTierNotes: 'I2V/T2V only — paid API credits required',
          maxDurationSec: 9,
          supportedResolutions: ['720p', '1080p'],
          supportedAspectRatios: ['16:9', '9:16', '1:1'],
          supportsImageToVideo: true,
          supportsVideoToVideo: false,
          supportsCharacterReference: true,
          supportsCharacterReplacement: false,
          supportsMultiCharacter: false,
          replacementWorkflow: 'i2v_only',
          characterPreservationScore: 82,
          qualityScore: 87,
          motionAccuracyScore: 85,
          speedScore: 76,
          estimatedCostPerSecUsd: 0.12,
        },
      ],
    },
  ];
}

const PRESET_ENVIRONMENTS: EnvironmentAsset[] = [
  {
    id: 'preset_env_snowy_village',
    name: 'Snowy Alpine Village (Sample Preset)',
    category: 'Winter / Mountain',
    description:
      'Quiet alpine timber village at blue hour twilight with warm lantern windows and gentle snowfall.',
    isPreset: true,
    imageUrl: '/src/assets/images/env_snowy_village_1795068456626.jpg',
    imagePath: path.join(
      ROOT_DIR,
      'src/assets/images/env_snowy_village_1795068456626.jpg'
    ),
    createdAt: '2026-11-18T00:00:00.000Z',
  },
  {
    id: 'preset_env_ancient_city',
    name: 'Ancient Stone Citadel at Night (Sample Preset)',
    category: 'Historical / Night',
    description:
      'Sandstone arches lit by flickering torches under a clear starry sky with subtle courtyard mist.',
    isPreset: true,
    imageUrl: '/src/assets/images/env_ancient_city_1795068457296.jpg',
    imagePath: path.join(
      ROOT_DIR,
      'src/assets/images/env_ancient_city_1795068457296.jpg'
    ),
    createdAt: '2026-11-18T00:00:00.000Z',
  },
  {
    id: 'preset_env_rainy_street',
    name: 'Rainy Cobblestone Street (Sample Preset)',
    category: 'Urban / Noir',
    description:
      'Rain-slicked European street at dusk with amber streetlamp reflections on wet stone.',
    isPreset: true,
    imageUrl: '/src/assets/images/env_rainy_street_1795068457227.jpg',
    imagePath: path.join(
      ROOT_DIR,
      'src/assets/images/env_rainy_street_1795068457227.jpg'
    ),
    createdAt: '2026-11-18T00:00:00.000Z',
  },
];

const PRESET_CHARACTERS: CharacterAsset[] = [
  {
    id: 'preset_char_lead_actor',
    name: 'Studio Reference Lead (Sample Preset)',
    notes:
      'Sample studio portrait provided for quick UI preview; upload your own portrait for personal projects.',
    isPreset: true,
    primaryImageUrl: '/src/assets/images/char_sample_actor_1795068456851.jpg',
    primaryImagePath: path.join(
      ROOT_DIR,
      'src/assets/images/char_sample_actor_1795068456851.jpg'
    ),
    additionalImageUrls: [],
    additionalImagePaths: [],
    profile: {
      facialStructure: 'Defined oval jawline, balanced cheekbone prominence',
      eyeShape: 'Almond-shaped dark eyes with steady horizontal brow line',
      noseShape: 'Straight narrow nasal bridge with proportionate tip',
      mouthShape: 'Medium balanced lips, neutral resting expression',
      hair: 'Dark wavy medium-length hair swept back',
      facialHair: 'Clean shaven with light natural stubble',
      skinAppearance: 'Warm fair-medium skin tone with natural texture',
      distinctiveFeatures: 'Soft directional studio key light profile',
      clothingDetails: 'Dark charcoal tailored wool jacket over black turtleneck',
      identitySummaryPrompt:
        'Adult actor with defined oval jawline, wavy dark swept-back hair, dark almond eyes, clean-shaven with subtle stubble, wearing dark charcoal wool jacket and black turtleneck.',
      analyzedByModel: 'sample-preset',
      analyzedAt: '2026-11-18T00:00:00.000Z',
    },
    createdAt: '2026-11-18T00:00:00.000Z',
  },
];

export function listProviders(): ProviderConfigRecord[] {
  const defaults = buildDefaultProviders();
  const saved = readJson<ProviderConfigRecord[] | null>(PROVIDERS_FILE, null);
  let list = saved ? [...saved] : [...defaults];
  if (saved === null) {
    writeJsonAtomic(PROVIDERS_FILE, list);
  } else {
    // Ensure any newly introduced built-in providers (such as local_gpu_worker) are merged cleanly
    const existingIds = new Set(list.map((p) => p.id));
    let added = false;
    for (const def of defaults) {
      if (!existingIds.has(def.id)) {
        list.unshift(def);
        added = true;
      }
    }
    if (added) {
      writeJsonAtomic(PROVIDERS_FILE, list);
    }
  }
  const defaultsByType = new Map(defaults.map((d) => [d.providerType, d]));

  // Always reflect live env secrets AND sync canonical built-in capability flags & new models
  return list.map((p) => {
    const def = defaultsByType.get(p.providerType);
    const existingModelIds = new Set(p.models.map((m) => m.id));
    const missingDefModels = def
      ? def.models.filter((dm) => !existingModelIds.has(dm.id))
      : [];
    const combinedModels = [...missingDefModels, ...p.models];

    const syncedModels = combinedModels.map((m) => {
      const defModel = def?.models.find((dm) => dm.id === m.id);
      if (!defModel) {
        return {
          ...m,
          supportsCharacterReplacement:
            m.supportsCharacterReplacement ?? (m.supportsVideoToVideo && m.supportsCharacterReference),
          supportsMultiCharacter: m.supportsMultiCharacter ?? false,
          replacementWorkflow:
            m.replacementWorkflow ??
            (m.taskType === 'analysis'
              ? 'analysis_only'
              : m.supportsVideoToVideo
                ? 'v2v_single_ref'
                : 'i2v_only'),
        };
      }
      return {
        ...m,
        name: defModel.name,
        taskType: defModel.taskType,
        stageRoles: defModel.stageRoles,
        hardwareRequirement: defModel.hardwareRequirement,
        supportsImageToVideo: defModel.supportsImageToVideo,
        supportsVideoToVideo: defModel.supportsVideoToVideo,
        supportsImageEditing: defModel.supportsImageEditing,
        supportsCharacterReference: defModel.supportsCharacterReference,
        supportsCharacterReplacement: defModel.supportsCharacterReplacement,
        supportsFullBodyReplacement: defModel.supportsFullBodyReplacement,
        supportsFaceOnlyReplacement: defModel.supportsFaceOnlyReplacement,
        supportsMultiCharacter: defModel.supportsMultiCharacter,
        replacementWorkflow: defModel.replacementWorkflow,
        supportedAspectRatios: defModel.supportedAspectRatios,
        freeTierNotes: defModel.freeTierNotes,
        estimatedCostPerFrameUsd: defModel.estimatedCostPerFrameUsd,
      };
    });

    const resolvedEndpointUrl =
      p.endpointUrl ?? (def?.endpointUrl || process.env[p.envVarName]?.trim() || null);
    const updatedProvider: ProviderConfigRecord = {
      ...p,
      endpointUrl: resolvedEndpointUrl,
      hardwareRequirement: p.hardwareRequirement ?? def?.hardwareRequirement,
      apiSupportStatus: def?.apiSupportStatus ?? p.apiSupportStatus,
      models: syncedModels,
    };

    const configured = isProviderConfigured(updatedProvider);
    let connectionStatus = updatedProvider.connectionStatus;
    if (!updatedProvider.enabled) connectionStatus = 'disabled';
    else if (!configured) connectionStatus = 'unconfigured';
    else if (connectionStatus === 'unconfigured' || connectionStatus === 'disabled') {
      connectionStatus = 'connected';
    }
    return { ...updatedProvider, connectionStatus };
  });
}

export function getProvider(id: string): ProviderConfigRecord | null {
  return listProviders().find((p) => p.id === id) ?? null;
}

export function saveProvider(provider: ProviderConfigRecord): ProviderConfigRecord {
  const providers = listProviders();
  const idx = providers.findIndex((p) => p.id === provider.id);
  if (idx >= 0) providers[idx] = provider;
  else providers.push(provider);
  writeJsonAtomic(PROVIDERS_FILE, providers);
  return provider;
}

export function deleteProvider(id: string): boolean {
  const providers = listProviders();
  const target = providers.find((p) => p.id === id);
  if (!target || target.isBuiltin) return false;
  const filtered = providers.filter((p) => p.id !== id);
  writeJsonAtomic(PROVIDERS_FILE, filtered);
  return true;
}

export function listProjects(): ProjectRecord[] {
  return readJson<ProjectRecord[]>(PROJECTS_FILE, []).sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );
}

export function getProject(id: string): ProjectRecord | null {
  const projects = readJson<ProjectRecord[]>(PROJECTS_FILE, []);
  return projects.find((p) => p.id === id) ?? null;
}

export function saveProject(project: ProjectRecord): ProjectRecord {
  const projects = readJson<ProjectRecord[]>(PROJECTS_FILE, []);
  const idx = projects.findIndex((p) => p.id === project.id);
  project.updatedAt = new Date().toISOString();
  if (idx >= 0) {
    projects[idx] = project;
  } else {
    projects.unshift(project);
  }
  writeJsonAtomic(PROJECTS_FILE, projects);
  return project;
}

export function deleteProject(id: string): boolean {
  const projects = readJson<ProjectRecord[]>(PROJECTS_FILE, []);
  const target = projects.find((p) => p.id === id);
  if (!target) return false;
  const filtered = projects.filter((p) => p.id !== id);
  writeJsonAtomic(PROJECTS_FILE, filtered);

  const projectDir = path.join(PROJECTS_DIR, id);
  if (fs.existsSync(projectDir)) {
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
  if (target.sourceVideo?.filePath && fs.existsSync(target.sourceVideo.filePath)) {
    const stillUsed = filtered.some(
      (p) => p.sourceVideo?.filePath === target.sourceVideo.filePath
    );
    if (!stillUsed) {
      fs.rmSync(target.sourceVideo.filePath, { force: true });
      const thumbPath = path.join(
        UPLOADS_DIR,
        path.basename(target.sourceVideo.thumbnailUrl)
      );
      if (fs.existsSync(thumbPath)) fs.rmSync(thumbPath, { force: true });
    }
  }
  return true;
}

export function recoverOrphanedActiveJobs(): number {
  const projects = readJson<ProjectRecord[]>(PROJECTS_FILE, []);
  let recovered = 0;
  for (const p of projects) {
    if (p.status === 'queued' || p.status === 'analyzing' || p.status === 'processing') {
      p.status = 'failed';
      p.currentStage = 'failed';
      p.errorMessage =
        'Server restarted while job was active. Saved progress and any provider job IDs were preserved; click Retry to continue safely.';
      p.statusMessage = p.errorMessage;
      p.diagnosticDetail = {
        stage: p.currentStage,
        provider: p.selectedModels?.videoProvider || 'Pipeline Worker',
        model: p.selectedModels?.videoModel,
        httpStatus: null,
        providerJobId:
          p.segments.find((s) => s.providerJobId)?.providerJobId ?? null,
        userMessage: p.errorMessage,
        technicalError: 'Process worker restarted while background job was active.',
        timestamp: new Date().toISOString(),
      };
      p.history.push({
        timestamp: new Date().toISOString(),
        stage: 'failed',
        message: p.errorMessage,
        level: 'warning',
      });
      recovered++;
    }
  }
  if (recovered > 0) {
    writeJsonAtomic(PROJECTS_FILE, projects);
  }
  return recovered;
}

export function listCharacters(): CharacterAsset[] {
  const saved = readJson<CharacterAsset[] | null>(CHARACTERS_FILE, null);
  if (saved === null) {
    writeJsonAtomic(CHARACTERS_FILE, PRESET_CHARACTERS);
    return PRESET_CHARACTERS;
  }
  return saved;
}

export function getCharacter(id: string): CharacterAsset | null {
  return listCharacters().find((c) => c.id === id) ?? null;
}

export function saveCharacter(char: CharacterAsset): CharacterAsset {
  const chars = listCharacters();
  const idx = chars.findIndex((c) => c.id === char.id);
  if (idx >= 0) chars[idx] = char;
  else chars.unshift(char);
  writeJsonAtomic(CHARACTERS_FILE, chars);
  return char;
}

export function deleteCharacter(id: string): boolean {
  const chars = listCharacters();
  const target = chars.find((c) => c.id === id);
  if (!target) return false;
  const filtered = chars.filter((c) => c.id !== id);
  writeJsonAtomic(CHARACTERS_FILE, filtered);
  if (!target.isPreset) {
    for (const p of [target.primaryImagePath, ...target.additionalImagePaths]) {
      if (p && fs.existsSync(p)) fs.rmSync(p, { force: true });
    }
  }
  return true;
}

export function listEnvironments(): EnvironmentAsset[] {
  const saved = readJson<EnvironmentAsset[] | null>(ENVIRONMENTS_FILE, null);
  if (saved === null) {
    writeJsonAtomic(ENVIRONMENTS_FILE, PRESET_ENVIRONMENTS);
    return PRESET_ENVIRONMENTS;
  }
  return saved;
}

export function getEnvironment(id: string): EnvironmentAsset | null {
  return listEnvironments().find((e) => e.id === id) ?? null;
}

export function saveEnvironment(env: EnvironmentAsset): EnvironmentAsset {
  const envs = listEnvironments();
  const idx = envs.findIndex((e) => e.id === env.id);
  if (idx >= 0) envs[idx] = env;
  else envs.unshift(env);
  writeJsonAtomic(ENVIRONMENTS_FILE, envs);
  return env;
}

export function deleteEnvironment(id: string): boolean {
  const envs = listEnvironments();
  const target = envs.find((e) => e.id === id);
  if (!target) return false;
  const filtered = envs.filter((e) => e.id !== id);
  writeJsonAtomic(ENVIRONMENTS_FILE, filtered);
  if (!target.isPreset && target.imagePath && fs.existsSync(target.imagePath)) {
    fs.rmSync(target.imagePath, { force: true });
  }
  return true;
}

export function listUsageLedger(): UsageLedgerEntry[] {
  return readJson<UsageLedgerEntry[]>(USAGE_FILE, []).sort(
    (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
  );
}

export function recordUsageEntry(entry: UsageLedgerEntry): void {
  const entries = readJson<UsageLedgerEntry[]>(USAGE_FILE, []);
  entries.unshift(entry);
  writeJsonAtomic(USAGE_FILE, entries.slice(0, 1000));
}

export function removeUsageForProject(projectId: string): void {
  const entries = readJson<UsageLedgerEntry[]>(USAGE_FILE, []);
  const filtered = entries.filter((e) => e.projectId !== projectId);
  if (filtered.length !== entries.length) {
    writeJsonAtomic(USAGE_FILE, filtered);
  }
}
