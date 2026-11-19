import crypto from 'crypto';
import dotenv from 'dotenv';
import express from 'express';
import fs from 'fs';
import multer from 'multer';
import path from 'path';
import { extractThumbnail, probeVideo } from './server/ffmpeg.ts';
import {
  analyzeCharacterReference,
  checkGeminiConnection,
} from './server/gemini.ts';
import {
  cancelProjectJob,
  jobEvents,
  retrySingleSegment,
  runProjectAnalysis,
  runProjectPipeline,
} from './server/pipeline.ts';
import { runProviderHealthCheck } from './server/providers/adapters.ts';
import {
  buildQuotaDashboardSummary,
  inspectTaskCapabilities,
  isCharacterReplacementMode,
} from './server/providers/orchestrator.ts';
import type {
  ProviderConfigRecord,
  ProviderId,
} from './server/providers/types.ts';
import { runComprehensiveSelfTests } from './server/selftest.ts';
import {
  buildDefaultProviders,
  CHARACTERS_DIR,
  CHUNKS_DIR,
  deleteCharacter,
  deleteEnvironment,
  deleteProject,
  deleteProvider,
  ENVIRONMENTS_DIR,
  getCharacter,
  getProject,
  getProvider,
  isEnvSecretSet,
  isProviderConfigured,
  listCharacters,
  listEnvironments,
  listProjects,
  listProviders,
  recoverOrphanedActiveJobs,
  saveCharacter,
  saveEnvironment,
  saveProject,
  saveProvider,
  STORAGE_DIR,
  UPLOADS_DIR,
} from './server/store.ts';
import type {
  AudioMode,
  BackgroundMode,
  BillingMode,
  CharacterAsset,
  EnvironmentAsset,
  FreeModeFallbackPolicy,
  LightingMode,
  OutputAspectRatio,
  OutputResolution,
  ProjectRecord,
  QualityTier,
  ReplacementScope,
  TransformationMode,
  VideoMetadata,
} from './server/types.ts';

dotenv.config();

const PORT = Number(process.env.PORT || 3000);
const app = express();

app.use(express.json({ limit: '15mb' }));

// Serve uploaded and generated media files with byte-range support
app.use('/storage', express.static(STORAGE_DIR));
app.use(
  '/src/assets',
  express.static(path.join(process.cwd(), 'src/assets'))
);

const ALLOWED_VIDEO_EXTS = new Set(['.mp4', '.mov', '.webm']);
const ALLOWED_VIDEO_MIMES = new Set([
  'video/mp4',
  'video/quicktime',
  'video/webm',
  'application/octet-stream',
  '',
]);
const ALLOWED_IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp']);
const MAX_VIDEO_DURATION_SEC = 60.5;

const videoUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase() || '.mp4';
      cb(null, `vid_${Date.now()}_${crypto.randomUUID().slice(0, 8)}${ext}`);
    },
  }),
  limits: {
    fileSize: 500 * 1024 * 1024,
  },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const mime = (file.mimetype || '').toLowerCase();
    if (!ALLOWED_VIDEO_EXTS.has(ext)) {
      cb(
        new Error('Upload failed: Unsupported video extension. Accepted formats: MP4, MOV, WEBM.')
      );
      return;
    }
    if (!ALLOWED_VIDEO_MIMES.has(mime) && !mime.startsWith('video/')) {
      cb(
        new Error(`Upload failed: Invalid MIME type "${file.mimetype}". Expected a valid video file.`)
      );
      return;
    }
    cb(null, true);
  },
});

const imageUpload = multer({
  storage: multer.diskStorage({
    destination: (req, _file, cb) => {
      const dest = req.path.includes('environments')
        ? ENVIRONMENTS_DIR
        : CHARACTERS_DIR;
      cb(null, dest);
    },
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
      cb(null, `img_${Date.now()}_${crypto.randomUUID().slice(0, 8)}${ext}`);
    },
  }),
  limits: {
    fileSize: 25 * 1024 * 1024,
  },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!ALLOWED_IMAGE_EXTS.has(ext)) {
      cb(
        new Error(
          'Unsupported image format. Accepted formats: JPG, JPEG, PNG, WEBP.'
        )
      );
      return;
    }
    cb(null, true);
  },
});

async function finalizeAndValidateVideoFile(params: {
  filePath: string;
  fileName: string;
  originalName: string;
  mimeType?: string;
}): Promise<VideoMetadata> {
  const probed = await probeVideo(params.filePath);

  if (probed.durationSec > MAX_VIDEO_DURATION_SEC) {
    throw new Error(
      `Upload failed: Video duration (${probed.durationSec.toFixed(1)}s) exceeds the 60-second maximum limit. Trim the clip to 60s or less and retry.`
    );
  }

  const thumbName = `${path.parse(params.fileName).name}_thumb.jpg`;
  const thumbPath = path.join(UPLOADS_DIR, thumbName);
  await extractThumbnail(
    params.filePath,
    thumbPath,
    Math.min(1, probed.durationSec * 0.25)
  );

  return {
    fileName: params.fileName,
    originalName: params.originalName,
    filePath: params.filePath,
    url: `/storage/uploads/${params.fileName}`,
    thumbnailUrl: `/storage/uploads/${thumbName}`,
    durationSec: probed.durationSec,
    width: probed.width,
    height: probed.height,
    fps: probed.fps,
    codec: probed.codec,
    mimeType: params.mimeType || 'video/mp4',
    hasAudio: probed.hasAudio,
    fileSizeBytes: probed.fileSizeBytes,
    verifiedPlayable: probed.verifiedPlayable,
  };
}

// ---------------------------------------------------------------------------
// Health & API Settings Status (Never accepts or returns raw API keys)
// ---------------------------------------------------------------------------
app.get('/api/settings/status', async (_req, res) => {
  const configured = isEnvSecretSet('GEMINI_API_KEY');
  res.json({
    provider: 'Google Gemini API',
    configured,
    storageMode: 'Server-side AI Studio Secrets (GEMINI_API_KEY)',
    officialKeyPortalUrl: 'https://aistudio.google.com/app/apikey',
  });
});

app.post('/api/settings/test-connection', async (_req, res) => {
  const result = await checkGeminiConnection();
  res.json(result);
});

// ---------------------------------------------------------------------------
// Self-Test Diagnostic Suite (10 Real End-to-End Checks)
// ---------------------------------------------------------------------------
app.post('/api/diagnostics/self-test', async (_req, res) => {
  try {
    const report = await runComprehensiveSelfTests(`http://127.0.0.1:${PORT}`);
    res.json(report);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: `Self-test runner failed: ${msg}` });
  }
});

// ---------------------------------------------------------------------------
// Multi-Provider Management, Connection Checks & Quota Discovery
// ---------------------------------------------------------------------------
app.get('/api/providers', (_req, res) => {
  res.json(listProviders());
});

app.post('/api/providers', (req, res) => {
  const body = req.body as {
    providerType?: ProviderId;
    displayName?: string;
    envVarName?: string;
    dailyCreditsRemaining?: number | null;
    monthlyCreditsRemaining?: number | null;
    estimatedSecondsRemaining?: number | null;
    nextResetAt?: string | null;
    note?: string;
  };

  if (!body.providerType || !body.displayName?.trim()) {
    res.status(400).json({ error: 'Provider type and display name are required.' });
    return;
  }

  const template = buildDefaultProviders().find(
    (p) => p.providerType === body.providerType
  );
  if (!template) {
    res.status(400).json({ error: 'Unsupported provider adapter type.' });
    return;
  }

  const envVar = body.envVarName?.trim() || template.envVarName;
  const newProvider: ProviderConfigRecord = {
    ...template,
    id: `custom_${body.providerType}_${crypto.randomUUID().slice(0, 6)}`,
    displayName: body.displayName.trim(),
    isBuiltin: false,
    enabled: true,
    envVarName: envVar,
    connectionStatus: isEnvSecretSet(envVar) ? 'connected' : 'unconfigured',
    manualEstimate: {
      dailyCreditsRemaining: body.dailyCreditsRemaining ?? null,
      monthlyCreditsRemaining: body.monthlyCreditsRemaining ?? null,
      estimatedSecondsRemaining: body.estimatedSecondsRemaining ?? null,
      nextResetAt: body.nextResetAt ?? null,
      note: body.note?.trim() || 'Manual quota estimate configured by user.',
    },
  };

  saveProvider(newProvider);
  res.status(201).json(newProvider);
});

app.patch('/api/providers/:id', (req, res) => {
  const existing = getProvider(req.params.id);
  if (!existing) {
    res.status(404).json({ error: 'Provider not found.' });
    return;
  }

  const body = req.body as {
    enabled?: boolean;
    displayName?: string;
    endpointUrl?: string | null;
    manualEstimate?: Partial<ProviderConfigRecord['manualEstimate']>;
  };

  if (body.endpointUrl !== undefined) {
    if (existing.providerType !== 'local_gpu_worker') {
      res.status(400).json({
        error: 'Custom endpoint URL is only supported on the Open-Source Local GPU Worker adapter.',
      });
      return;
    }
    const trimmed = typeof body.endpointUrl === 'string' ? body.endpointUrl.trim() : '';
    if (trimmed) {
      if (!/^https?:\/\/[a-zA-Z0-9.-]+(?::\d+)?(?:\/.*)?$/i.test(trimmed)) {
        res.status(400).json({
          error: 'Invalid worker URL. Must start with http:// or https:// (e.g. http://127.0.0.1:8000).',
        });
        return;
      }
      existing.endpointUrl = trimmed.replace(/\/+$/, '');
      existing.lastError = null;
    } else {
      existing.endpointUrl = null;
      existing.lastError = null;
    }
  }

  if (typeof body.enabled === 'boolean') {
    existing.enabled = body.enabled;
  }

  existing.connectionStatus = !existing.enabled
    ? 'disabled'
    : isProviderConfigured(existing)
      ? 'connected'
      : 'unconfigured';

  if (typeof body.displayName === 'string' && body.displayName.trim()) {
    existing.displayName = body.displayName.trim();
  }
  if (body.manualEstimate) {
    existing.manualEstimate = {
      ...existing.manualEstimate,
      ...body.manualEstimate,
    };
  }

  saveProvider(existing);
  res.json(existing);
});

app.delete('/api/providers/:id', (req, res) => {
  const ok = deleteProvider(req.params.id);
  if (!ok) {
    res
      .status(400)
      .json({ error: 'Built-in provider adapters can be disabled, not removed.' });
    return;
  }
  res.json({ deleted: true });
});

app.post('/api/providers/:id/test', async (req, res) => {
  const existing = getProvider(req.params.id);
  if (!existing) {
    res.status(404).json({ error: 'Provider not found.' });
    return;
  }
  const updated = await runProviderHealthCheck(existing);
  saveProvider(updated);
  res.json(updated);
});

app.get('/api/worker/setup', (_req, res) => {
  res.json({
    workerFiles: ['worker/gpu_worker.py', 'worker/requirements.txt', 'worker/README.md'],
    hardwareRequirement: '8–16 GB VRAM NVIDIA GPU (Local PC, RunPod, Vast.ai, or free Google Colab T4/L4)',
    cost: '$0 API fees',
    endpoints: ['GET /health', 'POST /segment', 'POST /edit-frame'],
    quickStartCommands: [
      'cd worker && pip install -r requirements.txt',
      'uvicorn gpu_worker:app --host 0.0.0.0 --port 8000',
    ],
  });
});

app.get('/api/providers/select-preview', (req, res) => {
  const billingMode =
    req.query.billingMode === 'paid' ? 'paid' : ('free' as BillingMode);
  const mode = (req.query.mode as TransformationMode) || 'cinematic_recreation_with_character';
  const resolution =
    req.query.resolution === '1080p' ? '1080p' : ('720p' as OutputResolution);
  const replacementScope: ReplacementScope =
    req.query.replacementScope === 'face_replacement'
      ? 'face_replacement'
      : 'full_character_replacement';
  const hasCharacterRef = req.query.hasCharacterRef !== 'false';
  const requiresMultiCharacter = req.query.requiresMultiCharacter === 'true';

  const capReport = inspectTaskCapabilities({
    billingMode,
    mode,
    resolution,
    hasCharacterRef,
    replacementScope,
    requiresMultiCharacter,
  });

  const combinedCandidates = [...capReport.stage4Candidates, ...capReport.activeCandidates];

  res.json({
    billingMode,
    capabilities: {
      isCharacterReplacementTask: capReport.isCharacterReplacementTask,
      billingMode: capReport.billingMode,
      activeWorkflow: capReport.activeWorkflow,
      nativeV2vAvailable: capReport.nativeV2vAvailable,
      multiStageAvailable: capReport.multiStageAvailable,
      canRunPartialStages1To3: capReport.canRunPartialStages1To3,
      stage4AdapterName: capReport.stage4AdapterName,
      stage4ModelId: capReport.stage4ModelId,
      stage4HardwareNote: capReport.stage4HardwareNote,
      stage4CostEstimateNote: capReport.stage4CostEstimateNote,
      hasAnalysisConnected: capReport.hasAnalysisConnected,
      hasVideoInputSupport: capReport.hasVideoInputSupport,
      hasCharacterReferenceSupport: capReport.hasCharacterReferenceSupport,
      hasCharacterReplacementSupport: capReport.hasCharacterReplacementSupport,
      hasMultiCharacterSupport: capReport.hasMultiCharacterSupport,
      freeReplacementCandidatesCount: capReport.freeReplacementCandidatesCount,
      paidReplacementCandidatesCount: capReport.paidReplacementCandidatesCount,
      freeStage4CandidatesCount: capReport.freeStage4CandidatesCount,
      paidStage4CandidatesCount: capReport.paidStage4CandidatesCount,
      pipelineCapabilities: capReport.pipelineCapabilities,
      missingStage4SetupOptions: capReport.missingStage4SetupOptions,
      blockingReason: capReport.blockingReason,
    },
    candidates: combinedCandidates.map((r) => ({
      providerId: r.provider.id,
      providerName: r.provider.displayName,
      modelId: r.model.id,
      modelName: r.model.name,
      taskType: r.model.taskType,
      freeTierEligible: r.model.freeTierEligible,
      score: r.compositeScore,
      reason: r.reason,
      hardwareRequirement: r.model.hardwareRequirement ?? null,
      maxDurationSec: r.model.maxDurationSec,
      supportedResolutions: r.model.supportedResolutions,
      supportsVideoToVideo: r.model.supportsVideoToVideo,
      supportsImageEditing: Boolean(r.model.supportsImageEditing),
      supportsCharacterReplacement: Boolean(
        r.model.supportsCharacterReplacement ??
          (r.model.supportsVideoToVideo && r.model.supportsCharacterReference)
      ),
      supportsMultiCharacter: Boolean(r.model.supportsMultiCharacter),
    })),
  });
});

app.get('/api/quota-dashboard', (_req, res) => {
  res.json(buildQuotaDashboardSummary());
});

// ---------------------------------------------------------------------------
// AI Model Catalog
// ---------------------------------------------------------------------------
app.get('/api/models', (_req, res) => {
  res.json([
    {
      id: 'gemini-4-hydrogen',
      name: 'Gemini 4 Hydrogen',
      provider: 'Google Gemini API',
      category: 'Stages 2–3 & 5: Detection, Frame Tracking & Visual QA',
      billingTier: 'free_eligible',
      capabilities: [
        'Character identity profiling from portraits',
        'Multi-frame bounding box + pose tracking across video frames',
        'Multilingual director blueprint (EN / FA / Global)',
        '7-Point replacement & temporal consistency Quality Control',
      ],
      limits: 'Subject to free-tier RPM/RPD quota (analysis & QA only)',
      status: 'active',
    },
    {
      id: 'flux-controlnet-ipadapter',
      name: 'ControlNet + IP-Adapter + InsightFace (Worker)',
      provider: 'Open-Source Local / External GPU Worker',
      category: 'Stage 4: Full-Body & Multi-Character Frame Replacement',
      billingTier: 'free_eligible',
      hardwareRequirement: '12–16 GB VRAM NVIDIA GPU (Local PC or Free Colab T4/L4)',
      capabilities: [
        'Mask-conditioned full-body & wardrobe character replacement',
        'Multi-character identity assignment using reference portraits',
        'Previous-frame temporal anchor conditioning ($0 API fees)',
      ],
      limits: 'Runs on your own GPU or Colab tunnel via worker/gpu_worker.py',
      estimatedCostPerFrameUsd: 0,
      status: 'active',
    },
    {
      id: 'insightface-inswapper-128',
      name: 'InsightFace InSwapper 128 + CodeFormer (Worker)',
      provider: 'Open-Source Local / External GPU Worker',
      category: 'Stage 4: Fast Face & Head Replacement',
      billingTier: 'free_eligible',
      hardwareRequirement: '8 GB VRAM NVIDIA GPU (fast per-frame swap)',
      capabilities: [
        'Identity-faithful face & head swap inside tracked faceBox',
        'Preserves original clothes, body posture, and lighting',
      ],
      limits: 'Face-only replacement ($0 API cost) via worker/gpu_worker.py',
      estimatedCostPerFrameUsd: 0,
      status: 'active',
    },
    {
      id: 'Qwen/Qwen-Image-Edit',
      name: 'Qwen Image Edit (HF Inference Router)',
      provider: 'Hugging Face Inference Providers',
      category: 'Stage 4: Cloud Reference-Conditioned Frame Editor',
      billingTier: 'free_eligible',
      hardwareRequirement: 'Cloud serverless (no local GPU required)',
      capabilities: [
        'Reference-conditioned mask/pose-guided image editing',
        'Supports full-body & face replacement modes',
      ],
      limits: 'Uses monthly HF Inference free credits; rate-limited on heavy clips',
      estimatedCostPerFrameUsd: 0,
      status: 'active',
    },
    {
      id: 'gemini-3.1-flash-lite-image',
      name: 'Gemini 3.1 Flash Image',
      provider: 'Google Gemini API',
      category: 'Stage 4: Cloud Multimodal Frame Editor',
      billingTier: 'paid_required',
      hardwareRequirement: 'Cloud API (no local GPU required)',
      capabilities: [
        'Reference portrait + mask + previous-frame temporal conditioning',
        'Supports multi-character replacement & background preservation',
      ],
      limits: 'Requires billing-enabled GEMINI_API_KEY (~$0.02/frame)',
      estimatedCostPerFrameUsd: 0.02,
      status: 'active',
    },
    {
      id: 'gemini-nano-banana-2.1',
      name: 'Gemini Nano Banana 2.1 (Pro Image Editor)',
      provider: 'Google Gemini API',
      category: 'Stage 4: High-Fidelity Facial Consistency Frame Editor',
      billingTier: 'paid_required',
      hardwareRequirement: 'Cloud API (no local GPU required)',
      capabilities: [
        'High-precision facial identity preservation across challenging angles',
        'Full-body and multi-character frame editing with mask adherence',
      ],
      limits: 'Requires billing-enabled GEMINI_API_KEY (~$0.04/frame)',
      estimatedCostPerFrameUsd: 0.04,
      status: 'active',
    },
    {
      id: 'fal-ai/flux-pro/kontext',
      name: 'FLUX.1 Kontext Pro',
      provider: 'fal.ai Platform API',
      category: 'Stage 4: Cloud Character-Preserving Frame Editor',
      billingTier: 'paid_required',
      hardwareRequirement: 'Cloud API (no local GPU required)',
      capabilities: [
        'Consistent character & scene editing across video frames',
      ],
      limits: 'Requires FAL_KEY balance (~$0.04/frame)',
      estimatedCostPerFrameUsd: 0.04,
      status: 'active',
    },
    {
      id: 'gemini-omni-1.2-flash',
      name: 'Gemini Omni 1.2 Flash',
      provider: 'Google Gemini API',
      category: 'Native Video-to-Video Character Replacement',
      billingTier: 'paid_required',
      capabilities: [
        'Direct Video-to-Video motion & timing preservation (v2v_multi_ref)',
        'Multi-character reference identity transfer (up to 6 reference images)',
        '3s–15s clip generation at 720p HD / 1080p Full HD',
      ],
      limits: 'Max 15s per generation segment; requires billing-enabled GEMINI_API_KEY',
      estimatedCostPerSecUsd: 0.15,
      status: 'active',
    },
    {
      id: 'Wan-AI/Wan2.2-TI2V-5B',
      name: 'Wan 2.2 TI2V 5B (HF Inference Router)',
      provider: 'Hugging Face Inference Providers',
      category: 'Open-Weight Image-to-Video (Non-Replacement Only)',
      billingTier: 'free_eligible',
      capabilities: [
        'Image-to-video synthesis from a single keyframe',
        'Not used for V2V character replacement (no motion conditioning)',
      ],
      limits: 'Max 5s per clip, 480p/720p',
      estimatedCostPerSecUsd: 0,
      status: 'active',
    },
    {
      id: 'gemini-3.5-transcribe',
      name: 'Gemini 3.5 Transcribe',
      provider: 'Google Gemini API',
      category: 'Audio & Dialogue Transcription',
      billingTier: 'free_eligible',
      capabilities: [
        'Dialogue extraction from source footage',
        'Ambient sound identification',
      ],
      limits: 'Standard audio input limits',
      status: 'active',
    },
    {
      id: 'lyria-3-clip-preview',
      name: 'Lyria 3 Clip',
      provider: 'Google Gemini API',
      category: 'Cinematic Soundtrack Generation',
      billingTier: 'paid_required',
      capabilities: [
        'Custom 30s cinematic background score',
        'Mood-synced music generation',
      ],
      limits: 'Up to 30s clips; requires billing-enabled API key',
      estimatedCostPerClipUsd: 0.08,
      status: 'active',
    },
  ]);
});

// ---------------------------------------------------------------------------
// Video Upload (Standard Multipart + Chunked Proxy-Safe Transfer)
// ---------------------------------------------------------------------------
app.post('/api/uploads/video', (req, res) => {
  videoUpload.single('video')(req, res, async (err) => {
    if (err) {
      res.status(400).json({ error: err.message });
      return;
    }
    if (!req.file) {
      res.status(400).json({ error: 'Upload failed: No video file received by server.' });
      return;
    }

    try {
      const metadata = await finalizeAndValidateVideoFile({
        filePath: req.file.path,
        fileName: req.file.filename,
        originalName: req.file.originalname,
        mimeType: req.file.mimetype,
      });
      res.json(metadata);
    } catch (probeErr) {
      if (fs.existsSync(req.file.path)) fs.rmSync(req.file.path, { force: true });
      const msg = probeErr instanceof Error ? probeErr.message : String(probeErr);
      res.status(400).json({ error: msg });
    }
  });
});

interface ChunkUploadSession {
  uploadId: string;
  originalName: string;
  mimeType: string;
  totalSizeBytes: number;
  totalChunks: number;
  receivedChunks: Set<number>;
  tempDir: string;
  ext: string;
}
const chunkSessions = new Map<string, ChunkUploadSession>();

app.post('/api/uploads/video/init', (req, res) => {
  const body = req.body as {
    originalName?: string;
    mimeType?: string;
    totalSizeBytes?: number;
    totalChunks?: number;
  };
  const originalName = String(body.originalName || 'video.mp4');
  const ext = path.extname(originalName).toLowerCase() || '.mp4';
  const mime = String(body.mimeType || 'video/mp4').toLowerCase();

  if (!ALLOWED_VIDEO_EXTS.has(ext)) {
    res.status(400).json({
      error: 'Upload failed: Unsupported video format. Accepted formats: MP4, MOV, WEBM.',
    });
    return;
  }
  if (!ALLOWED_VIDEO_MIMES.has(mime) && !mime.startsWith('video/')) {
    res.status(400).json({
      error: `Upload failed: Invalid MIME type "${mime}". Expected a valid video file.`,
    });
    return;
  }
  const totalSize = Number(body.totalSizeBytes || 0);
  if (totalSize <= 0 || totalSize > 500 * 1024 * 1024) {
    res.status(400).json({
      error: 'Upload failed: Video size must be between 1 byte and 500 MB.',
    });
    return;
  }

  const uploadId = `chk_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
  const tempDir = path.join(CHUNKS_DIR, uploadId);
  fs.mkdirSync(tempDir, { recursive: true });

  chunkSessions.set(uploadId, {
    uploadId,
    originalName,
    mimeType: mime || 'video/mp4',
    totalSizeBytes: totalSize,
    totalChunks: Number(body.totalChunks || 1),
    receivedChunks: new Set<number>(),
    tempDir,
    ext,
  });

  res.json({ uploadId });
});

app.post(
  '/api/uploads/video/chunk',
  express.raw({ type: 'application/octet-stream', limit: '8mb' }),
  (req, res) => {
    const uploadId = String(req.query.uploadId || '');
    const index = Number(req.query.index);
    const session = chunkSessions.get(uploadId);

    if (!session) {
      res.status(404).json({ error: 'Upload session not found or expired.' });
      return;
    }
    if (!Number.isInteger(index) || index < 0 || index >= session.totalChunks) {
      res.status(400).json({ error: 'Invalid chunk index.' });
      return;
    }
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      res.status(400).json({ error: 'Empty chunk payload.' });
      return;
    }

    const chunkPath = path.join(session.tempDir, `chunk_${index}.bin`);
    fs.writeFileSync(chunkPath, req.body);
    session.receivedChunks.add(index);

    res.json({
      received: index,
      totalReceived: session.receivedChunks.size,
      totalChunks: session.totalChunks,
    });
  }
);

app.post('/api/uploads/video/complete', async (req, res) => {
  const uploadId = String(req.body?.uploadId || '');
  const session = chunkSessions.get(uploadId);
  if (!session) {
    res.status(404).json({ error: 'Upload session not found or already finalized.' });
    return;
  }

  if (session.receivedChunks.size < session.totalChunks) {
    res.status(400).json({
      error: `Upload incomplete: received ${session.receivedChunks.size} of ${session.totalChunks} chunks.`,
    });
    return;
  }

  const finalFileName = `vid_${Date.now()}_${crypto.randomUUID().slice(0, 8)}${session.ext}`;
  const finalPath = path.join(UPLOADS_DIR, finalFileName);

  try {
    const writeStream = fs.createWriteStream(finalPath);
    for (let i = 0; i < session.totalChunks; i++) {
      const partPath = path.join(session.tempDir, `chunk_${i}.bin`);
      const partBuf = fs.readFileSync(partPath);
      writeStream.write(partBuf);
    }
    await new Promise<void>((resolve, reject) => {
      writeStream.on('finish', resolve);
      writeStream.on('error', reject);
      writeStream.end();
    });

    const metadata = await finalizeAndValidateVideoFile({
      filePath: finalPath,
      fileName: finalFileName,
      originalName: session.originalName,
      mimeType: session.mimeType,
    });
    res.json(metadata);
  } catch (err) {
    if (fs.existsSync(finalPath)) fs.rmSync(finalPath, { force: true });
    const msg = err instanceof Error ? err.message : String(err);
    res.status(400).json({ error: msg });
  } finally {
    chunkSessions.delete(uploadId);
    if (fs.existsSync(session.tempDir)) {
      fs.rmSync(session.tempDir, { recursive: true, force: true });
    }
  }
});

// ---------------------------------------------------------------------------
// Character Library
// ---------------------------------------------------------------------------
app.get('/api/characters', (_req, res) => {
  res.json(listCharacters());
});

app.post('/api/characters', (req, res) => {
  imageUpload.array('photos', 4)(req, res, async (err) => {
    if (err) {
      res.status(400).json({ error: err.message });
      return;
    }
    const files = (req.files as Express.Multer.File[]) ?? [];
    if (files.length === 0) {
      res.status(400).json({ error: 'Upload at least one character photograph.' });
      return;
    }

    const name = String(req.body?.name || 'Untitled Character').trim();
    const notes = String(req.body?.notes || '').trim();
    const id = `char_${crypto.randomUUID().slice(0, 10)}`;

    const primary = files[0];
    const extras = files.slice(1);

    let profile = null;
    let analysisWarning: string | null = null;
    try {
      profile = await analyzeCharacterReference(
        files.map((f) => f.path),
        name
      );
    } catch (aiErr) {
      analysisWarning = aiErr instanceof Error ? aiErr.message : String(aiErr);
    }

    const asset: CharacterAsset = {
      id,
      name,
      notes,
      isPreset: false,
      primaryImageUrl: `/storage/characters/${primary.filename}`,
      primaryImagePath: primary.path,
      additionalImageUrls: extras.map((f) => `/storage/characters/${f.filename}`),
      additionalImagePaths: extras.map((f) => f.path),
      profile,
      createdAt: new Date().toISOString(),
    };

    saveCharacter(asset);
    res.status(201).json({ character: asset, analysisWarning });
  });
});

app.post('/api/characters/:id/analyze', async (req, res) => {
  const char = getCharacter(req.params.id);
  if (!char) {
    res.status(404).json({ error: 'Character not found.' });
    return;
  }
  try {
    const profile = await analyzeCharacterReference(
      [char.primaryImagePath, ...char.additionalImagePaths],
      char.name
    );
    char.profile = profile;
    saveCharacter(char);
    res.json(char);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

app.delete('/api/characters/:id', (req, res) => {
  const ok = deleteCharacter(req.params.id);
  if (!ok) {
    res.status(404).json({ error: 'Character not found.' });
    return;
  }
  res.json({ deleted: true });
});

// ---------------------------------------------------------------------------
// Environment Reference Library
// ---------------------------------------------------------------------------
app.get('/api/environments', (_req, res) => {
  res.json(listEnvironments());
});

app.post('/api/environments', (req, res) => {
  imageUpload.single('image')(req, res, async (err) => {
    if (err) {
      res.status(400).json({ error: err.message });
      return;
    }
    if (!req.file) {
      res.status(400).json({ error: 'Upload an environment reference image.' });
      return;
    }

    const id = `env_${crypto.randomUUID().slice(0, 10)}`;
    const asset: EnvironmentAsset = {
      id,
      name: String(req.body?.name || 'Custom Environment').trim(),
      category: String(req.body?.category || 'Custom').trim(),
      description: String(
        req.body?.description || 'User uploaded environment reference.'
      ).trim(),
      isPreset: false,
      imageUrl: `/storage/environments/${req.file.filename}`,
      imagePath: req.file.path,
      createdAt: new Date().toISOString(),
    };

    saveEnvironment(asset);
    res.status(201).json(asset);
  });
});

app.delete('/api/environments/:id', (req, res) => {
  const ok = deleteEnvironment(req.params.id);
  if (!ok) {
    res.status(404).json({ error: 'Environment reference not found.' });
    return;
  }
  res.json({ deleted: true });
});

// ---------------------------------------------------------------------------
// Projects, Smart Job Queue, SSE Events & Downloads
// ---------------------------------------------------------------------------
app.get('/api/projects', (_req, res) => {
  res.json(listProjects());
});

app.get('/api/queue', (_req, res) => {
  const all = listProjects();
  res.json({
    pending: all.filter(
      (p) => p.status === 'queued' || p.status === 'awaiting_paid_confirmation'
    ),
    active: all.filter((p) => p.status === 'analyzing' || p.status === 'processing'),
    completed: all.filter((p) => p.status === 'completed'),
    failed: all.filter(
      (p) =>
        p.status === 'failed' ||
        p.status === 'partial_failure' ||
        p.status === 'cancelled'
    ),
  });
});

app.post('/api/queue/:id/cancel', (req, res) => {
  const updated = cancelProjectJob(req.params.id);
  if (!updated) {
    res.status(404).json({ error: 'Project not found.' });
    return;
  }
  res.json(updated);
});

app.get('/api/projects/:id', (req, res) => {
  const project = getProject(req.params.id);
  if (!project) {
    res.status(404).json({ error: 'Project not found.' });
    return;
  }
  res.json(project);
});

app.post('/api/projects', (req, res) => {
  const body = req.body as {
    name?: string;
    sourceVideo?: VideoMetadata;
    characterIds?: string[];
    environmentId?: string | null;
    environmentVideo?: VideoMetadata | null;
    instruction?: string;
    mode?: TransformationMode;
    replacementScope?: ReplacementScope;
    backgroundMode?: BackgroundMode;
    lightingMode?: LightingMode;
    qualityTier?: QualityTier;
    resolution?: OutputResolution;
    aspectRatio?: OutputAspectRatio;
    audioMode?: AudioMode;
    billingMode?: BillingMode;
    freeFallbackPolicy?: FreeModeFallbackPolicy;
    paidConfirmed?: boolean;
  };

  if (!body.sourceVideo || !body.sourceVideo.filePath) {
    res.status(400).json({ error: 'Source video is required.' });
    return;
  }

  if (!fs.existsSync(body.sourceVideo.filePath)) {
    res.status(400).json({
      error: 'Uploaded video file is missing from server storage. Please re-upload your video.',
    });
    return;
  }

  const billingMode: BillingMode = body.billingMode === 'paid' ? 'paid' : 'free';
  const qualityTier: QualityTier = body.qualityTier ?? 'economy';
  const resolution: OutputResolution = body.resolution ?? '720p';
  const aspectRatio: OutputAspectRatio = body.aspectRatio ?? 'original';
  const audioMode: AudioMode = body.audioMode ?? 'preserve_dialogue';
  const mode: TransformationMode =
    body.mode ?? 'cinematic_recreation_with_character';
  const replacementScope: ReplacementScope =
    body.replacementScope ?? 'full_character_replacement';
  const backgroundMode: BackgroundMode =
    body.backgroundMode ?? (body.environmentId ? 'use_env_ref' : 'preserve');
  const lightingMode: LightingMode = body.lightingMode ?? 'preserve';
  const freeFallbackPolicy: FreeModeFallbackPolicy =
    body.freeFallbackPolicy ?? 'ffmpeg_master';

  const id = `proj_${crypto.randomUUID().slice(0, 10)}`;
  const now = new Date().toISOString();

  const hasCharRef = (body.characterIds?.length ?? 0) > 0;
  const isReplacement = isCharacterReplacementMode(mode, hasCharRef);
  const capReport = inspectTaskCapabilities({
    billingMode,
    mode,
    resolution,
    hasCharacterRef: hasCharRef,
    replacementScope,
    requiresMultiCharacter: (body.characterIds?.length ?? 0) > 1,
  });
  const topCandidate = capReport.stage4Candidates[0] ?? capReport.activeCandidates[0];

  const project: ProjectRecord = {
    id,
    name:
      body.name?.trim() ||
      `Project ${path.parse(body.sourceVideo.originalName).name}`,
    createdAt: now,
    updatedAt: now,
    status: 'draft',
    currentStage: 'upload_completed',
    completedStages: ['uploading', 'upload_completed'],
    progressPercent: 5,
    progressIsEstimate: true,
    providerProgressAvailable: false,
    estimatedRemainingSec: null,
    statusMessage: 'Upload completed & validated. Ready to analyze or generate.',
    errorMessage: null,
    diagnosticDetail: null,

    sourceVideo: body.sourceVideo,
    characterIds: Array.isArray(body.characterIds) ? body.characterIds : [],
    environmentId: body.environmentId ?? null,
    environmentVideo: body.environmentVideo ?? null,
    instruction:
      body.instruction?.trim() ||
      'Recreate the scene cinematically while preserving character identity.',
    mode,
    replacementScope,
    backgroundMode,
    lightingMode,
    qualityTier,
    resolution,
    aspectRatio,
    audioMode,
    billingMode,
    freeFallbackPolicy,
    paidConfirmed: Boolean(body.paidConfirmed),

    detectedCharacters: [],
    characterMapping: {},
    blueprint: null,
    segments: [],
    pipelineState: null,
    qcSummary: null,

    outputVideoUrl: null,
    outputVideoPath: null,
    outputVideoMetadata: null,
    outputAudioUrl: null,
    outputAudioPath: null,

    selectedModels: {
      analysisModel: 'gemini-4-hydrogen',
      videoProvider: topCandidate
        ? topCandidate.provider.displayName
        : isReplacement
          ? 'Stages 1–3 Ready (Stage 4 Setup Needed)'
          : 'Local FFmpeg Engine',
      videoModel: topCandidate
        ? topCandidate.model.id
        : isReplacement
          ? 'multistage-partial-1-3'
          : 'ffmpeg-free-mastering',
      audioModel:
        billingMode === 'paid' &&
        (audioMode === 'generate_score' || audioMode === 'replace_ambient_sfx')
          ? 'lyria-3-clip-preview'
          : null,
      selectionReason:
        topCandidate?.reason ??
        (isReplacement ? capReport.blockingReason ?? undefined : undefined),
    },
    usageStats: {
      segmentsGenerated: 0,
      generatedSeconds: 0,
      estimatedCostUsd: 0,
      billingNote:
        billingMode === 'paid'
          ? 'Paid Mode selected — requires explicit confirmation before generation.'
          : 'Free-First Mode active — strictly prioritizes free-tier providers only.',
    },
    history: [
      {
        timestamp: now,
        stage: 'upload_completed',
        message: `Source video "${body.sourceVideo.originalName}" (${body.sourceVideo.durationSec}s, ${body.sourceVideo.width}x${body.sourceVideo.height}, ${body.sourceVideo.codec}) validated and stored.`,
        level: 'success',
      },
    ],
  };

  saveProject(project);
  res.status(201).json(project);
});

app.patch('/api/projects/:id', (req, res) => {
  const project = getProject(req.params.id);
  if (!project) {
    res.status(404).json({ error: 'Project not found.' });
    return;
  }

  const body = req.body as Partial<ProjectRecord>;
  if (typeof body.name === 'string' && body.name.trim()) {
    project.name = body.name.trim();
  }
  if (typeof body.instruction === 'string') {
    project.instruction = body.instruction.trim();
  }
  if (Array.isArray(body.characterIds)) {
    project.characterIds = body.characterIds;
  }
  if (body.environmentId !== undefined) {
    project.environmentId = body.environmentId;
  }
  if (body.mode) project.mode = body.mode;
  if (body.replacementScope) project.replacementScope = body.replacementScope;
  if (body.backgroundMode) project.backgroundMode = body.backgroundMode;
  if (body.lightingMode) project.lightingMode = body.lightingMode;
  if (body.qualityTier) project.qualityTier = body.qualityTier;
  if (body.resolution) project.resolution = body.resolution;
  if (body.aspectRatio) project.aspectRatio = body.aspectRatio;
  if (body.audioMode) project.audioMode = body.audioMode;
  if (body.freeFallbackPolicy) project.freeFallbackPolicy = body.freeFallbackPolicy;
  if (body.environmentVideo !== undefined) {
    project.environmentVideo = body.environmentVideo;
  }
  if (body.billingMode) {
    project.billingMode = body.billingMode;
  }
  if (typeof body.paidConfirmed === 'boolean') {
    project.paidConfirmed = body.paidConfirmed;
  }
  if (body.characterMapping) {
    project.characterMapping = body.characterMapping;
    project.detectedCharacters = project.detectedCharacters.map((dc) => ({
      ...dc,
      matchedCharacterId: Object.prototype.hasOwnProperty.call(
        body.characterMapping!,
        dc.id
      )
        ? (body.characterMapping![dc.id] ?? null)
        : dc.matchedCharacterId,
    }));
  }

  saveProject(project);
  res.json(project);
});

app.delete('/api/projects/:id', (req, res) => {
  const ok = deleteProject(req.params.id);
  if (!ok) {
    res.status(404).json({ error: 'Project not found.' });
    return;
  }
  res.json({ deleted: true });
});

app.post('/api/projects/:id/analyze', async (req, res) => {
  try {
    const project = await runProjectAnalysis(req.params.id);
    res.json(project);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const latest = getProject(req.params.id);
    res.status(500).json({
      error: msg,
      diagnosticDetail: latest?.diagnosticDetail ?? null,
    });
  }
});

app.post('/api/projects/:id/run', (req, res) => {
  const project = getProject(req.params.id);
  if (!project) {
    res.status(404).json({ error: 'Project not found.' });
    return;
  }

  let modified = false;
  if (req.body?.paidConfirmed === true) {
    project.paidConfirmed = true;
    modified = true;
  }
  if (req.body?.resetPipeline === true) {
    project.pipelineState = null;
    project.completedStages = ['uploading', 'upload_completed'];
    modified = true;
  }
  if (modified) saveProject(project);

  void runProjectPipeline(req.params.id);
  res.status(202).json({ started: true, projectId: req.params.id });
});

app.post('/api/projects/:id/segments/:segmentIndex/retry', async (req, res) => {
  const idx = Number(req.params.segmentIndex);
  if (!Number.isInteger(idx)) {
    res.status(400).json({ error: 'Invalid segment index.' });
    return;
  }
  try {
    await retrySingleSegment(req.params.id, idx);
    res.status(202).json({ retrying: true, segmentIndex: idx });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(400).json({ error: msg });
  }
});

app.get('/api/projects/:id/events', (req, res) => {
  const project = getProject(req.params.id);
  if (!project) {
    res.status(404).json({ error: 'Project not found.' });
    return;
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  res.write(`data: ${JSON.stringify(project)}\n\n`);

  const heartbeat = setInterval(() => {
    res.write(': keepalive\n\n');
  }, 15000);

  const listener = (updated: ProjectRecord) => {
    res.write(`data: ${JSON.stringify(updated)}\n\n`);
  };
  jobEvents.on(`project:${req.params.id}`, listener);

  req.on('close', () => {
    clearInterval(heartbeat);
    jobEvents.off(`project:${req.params.id}`, listener);
  });
});

app.head('/api/projects/:id/download/video', (req, res) => {
  const project = getProject(req.params.id);
  if (
    !project ||
    !project.outputVideoPath ||
    !fs.existsSync(project.outputVideoPath) ||
    fs.statSync(project.outputVideoPath).size < 1024
  ) {
    res.status(404).end();
    return;
  }
  const size = fs.statSync(project.outputVideoPath).size;
  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Content-Length', String(size));
  res.status(200).end();
});

app.get('/api/projects/:id/download/video', (req, res) => {
  const project = getProject(req.params.id);
  if (
    !project ||
    !project.outputVideoPath ||
    !fs.existsSync(project.outputVideoPath)
  ) {
    res.status(404).json({
      error: 'Download failed: Generated MP4 file is missing on server storage.',
    });
    return;
  }
  const size = fs.statSync(project.outputVideoPath).size;
  if (size < 1024) {
    res.status(500).json({
      error: 'Download failed: Generated MP4 file is empty or corrupted.',
    });
    return;
  }
  const safeName = project.name.replace(/[^a-zA-Z0-9_-]+/g, '_');
  res.download(
    project.outputVideoPath,
    `${safeName}_${project.resolution}.mp4`
  );
});

app.get('/api/projects/:id/download/audio', (req, res) => {
  const project = getProject(req.params.id);
  if (
    !project ||
    !project.outputAudioPath ||
    !fs.existsSync(project.outputAudioPath)
  ) {
    res.status(404).json({ error: 'Audio track is not available for this project.' });
    return;
  }
  const safeName = project.name.replace(/[^a-zA-Z0-9_-]+/g, '_');
  res.download(project.outputAudioPath, `${safeName}_audio.mp3`);
});

// ---------------------------------------------------------------------------
// Legacy Usage endpoint (aliased cleanly to Quota Dashboard summary)
// ---------------------------------------------------------------------------
app.get('/api/usage', (_req, res) => {
  res.json(buildQuotaDashboardSummary());
});

// Global API JSON error handler so Express never emits unreadable HTML errors on /api/*
app.use('/api', (err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  res.status(500).json({ error: err?.message || 'Internal server error.' });
});

// ---------------------------------------------------------------------------
// Vite Dev Middleware or Static Production Bundle
// ---------------------------------------------------------------------------
async function startServer() {
  const recoveredCount = recoverOrphanedActiveJobs();
  if (recoveredCount > 0) {
    console.log(`Recovered ${recoveredCount} interrupted background job(s) cleanly.`);
  }

  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.join(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`Cinematic AI Studio server running on http://0.0.0.0:${PORT}`);
  });
  server.requestTimeout = 10 * 60 * 1000;
  server.headersTimeout = 120 * 1000;
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
