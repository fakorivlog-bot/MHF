import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';
import {
  classifyPipelineError,
  extractHttpStatusFromError,
  MissingStageDependencyError,
  parseRateLimitMetadata,
  QuotaExhaustedError,
  sanitizeSecretText,
} from './errors.ts';
import {
  assembleFinalVideo,
  assembleFramesToVideo,
  computeImageSimilaritySsim,
  computeVideoSimilaritySsim,
  cutVideoSegment,
  detectSceneSegments,
  extractAudioTrack,
  extractKeyframes,
  extractSampledFrames,
  generateFeatherMaskPng,
  probeVideo,
  verifyPlayableVideo,
} from './ffmpeg.ts';
import {
  analyzeVideoAndDirectSceneUnified,
  generateMusicWithLyria,
  inspectSegmentCharacterReplacementQC,
  trackCharactersAcrossFrames,
  transcribeAudioFile,
} from './gemini.ts';
import {
  buildMissingStage4SetupOptions,
  editFrameWithFailover,
  generateSegmentWithFailover,
  inspectTaskCapabilities,
  isCharacterReplacementMode,
  selectCandidateModels,
  selectStage4ImageEditCandidates,
} from './providers/orchestrator.ts';
import type { FrameTrackBinding, MappedCharacterPair } from './providers/types.ts';
import {
  canCallModel,
  computeAnalysisCacheKey,
  getCachedAnalysis,
  saveCachedAnalysis,
} from './quota.ts';
import {
  getCharacter,
  getEnvironment,
  getProject,
  PROJECTS_DIR,
  recordUsageEntry,
  saveProject,
} from './store.ts';
import type {
  CharacterAsset,
  DetectedCharacter,
  DirectorBlueprint,
  EnvironmentAsset,
  FrameCharacterTrack,
  MultiStagePipelineState,
  PipelineFrameRecord,
  ProcessingStageKey,
  ProjectQcSummary,
  ProjectRecord,
  ProjectSegment,
  ReplacementScope,
} from './types.ts';

export const jobEvents = new EventEmitter();
jobEvents.setMaxListeners(100);

const activeRuns = new Set<string>();
const cancelledJobs = new Set<string>();

function emitProjectUpdate(project: ProjectRecord): void {
  saveProject(project);
  jobEvents.emit(`project:${project.id}`, project);
}

function appendLog(
  project: ProjectRecord,
  stage: ProcessingStageKey,
  message: string,
  level: 'info' | 'warning' | 'error' | 'success' = 'info'
): void {
  project.history.push({
    timestamp: new Date().toISOString(),
    stage,
    message: sanitizeSecretText(message),
    level,
  });
}

function markStageCompleted(project: ProjectRecord, stage: ProcessingStageKey): void {
  if (!project.completedStages.includes(stage)) {
    project.completedStages.push(stage);
  }
}

export function cancelProjectJob(projectId: string): ProjectRecord | null {
  const project = getProject(projectId);
  if (!project) return null;
  cancelledJobs.add(projectId);
  if (
    project.status === 'queued' ||
    project.status === 'analyzing' ||
    project.status === 'processing' ||
    project.status === 'awaiting_paid_confirmation'
  ) {
    project.status = 'cancelled';
    project.currentStage = 'cancelled';
    project.statusMessage = 'Job cancelled by user.';
    appendLog(project, 'cancelled', 'Job cancelled before completion.', 'warning');
    emitProjectUpdate(project);
  }
  return project;
}

function isCancelled(projectId: string): boolean {
  if (cancelledJobs.has(projectId)) return true;
  const latest = getProject(projectId);
  return latest?.status === 'cancelled';
}

function resolveMappedCharacters(
  project: ProjectRecord,
  refChars: CharacterAsset[]
): {
  mappedPairs: MappedCharacterPair[];
  preservedLabels: string[];
} {
  const mappedPairs: MappedCharacterPair[] = [];
  const preservedLabels: string[] = [];

  if (project.detectedCharacters.length > 0) {
    const mapping = project.characterMapping || {};
    for (const dc of project.detectedCharacters) {
      const hasExplicitEntry = Object.prototype.hasOwnProperty.call(mapping, dc.id);
      const targetId = hasExplicitEntry ? mapping[dc.id] : dc.matchedCharacterId;
      const targetChar = targetId ? getCharacter(targetId) : undefined;
      if (targetChar) {
        mappedPairs.push({
          sourceCharacterId: dc.id,
          sourceLabel: dc.label,
          sourceRole: dc.role,
          sourceVisualDescription: dc.visualDescription,
          targetCharacter: targetChar,
        });
      } else {
        preservedLabels.push(dc.label);
      }
    }
    return { mappedPairs, preservedLabels };
  }

  // Fallback if run before explicit detectedCharacters analysis populated
  refChars.forEach((char, idx) => {
    mappedPairs.push({
      sourceCharacterId: `char_source_${idx + 1}`,
      sourceLabel: idx === 0 ? 'Main Character' : `Secondary Subject ${idx + 1}`,
      sourceRole: idx === 0 ? 'main' : 'secondary',
      sourceVisualDescription: '',
      targetCharacter: char,
    });
  });

  return { mappedPairs, preservedLabels };
}

function buildSegmentPrompt(
  project: ProjectRecord,
  segIndex: number,
  totalSegs: number,
  mappedPairs: MappedCharacterPair[],
  preservedLabels: string[],
  envDescription: string | null
): string {
  const bp = project.blueprint;
  const scope: ReplacementScope =
    project.replacementScope ?? 'full_character_replacement';
  const bgMode =
    project.backgroundMode ?? (project.environmentId ? 'use_env_ref' : 'preserve');
  const lightMode = project.lightingMode ?? 'preserve';

  const pairDirectives = mappedPairs
    .map((p, i) => {
      const c = p.targetCharacter;
      const scopeRule =
        scope === 'face_replacement'
          ? 'Replace face, head, hair, and facial skin with this target character while keeping original clothes/body.'
          : 'Perform FULL character replacement (face, head, hair, body proportions, hands, and styling belong exclusively to this target character).';
      return `Replacement Binding #${i + 1}: Target Reference "${c.name}" COMPLETELY REPLACES source subject "${p.sourceLabel}" (${p.sourceRole}). ${scopeRule} Traits: ${c.profile?.identitySummaryPrompt ?? 'Maintain exact facial features, eyes, nose, mouth, hair, skin tone, and proportions from reference photo.'}`;
    })
    .join('\n');

  const preservedDirective =
    preservedLabels.length > 0
      ? `DO NOT REPLACE / KEEP ORIGINAL: ${preservedLabels.join(', ')}. Keep these unmapped people visually identical to the source video.`
      : '';

  const modeNote =
    project.mode === 'character_replacement' || mappedPairs.length > 0
      ? scope === 'face_replacement'
        ? 'Strictly perform reference-conditioned FACE & HEAD REPLACEMENT on the mapped character(s) while preserving original body movement, posture, actions, timing, and camera framing.'
        : 'Strictly perform reference-conditioned FULL CHARACTER REPLACEMENT on the mapped character(s) while preserving original motion, posture, gestures, camera angle, framing, and scene timing.'
      : project.mode === 'environment_transformation'
        ? 'Keep the subject action and camera motion while transforming the setting, weather, atmosphere, and lighting.'
        : project.mode === 'creative_transformation'
          ? 'Reimagine the scene cinematically inspired by the source footage motion and story.'
          : 'Recreate the scene with cinematic depth, preserved camera motion, and exact Reference Character identity replacement.';

  const bgDirective =
    bgMode === 'preserve'
      ? 'BACKGROUND PRESERVATION: Preserve the exact original background location, set geometry, props, and spatial layout from the source video unless explicitly changed below.'
      : bgMode === 'use_env_ref' && envDescription
        ? `TARGET ENVIRONMENT REFERENCE: ${envDescription}`
        : bp?.environmentTransformation
          ? `ENVIRONMENT TRANSFORMATION: ${bp.environmentTransformation}`
          : '';

  const lightDirective =
    lightMode === 'preserve'
      ? 'LIGHTING CONTINUITY: Match the natural lighting direction, shadow softness, exposure, and color grading of the original source footage.'
      : `CINEMATIC LIGHTING: ${bp?.lightingAndAtmosphere || 'Apply balanced cinematic contrast matching reference inputs.'}`;

  return [
    `Segment ${segIndex + 1} of ${totalSegs} (${project.segments[segIndex]?.durationSec.toFixed(1)}s).`,
    modeNote,
    `Director's Instruction (translated): ${bp?.englishTranslation || project.instruction}`,
    pairDirectives ? `Character Identity Transfer Mandates:\n${pairDirectives}` : '',
    preservedDirective,
    bgDirective,
    lightDirective,
    bp?.cameraAndMotionNotes
      ? `Camera & Motion Continuity: ${bp.cameraAndMotionNotes}`
      : '',
    mappedPairs.length > 0
      ? 'CRITICAL ANTI-BLENDING RULE: Never retain, blend, or morph the original source person’s face/identity with the reference character. The replacement character must be 100% recognizable as the reference portrait across front, three-quarter, and profile views.'
      : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}

function buildLocalDeterministicAnalysisFallback(params: {
  project: ProjectRecord;
  frameUrls: string[];
  rawSegs: Array<{ startSec: number; durationSec: number }>;
  refChars: CharacterAsset[];
  env: EnvironmentAsset | null;
  transcript: string;
}): {
  detectedCharacters: DetectedCharacter[];
  blueprint: DirectorBlueprint;
} {
  const firstRef = params.refChars[0] ?? null;
  const timeSpans = params.rawSegs.map(
    (s) => `${s.startSec.toFixed(1)}s-${(s.startSec + s.durationSec).toFixed(1)}s`
  );

  const detectedCharacters: DetectedCharacter[] = [
    {
      id: 'char_source_1',
      label: 'Primary Subject (Local Detection)',
      role: 'main',
      appearanceTimestamps: timeSpans,
      actions: `Subject active across ${params.rawSegs.length} scene segment(s)`,
      visualDescription:
        'Identified deterministically from FFmpeg scene keyframes while AI analysis quota is cooling down.',
      thumbnailUrl: params.frameUrls[0] || '',
      matchedCharacterId: firstRef ? firstRef.id : null,
      confidenceNote: firstRef
        ? `Automatically paired with uploaded portrait "${firstRef.name}" via local fallback.`
        : 'No reference character uploaded.',
    },
  ];

  const blueprint: DirectorBlueprint = {
    detectedLanguage: 'auto',
    englishTranslation: params.project.instruction,
    targetCharactersToReplace: params.refChars.map((c) => c.name),
    preservedElements: [
      'Original camera movement',
      'Original framing & motion pacing',
    ],
    environmentTransformation:
      params.env?.description ||
      'Apply transformation guidance directly from user instruction.',
    cameraAndMotionNotes: 'Preserve source video motion trajectory and pacing.',
    lightingAndAtmosphere: 'Balanced cinematic contrast matching reference inputs.',
    audioDesignPlan: {
      preserveDialogue: params.project.audioMode === 'preserve_dialogue',
      musicMood: 'Atmospheric film score',
      soundEffects: [],
      ambientBed: 'Natural ambient track',
    },
    ...(params.transcript ? { transcriptSummary: params.transcript } : {}),
  };

  return { detectedCharacters, blueprint };
}

export async function runProjectAnalysis(projectId: string): Promise<ProjectRecord> {
  const project = getProject(projectId);
  if (!project) throw new Error('Project not found.');

  if (!project.sourceVideo?.filePath || !fs.existsSync(project.sourceVideo.filePath)) {
    const err = new Error(
      `Source video file missing on server storage (${project.sourceVideo?.originalName || 'unknown'}). Please re-upload the video.`
    );
    project.status = 'failed';
    project.currentStage = 'uploading';
    project.diagnosticDetail = classifyPipelineError(err, {
      stage: 'uploading',
      provider: 'Server Storage',
    });
    project.errorMessage = project.diagnosticDetail.userMessage;
    project.statusMessage = project.diagnosticDetail.userMessage;
    appendLog(project, 'uploading', project.errorMessage, 'error');
    emitProjectUpdate(project);
    throw err;
  }

  const projectDir = path.join(PROJECTS_DIR, project.id);
  const framesDir = path.join(projectDir, 'analysis_frames');
  const segmentsDir = path.join(projectDir, 'source_segments');
  fs.mkdirSync(framesDir, { recursive: true });
  fs.mkdirSync(segmentsDir, { recursive: true });

  markStageCompleted(project, 'uploading');
  markStageCompleted(project, 'upload_completed');
  project.status = 'analyzing';
  project.errorMessage = null;
  project.diagnosticDetail = null;
  project.currentStage = 'analyzing_scenes';
  project.progressPercent = 10;
  project.progressIsEstimate = true;
  project.providerProgressAvailable = false;
  project.statusMessage =
    'Analyzing reference video & running FFmpeg scene boundary detection...';
  appendLog(project, 'analyzing_scenes', 'Starting FFmpeg scene boundary detection.');
  emitProjectUpdate(project);

  try {
    const maxSegSec = project.qualityTier === 'economy' ? 8 : 10;
    const rawSegs = await detectSceneSegments(
      project.sourceVideo.filePath,
      project.sourceVideo.durationSec,
      maxSegSec,
      3
    );

    const sampleTimestamps = rawSegs.map((s) =>
      Math.min(
        Math.max(0, project.sourceVideo.durationSec - 0.2),
        Math.max(0, s.startSec + s.durationSec * 0.45)
      )
    );
    if (sampleTimestamps.length === 1 && project.sourceVideo.durationSec >= 2) {
      sampleTimestamps.push(Math.max(0, project.sourceVideo.durationSec - 0.25));
    }

    const framePaths = await extractKeyframes(
      project.sourceVideo.filePath,
      sampleTimestamps,
      framesDir
    );
    const frameUrls = framePaths.map(
      (p) => `/storage/projects/${project.id}/analysis_frames/${path.basename(p)}`
    );

    const projectSegments: ProjectSegment[] = [];
    for (let i = 0; i < rawSegs.length; i++) {
      const segFileName = `src_seg_${i}.mp4`;
      const segPath = path.join(segmentsDir, segFileName);
      await cutVideoSegment(
        project.sourceVideo.filePath,
        rawSegs[i].startSec,
        rawSegs[i].durationSec,
        segPath
      );
      const kfPath = framePaths[Math.min(i, framePaths.length - 1)] || '';
      const kfUrl = frameUrls[Math.min(i, frameUrls.length - 1)] || '';
      projectSegments.push({
        index: i,
        startSec: rawSegs[i].startSec,
        durationSec: rawSegs[i].durationSec,
        sourceSegmentPath: segPath,
        sourceSegmentUrl: `/storage/projects/${project.id}/source_segments/${segFileName}`,
        keyframePath: kfPath,
        keyframeUrl: kfUrl,
        outputSegmentPath: null,
        outputSegmentUrl: null,
        promptUsed: '',
        status: 'pending',
        consistencyCheck: null,
        errorMessage: null,
        providerUsed: 'pending',
        modelUsed: 'pending',
        providerJobId: null,
        providerJobStatus: null,
        httpStatusCode: null,
        isNativeResolution:
          project.resolution === '1080p' && project.sourceVideo.height >= 1080,
        isEstimatedDuration: true,
      });
    }

    project.segments = projectSegments;
    markStageCompleted(project, 'analyzing_scenes');
    project.currentStage = 'detecting_characters';
    project.progressPercent = 20;
    project.statusMessage =
      'Identifying characters and matching uploaded portraits via Gemini 4 Hydrogen...';
    emitProjectUpdate(project);

    const refChars = project.characterIds
      .map((id) => getCharacter(id))
      .filter((c): c is CharacterAsset => Boolean(c));
    const env = project.environmentId ? getEnvironment(project.environmentId) : null;
    const envVideoNote = project.environmentVideo
      ? `Additional environment reference video attached (${project.environmentVideo.originalName}, ${project.environmentVideo.durationSec}s).`
      : '';
    const fullInstruction = envVideoNote
      ? `${project.instruction}\n\n[Environment Video Context: ${envVideoNote}]`
      : project.instruction;

    const cacheKey = computeAnalysisCacheKey({
      sourceFileName: project.sourceVideo.originalName,
      sourceFileSizeBytes: project.sourceVideo.fileSizeBytes,
      sourceDurationSec: project.sourceVideo.durationSec,
      characterIds: project.characterIds,
      environmentId: project.environmentId,
      environmentVideoName: project.environmentVideo?.originalName ?? null,
      instruction: fullInstruction,
      mode: project.mode,
    });

    const cached = getCachedAnalysis(cacheKey);
    let detected: DetectedCharacter[] = [];
    let blueprint: DirectorBlueprint;

    if (cached) {
      // Cache hit -> 0 Gemini API calls consumed!
      detected = cached.detectedCharacters.map((dc, idx) => ({
        ...dc,
        thumbnailUrl: frameUrls[Math.min(idx, Math.max(0, frameUrls.length - 1))] || dc.thumbnailUrl,
      }));
      blueprint = cached.blueprint;
      project.selectedModels.analysisModel = `${cached.analyzedByModel} (cached)`;
      appendLog(
        project,
        'detecting_characters',
        'Reused cached Gemini analysis & director blueprint (0 API requests consumed).',
        'success'
      );
      markStageCompleted(project, 'detecting_characters');
      project.currentStage = 'preparing_references';
      project.progressPercent = 28;
      project.statusMessage = 'Loaded cached character & director blueprint.';
    } else {
      // Only spend a transcription request when audio exists AND user requested dialogue preservation
      let transcript = '';
      if (
        project.sourceVideo.hasAudio &&
        project.audioMode === 'preserve_dialogue' &&
        canCallModel('google_gemini', 'gemini-3.5-transcribe').allowed
      ) {
        const origAudioPath = path.join(projectDir, 'original_audio.mp3');
        const extracted = await extractAudioTrack(
          project.sourceVideo.filePath,
          origAudioPath
        );
        if (extracted) {
          try {
            transcript = await transcribeAudioFile(origAudioPath, {
              projectId: project.id,
              projectName: project.name,
            });
          } catch {
            transcript = '';
          }
        }
      }

      try {
        // Unified single structured request (1 Gemini call instead of 2 separate requests!)
        const unified = await analyzeVideoAndDirectSceneUnified({
          framePaths,
          frameTimestampsSec: sampleTimestamps,
          frameUrls,
          durationSec: project.sourceVideo.durationSec,
          referenceCharacters: refChars,
          instruction: fullInstruction,
          mode: project.mode,
          environment: env,
          transcriptSummary: transcript,
          projectId: project.id,
          projectName: project.name,
        });
        detected = unified.detectedCharacters;
        blueprint = unified.blueprint;
        project.selectedModels.analysisModel = 'gemini-4-hydrogen';

        saveCachedAnalysis(cacheKey, {
          analyzedByModel: 'gemini-4-hydrogen',
          detectedCharacters: detected,
          blueprint,
          transcript,
        });
      } catch (err) {
        const rateMeta = parseRateLimitMetadata(err);
        const httpStatus = extractHttpStatusFromError(err);

        // If Gemini analysis hits 429 RESOURCE_EXHAUSTED or transient 503/504 unavailability, gracefully fall back
        // to local FFmpeg/deterministic scene+character prep so multi-provider video generation can proceed cleanly!
        if (
          err instanceof QuotaExhaustedError ||
          rateMeta.isQuotaOrRateLimit ||
          httpStatus === 503 ||
          httpStatus === 504
        ) {
          const localFallback = buildLocalDeterministicAnalysisFallback({
            project,
            frameUrls,
            rawSegs,
            refChars,
            env,
            transcript,
          });
          detected = localFallback.detectedCharacters;
          blueprint = localFallback.blueprint;
          project.selectedModels.analysisModel =
            httpStatus === 503 || httpStatus === 504
              ? `local-deterministic (Gemini ${httpStatus} fallback)`
              : 'local-deterministic (Gemini 429 fallback)';
          appendLog(
            project,
            'detecting_characters',
            `Gemini gemini-4-hydrogen unavailable (${httpStatus ?? 429}${rateMeta.quotaIdentifier ? ` · ${rateMeta.quotaIdentifier}` : ''}). Switched cleanly to local deterministic analysis so video generation can proceed.`,
            'warning'
          );
        } else {
          const diag = classifyPipelineError(err, {
            stage: 'detecting_characters',
            provider: 'Google Gemini API',
            model: 'gemini-4-hydrogen',
            retryAfterAt:
              httpStatus === 429 && rateMeta.retryAfterSec
                ? new Date(Date.now() + rateMeta.retryAfterSec * 1000).toISOString()
                : null,
          });
          project.status = 'failed';
          project.currentStage = 'failed';
          project.diagnosticDetail = diag;
          project.errorMessage = diag.userMessage;
          project.statusMessage = diag.userMessage;
          appendLog(project, 'detecting_characters', diag.technicalError, 'error');
          emitProjectUpdate(project);
          throw err;
        }
      }

      markStageCompleted(project, 'detecting_characters');
      project.currentStage = 'preparing_references';
      project.progressPercent = 28;
      project.statusMessage =
        'Scene direction & character blueprint prepared.';
    }

    project.detectedCharacters = detected;
    const mapping: Record<string, string | null> = {};
    for (const d of detected) {
      mapping[d.id] = d.matchedCharacterId;
    }
    project.characterMapping = mapping;
    project.blueprint = blueprint;
    markStageCompleted(project, 'preparing_references');
    project.status = 'draft';
    project.statusMessage = 'Analysis complete. Ready to run production pipeline.';
    appendLog(
      project,
      'preparing_references',
      `Segmented into ${project.segments.length} scene(s), mapped ${detected.length} character(s) (${project.selectedModels.analysisModel}).`,
      'success'
    );
    emitProjectUpdate(project);
    return project;
  } catch (err) {
    if (!project.diagnosticDetail) {
      const diag = classifyPipelineError(err, {
        stage: project.currentStage,
        provider: 'Google Gemini API',
        model: 'gemini-4-hydrogen',
      });
      project.status = 'failed';
      project.currentStage = 'failed';
      project.diagnosticDetail = diag;
      project.errorMessage = diag.userMessage;
      project.statusMessage = diag.userMessage;
      appendLog(project, 'failed', diag.technicalError, 'error');
      emitProjectUpdate(project);
    }
    throw err;
  }
}

function buildStage4FramePrompt(params: {
  project: ProjectRecord;
  frame: PipelineFrameRecord;
  totalFrames: number;
  bindings: FrameTrackBinding[];
  preservedLabels: string[];
  env: EnvironmentAsset | null;
  isTemporalReprocess?: boolean;
}): string {
  const scope: ReplacementScope =
    params.project.replacementScope ?? 'full_character_replacement';
  const bgMode =
    params.project.backgroundMode ?? (params.project.environmentId ? 'use_env_ref' : 'preserve');
  const lightMode = params.project.lightingMode ?? 'preserve';

  const bindingLines = params.bindings
    .map((b, i) => {
      const c = b.targetCharacter;
      const scopeRule =
        scope === 'face_replacement'
          ? 'Replace face, head, and facial skin with reference portrait while keeping original clothes/body.'
          : 'Perform FULL character replacement (face, head, hair, skin, body proportions, hands, wardrobe styling matching target reference).';
      return `Binding #${i + 1}: Replace "${b.sourceLabel}" inside bbox=${JSON.stringify(b.bbox)} (pose: ${b.poseSummary}) with Reference Character "${c.name}". ${scopeRule} Traits: ${c.profile?.identitySummaryPrompt || 'Match reference portrait exactly.'}`;
    })
    .join('\n');

  return [
    `Edit frame #${params.frame.index + 1} of ${params.totalFrames} (t=${params.frame.timestampSec.toFixed(2)}s).`,
    params.isTemporalReprocess
      ? 'TEMPORAL CONSISTENCY REPAIR: Match previous/neighbor edited frame face lighting, scale, hair continuity, and identity strictly without flicker.'
      : '',
    bindingLines,
    params.preservedLabels.length > 0
      ? `KEEP ORIGINAL UNCHANGED: ${params.preservedLabels.join(', ')}.`
      : '',
    bgMode === 'preserve'
      ? 'BACKGROUND: Preserve exact original scene background, geometry, and pixels outside the masked target.'
      : bgMode === 'use_env_ref' && params.env
        ? `ENVIRONMENT: ${params.env.description}`
        : `ENVIRONMENT DIRECTION: ${params.project.blueprint?.environmentTransformation || params.project.instruction}`,
    lightMode === 'preserve'
      ? 'LIGHTING: Match original source frame lighting direction, color temperature, and shadows.'
      : 'LIGHTING: Balanced cinematic contrast.',
    `Director instruction: ${params.project.blueprint?.englishTranslation || params.project.instruction}`,
    'NEVER blend or retain the original target person face.',
  ]
    .filter(Boolean)
    .join('\n');
}

async function runMultiStageCharacterPipeline(params: {
  projectId: string;
  project: ProjectRecord;
  refChars: CharacterAsset[];
  mappedCharacterPairs: MappedCharacterPair[];
  preservedCharacterLabels: string[];
}): Promise<void> {
  const { projectId, project, refChars, mappedCharacterPairs, preservedCharacterLabels } =
    params;
  const requiresMultiCharacter = mappedCharacterPairs.length > 1;
  const resolvedScope: ReplacementScope =
    project.replacementScope ?? 'full_character_replacement';
  const resolvedBackgroundMode =
    project.backgroundMode ?? (project.environmentId ? 'use_env_ref' : 'preserve');
  const resolvedLightingMode = project.lightingMode ?? 'preserve';
  const env = project.environmentId ? getEnvironment(project.environmentId) : null;

  const projectDir = path.join(PROJECTS_DIR, project.id);
  const framesDir = path.join(projectDir, 'extracted_frames');
  const masksDir = path.join(projectDir, 'masks');
  const editedDir = path.join(projectDir, 'edited_frames');
  fs.mkdirSync(framesDir, { recursive: true });
  fs.mkdirSync(masksDir, { recursive: true });
  fs.mkdirSync(editedDir, { recursive: true });

  const samplingFps =
    project.qualityTier === 'maximum' ? 6 : project.qualityTier === 'balanced' ? 4 : 3;

  const state: MultiStagePipelineState = project.pipelineState?.workflowType === 'multistage_frame_replacement'
    ? project.pipelineState
    : {
        workflowType: 'multistage_frame_replacement',
        samplingFps,
        sourceAudioPath: null,
        frames: [],
        lastCompletedStageNumber: 0,
        stageModels: {
          detection: project.selectedModels.analysisModel || 'gemini-4-hydrogen',
          segmentation: 'node-png-feather-mask',
          pose: project.selectedModels.analysisModel || 'gemini-4-hydrogen',
          temporal: 'ffmpeg-ssim-temporal-repair',
          reconstruction: 'ffmpeg-h264-aac',
        },
        missingDependency: null,
      };

  state.workflowType = 'multistage_frame_replacement';
  state.missingDependency = null;
  project.pipelineState = state;

  // =========================================================================
  // STAGE 1: VIDEO INGESTION & AUDIO PRESERVATION
  // =========================================================================
  project.status = 'processing';
  project.currentStage = 'stage_1_ingestion';
  project.progressPercent = Math.max(project.progressPercent, 10);
  project.statusMessage = 'Stage 1/6: Validating source footage & preserving audio track...';
  emitProjectUpdate(project);

  const sourceProbe = await probeVideo(project.sourceVideo.filePath);
  const playableSource = await verifyPlayableVideo(project.sourceVideo.filePath);
  if (!playableSource) {
    throw new Error('Uploaded source video failed FFmpeg stream validation.');
  }

  const origAudioPath = path.join(projectDir, 'original_audio.mp3');
  if (sourceProbe.hasAudio && !fs.existsSync(origAudioPath)) {
    const ok = await extractAudioTrack(project.sourceVideo.filePath, origAudioPath);
    if (ok) state.sourceAudioPath = origAudioPath;
  } else if (fs.existsSync(origAudioPath)) {
    state.sourceAudioPath = origAudioPath;
  }

  state.lastCompletedStageNumber = Math.max(state.lastCompletedStageNumber, 1);
  markStageCompleted(project, 'stage_1_ingestion');
  appendLog(
    project,
    'stage_1_ingestion',
    `Stage 1 complete: Verified ${sourceProbe.width}x${sourceProbe.height} (${sourceProbe.durationSec}s, ${sourceProbe.fps}fps).`,
    'success'
  );
  emitProjectUpdate(project);

  if (isCancelled(projectId)) return;

  // =========================================================================
  // STAGE 2: FRAME EXTRACTION (Timestamp-Preserving)
  // =========================================================================
  project.currentStage = 'stage_2_frame_extraction';
  project.progressPercent = 22;
  project.statusMessage = `Stage 2/6: Extracting timestamp-accurate frames (${samplingFps} fps sample rate)...`;
  emitProjectUpdate(project);

  const hasValidExistingFrames =
    state.lastCompletedStageNumber >= 2 &&
    state.frames.length >= 2 &&
    state.frames.every((f) => f.sourceFramePath && fs.existsSync(f.sourceFramePath));

  if (!hasValidExistingFrames) {
    const extracted = await extractSampledFrames({
      videoPath: project.sourceVideo.filePath,
      durationSec: sourceProbe.durationSec,
      samplingFps,
      outDir: framesDir,
      maxFrames: 24,
    });

    state.frames = extracted.map((f) => ({
      index: f.index,
      timestampSec: f.timestampSec,
      sourceFramePath: f.framePath,
      sourceFrameUrl: `/storage/projects/${project.id}/extracted_frames/${path.basename(f.framePath)}`,
      unionMaskPath: null,
      unionMaskUrl: null,
      editedFramePath: null,
      editedFrameUrl: null,
      tracks: [],
      status: 'extracted',
    }));
    state.lastCompletedStageNumber = Math.max(state.lastCompletedStageNumber, 2);
    appendLog(
      project,
      'stage_2_frame_extraction',
      `Stage 2 complete: Extracted ${state.frames.length} timestamp-synced frames.`,
      'success'
    );
  } else {
    appendLog(
      project,
      'stage_2_frame_extraction',
      `Stage 2 reused ${state.frames.length} extracted frames from saved workspace.`,
      'info'
    );
  }

  markStageCompleted(project, 'stage_2_frame_extraction');
  emitProjectUpdate(project);

  if (isCancelled(projectId)) return;

  // =========================================================================
  // STAGE 3: CHARACTER DETECTION, TRACKING & SEGMENTATION MASKS
  // =========================================================================
  project.currentStage = 'stage_3_character_tracking';
  project.progressPercent = 36;
  project.statusMessage =
    'Stage 3/6: Tracking subjects across frames & generating feathered segmentation masks...';
  emitProjectUpdate(project);

  const hasValidExistingTracks =
    state.lastCompletedStageNumber >= 3 &&
    state.frames.length > 0 &&
    state.frames.every(
      (f) => f.tracks.length > 0 && f.unionMaskPath && fs.existsSync(f.unionMaskPath)
    );

  if (!hasValidExistingTracks) {
    let trackMap = new Map<number, FrameCharacterTrack[]>();
    try {
      trackMap = await trackCharactersAcrossFrames({
        frames: state.frames.map((f) => ({
          index: f.index,
          timestampSec: f.timestampSec,
          framePath: f.sourceFramePath,
          frameUrl: f.sourceFrameUrl,
        })),
        detectedCharacters: project.detectedCharacters,
        projectId: project.id,
        projectName: project.name,
      });
      state.stageModels.detection = 'gemini-4-hydrogen';
      state.stageModels.pose = 'gemini-4-hydrogen';
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      appendLog(
        project,
        'stage_3_character_tracking',
        `Gemini frame tracker unavailable (${msg.slice(0, 120)}). Using deterministic bounding-box tracking + feathered mask generator.`,
        'warning'
      );
      state.stageModels.detection = 'local-deterministic-tracker';
      state.stageModels.pose = 'local-deterministic-tracker';
    }

    const mappedSourceIds = new Set(mappedCharacterPairs.map((p) => p.sourceCharacterId));
    const maskW = Math.min(512, Math.max(128, sourceProbe.width));
    const maskH = Math.min(512, Math.max(128, sourceProbe.height));

    for (const frame of state.frames) {
      let frameTracks = trackMap.get(frame.index);
      if (!frameTracks || frameTracks.length === 0) {
        const defaults =
          mappedCharacterPairs.length > 0
            ? mappedCharacterPairs.map((p, i) => ({
                id: p.sourceCharacterId,
                label: p.sourceLabel,
                offset: i * 0.22,
              }))
            : [{ id: 'char_source_1', label: 'Primary Subject', offset: 0 }];
        frameTracks = defaults.map((d) => ({
          characterId: d.id,
          label: d.label,
          bbox: [Math.min(0.6, 0.28 + d.offset), 0.1, 0.42, 0.82],
          faceBox: [Math.min(0.68, 0.39 + d.offset), 0.12, 0.2, 0.22],
          poseSummary: 'Tracked foreground subject',
          occluded: false,
        }));
      }

      // Generate per-mapped-character mask + union replacement mask (Keep Original excluded!)
      const mappedBoxes: Array<{
        bbox: [number, number, number, number];
        faceBox?: [number, number, number, number];
      }> = [];

      for (const tr of frameTracks) {
        const shouldReplace =
          mappedSourceIds.size === 0 || mappedSourceIds.has(tr.characterId);
        if (!shouldReplace) continue;

        const charMaskFile = `mask_f${String(frame.index).padStart(4, '0')}_${tr.characterId.replace(/[^a-zA-Z0-9_-]/g, '')}.png`;
        const charMaskPath = path.join(masksDir, charMaskFile);
        await generateFeatherMaskPng({
          width: maskW,
          height: maskH,
          boxes: [{ bbox: tr.bbox, faceBox: tr.faceBox }],
          scope: resolvedScope,
          outPath: charMaskPath,
        });
        tr.maskPath = charMaskPath;
        tr.maskUrl = `/storage/projects/${project.id}/masks/${charMaskFile}`;
        mappedBoxes.push({ bbox: tr.bbox, faceBox: tr.faceBox });
      }

      if (mappedBoxes.length === 0 && frameTracks.length > 0) {
        mappedBoxes.push({
          bbox: frameTracks[0].bbox,
          faceBox: frameTracks[0].faceBox,
        });
      }

      const unionFile = `union_mask_f${String(frame.index).padStart(4, '0')}.png`;
      const unionPath = path.join(masksDir, unionFile);
      await generateFeatherMaskPng({
        width: maskW,
        height: maskH,
        boxes: mappedBoxes,
        scope: resolvedScope,
        outPath: unionPath,
      });

      frame.tracks = frameTracks;
      frame.unionMaskPath = unionPath;
      frame.unionMaskUrl = `/storage/projects/${project.id}/masks/${unionFile}`;
      if (frame.status === 'extracted') frame.status = 'tracked';
    }

    state.stageModels.segmentation = 'node-png-feather-mask';
    state.lastCompletedStageNumber = Math.max(state.lastCompletedStageNumber, 3);
    appendLog(
      project,
      'stage_3_character_tracking',
      `Stage 3 complete: Tracked subjects and generated ${state.frames.length} feathered PNG segmentation masks (${resolvedScope}).`,
      'success'
    );
  } else {
    appendLog(
      project,
      'stage_3_character_tracking',
      `Stage 3 reused ${state.frames.length} existing character tracks and masks from disk.`,
      'info'
    );
  }

  markStageCompleted(project, 'stage_3_character_tracking');
  project.progressPercent = 48;
  emitProjectUpdate(project);

  if (isCancelled(projectId)) return;

  // =========================================================================
  // STAGE 4: CHARACTER REPLACEMENT (Image-Based Reference-Conditioned Editing)
  // =========================================================================
  project.currentStage = 'stage_4_character_replacement';
  project.progressPercent = 50;
  project.statusMessage =
    'Stage 4/6: Checking image-based character replacement backend & editing frames...';
  emitProjectUpdate(project);

  const stage4Candidates = selectStage4ImageEditCandidates({
    billingMode: project.billingMode,
    replacementScope: resolvedScope,
    resolution: project.resolution,
    requiresMultiCharacter,
  });

  if (stage4Candidates.length === 0) {
    const setupOptions = buildMissingStage4SetupOptions();
    const depMsg =
      project.billingMode === 'free'
        ? 'Stages 1–3 completed and saved (extracted frames + character tracks + PNG segmentation masks are preserved). Stage 4 needs an image-based replacement backend: connect the Open-Source Local GPU Worker ($0 API fee), add HF_TOKEN, or switch to Paid Mode — then click Resume.'
        : 'Stages 1–3 completed and saved. Stage 4 needs a connected image-editing backend (Local GPU Worker, HF_TOKEN, GEMINI_API_KEY, or FAL_KEY) — then click Resume.';

    state.missingDependency = {
      stage: 'stage_4_character_replacement',
      title: 'Stage 4 Image-Based Replacement Backend Required',
      description: depMsg,
      setupOptions,
    };

    const depErr = new MissingStageDependencyError(depMsg, {
      providerId: 'orchestrator',
      missingDependencies: ['stage_4_character_replacement'],
    });
    const diag = classifyPipelineError(depErr, {
      stage: 'stage_4_character_replacement',
      provider: 'Stage 4 Orchestrator',
      missingDependencies: ['stage_4_character_replacement'],
    });

    project.selectedModels.videoProvider = 'Stages 1–3 Ready (Stage 4 Setup Required)';
    project.selectedModels.videoModel = 'paused-at-stage-4';
    project.status = 'partial_failure';
    project.currentStage = 'stage_4_character_replacement';
    project.progressPercent = 50;
    project.diagnosticDetail = diag;
    project.errorMessage = diag.userMessage;
    project.statusMessage = depMsg;
    appendLog(project, 'stage_4_character_replacement', depMsg, 'warning');
    emitProjectUpdate(project);
    return;
  }

  const primaryStage4 = stage4Candidates[0];
  project.selectedModels.videoProvider = primaryStage4.provider.displayName;
  project.selectedModels.videoModel = primaryStage4.model.id;
  project.selectedModels.selectionReason = primaryStage4.reason;
  state.stageModels.frameEditing = `${primaryStage4.provider.displayName} (${primaryStage4.model.id})`;

  appendLog(
    project,
    'stage_4_character_replacement',
    `Stage 4 started using ${primaryStage4.provider.displayName} (${primaryStage4.model.id}) — ${primaryStage4.reason}.`,
    'info'
  );
  emitProjectUpdate(project);

  let previousEditedPath: string | null = null;
  let stage4FailedFrames = 0;

  for (let i = 0; i < state.frames.length; i++) {
    if (isCancelled(projectId)) return;
    const frame = state.frames[i];

    // Resume support: skip frames already edited and verified on disk
    if (
      (frame.status === 'edited' || frame.status === 'reprocessed') &&
      frame.editedFramePath &&
      fs.existsSync(frame.editedFramePath) &&
      fs.statSync(frame.editedFramePath).size >= 512
    ) {
      previousEditedPath = frame.editedFramePath;
      continue;
    }

    const outFrameFile = `edited_frame_${String(frame.index).padStart(4, '0')}.png`;
    const outFramePath = path.join(editedDir, outFrameFile);

    const bindings: FrameTrackBinding[] = mappedCharacterPairs.map((pair, idx) => {
      const tr =
        frame.tracks.find((t) => t.characterId === pair.sourceCharacterId) ??
        frame.tracks[idx] ??
        frame.tracks[0];
      return {
        sourceCharacterId: pair.sourceCharacterId,
        sourceLabel: pair.sourceLabel,
        bbox: tr?.bbox ?? [0.28, 0.1, 0.44, 0.82],
        faceBox: tr?.faceBox,
        poseSummary: tr?.poseSummary ?? 'Tracked foreground subject',
        occluded: tr?.occluded ?? false,
        maskPath: tr?.maskPath ?? frame.unionMaskPath ?? null,
        targetCharacter: pair.targetCharacter,
      };
    });

    if (bindings.length === 0 && refChars.length > 0) {
      const tr = frame.tracks[0];
      bindings.push({
        sourceCharacterId: tr?.characterId ?? 'char_source_1',
        sourceLabel: tr?.label ?? 'Primary Subject',
        bbox: tr?.bbox ?? [0.28, 0.1, 0.44, 0.82],
        faceBox: tr?.faceBox,
        poseSummary: tr?.poseSummary ?? 'Tracked foreground subject',
        occluded: tr?.occluded ?? false,
        maskPath: frame.unionMaskPath ?? null,
        targetCharacter: refChars[0],
      });
    }

    const framePrompt = buildStage4FramePrompt({
      project,
      frame,
      totalFrames: state.frames.length,
      bindings,
      preservedLabels: preservedCharacterLabels,
      env,
    });

    project.progressPercent = Math.round(52 + (i / state.frames.length) * 24);
    project.estimatedRemainingSec = Math.max(2, (state.frames.length - i) * 3);
    project.statusMessage = `Stage 4/6: Replacing character on frame ${i + 1} of ${state.frames.length} via ${primaryStage4.provider.displayName}...`;
    emitProjectUpdate(project);

    try {
      const editRes = await editFrameWithFailover({
        billingMode: project.billingMode,
        replacementScope: resolvedScope,
        resolution: project.resolution,
        requiresMultiCharacter,
        requestBase: {
          frameIndex: frame.index,
          totalFrames: state.frames.length,
          timestampSec: frame.timestampSec,
          sourceFramePath: frame.sourceFramePath,
          outFramePath,
          unionMaskPath: frame.unionMaskPath ?? null,
          previousEditedFramePath: previousEditedPath,
          sourceWidth: sourceProbe.width,
          sourceHeight: sourceProbe.height,
          aspectRatio: project.aspectRatio,
          replacementScope: resolvedScope,
          backgroundMode: resolvedBackgroundMode,
          lightingMode: resolvedLightingMode,
          environmentRef: env,
          bindings,
          preservedCharacterLabels,
          prompt: framePrompt,
          projectId: project.id,
          projectName: project.name,
        },
        onAttemptLog: (msg, level) => appendLog(project, 'stage_4_character_replacement', msg, level),
      });

      const [ssimSrc, ssimPrev] = await Promise.all([
        computeImageSimilaritySsim(frame.sourceFramePath, outFramePath),
        previousEditedPath
          ? computeImageSimilaritySsim(previousEditedPath, outFramePath)
          : Promise.resolve(null),
      ]);

      frame.editedFramePath = outFramePath;
      frame.editedFrameUrl = `/storage/projects/${project.id}/edited_frames/${outFrameFile}`;
      frame.status = 'edited';
      frame.providerUsed = editRes.providerName;
      frame.modelUsed = editRes.modelUsed;
      frame.ssimVsSource = ssimSrc;
      frame.temporalSimilarityToPrev = ssimPrev;
      frame.errorMessage = null;
      previousEditedPath = outFramePath;

      project.usageStats.segmentsGenerated += 1;
      project.usageStats.estimatedCostUsd =
        Math.round((project.usageStats.estimatedCostUsd + editRes.estimatedCostUsd) * 100) / 100;
    } catch (err) {
      stage4FailedFrames += 1;
      const msg = err instanceof Error ? err.message : String(err);
      frame.status = 'failed';
      frame.errorMessage = sanitizeSecretText(msg);
      appendLog(
        project,
        'stage_4_character_replacement',
        `Frame #${frame.index + 1} Stage 4 edit failed: ${frame.errorMessage}`,
        'error'
      );
      if (!project.diagnosticDetail) {
        project.diagnosticDetail = classifyPipelineError(err, {
          stage: 'stage_4_character_replacement',
          provider: primaryStage4.provider.displayName,
          model: primaryStage4.model.id,
        });
      }
    }

    emitProjectUpdate(project);
  }

  if (stage4FailedFrames > 0) {
    const editedCount = state.frames.filter(
      (f) => f.status === 'edited' || f.status === 'reprocessed'
    ).length;
    project.status = 'partial_failure';
    project.currentStage = 'stage_4_character_replacement';
    project.errorMessage =
      project.diagnosticDetail?.userMessage ||
      `${stage4FailedFrames} frame(s) failed Stage 4 character replacement (${editedCount}/${state.frames.length} succeeded). Already-edited frames are preserved for Resume.`;
    project.statusMessage = project.errorMessage;
    emitProjectUpdate(project);
    return;
  }

  state.lastCompletedStageNumber = Math.max(state.lastCompletedStageNumber, 4);
  markStageCompleted(project, 'stage_4_character_replacement');
  appendLog(
    project,
    'stage_4_character_replacement',
    `Stage 4 complete: All ${state.frames.length} frames edited with reference character conditioning.`,
    'success'
  );
  emitProjectUpdate(project);

  if (isCancelled(projectId)) return;

  // =========================================================================
  // STAGE 5: TEMPORAL CONSISTENCY & VISUAL QA
  // =========================================================================
  project.currentStage = 'stage_5_temporal_consistency';
  project.progressPercent = 78;
  project.statusMessage =
    'Stage 5/6: Checking temporal consistency across consecutive frames & validating identity transfer...';
  emitProjectUpdate(project);

  let reprocessedCount = 0;
  let temporalFlickerDetected = false;

  for (let i = 0; i < state.frames.length; i++) {
    const frame = state.frames[i];
    const prevEdited = i > 0 ? state.frames[i - 1].editedFramePath : null;
    if (!frame.editedFramePath || !fs.existsSync(frame.editedFramePath)) {
      frame.status = 'failed';
      continue;
    }

    const ssimSrc =
      frame.ssimVsSource ??
      (await computeImageSimilaritySsim(frame.sourceFramePath, frame.editedFramePath));
    const ssimPrev =
      prevEdited && fs.existsSync(prevEdited)
        ? (frame.temporalSimilarityToPrev ??
          (await computeImageSimilaritySsim(prevEdited, frame.editedFramePath)))
        : null;
    frame.ssimVsSource = ssimSrc;
    frame.temporalSimilarityToPrev = ssimPrev;

    const looksUnedited = ssimSrc !== null && ssimSrc >= 0.99;
    const looksFlickery = ssimPrev !== null && ssimPrev < 0.42;

    if ((looksUnedited || looksFlickery) && i > 0 && prevEdited) {
      try {
        const bindings: FrameTrackBinding[] = mappedCharacterPairs.map((pair, idx) => {
          const tr =
            frame.tracks.find((t) => t.characterId === pair.sourceCharacterId) ??
            frame.tracks[idx] ??
            frame.tracks[0];
          return {
            sourceCharacterId: pair.sourceCharacterId,
            sourceLabel: pair.sourceLabel,
            bbox: tr?.bbox ?? [0.28, 0.1, 0.44, 0.82],
            faceBox: tr?.faceBox,
            poseSummary: tr?.poseSummary ?? 'Tracked foreground subject',
            occluded: tr?.occluded ?? false,
            maskPath: tr?.maskPath ?? frame.unionMaskPath ?? null,
            targetCharacter: pair.targetCharacter,
          };
        });
        await editFrameWithFailover({
          billingMode: project.billingMode,
          replacementScope: resolvedScope,
          resolution: project.resolution,
          requiresMultiCharacter,
          requestBase: {
            frameIndex: frame.index,
            totalFrames: state.frames.length,
            timestampSec: frame.timestampSec,
            sourceFramePath: frame.sourceFramePath,
            outFramePath: frame.editedFramePath,
            unionMaskPath: frame.unionMaskPath ?? null,
            previousEditedFramePath: prevEdited,
            sourceWidth: sourceProbe.width,
            sourceHeight: sourceProbe.height,
            aspectRatio: project.aspectRatio,
            replacementScope: resolvedScope,
            backgroundMode: resolvedBackgroundMode,
            lightingMode: resolvedLightingMode,
            environmentRef: env,
            bindings,
            preservedCharacterLabels,
            prompt: buildStage4FramePrompt({
              project,
              frame,
              totalFrames: state.frames.length,
              bindings,
              preservedLabels: preservedCharacterLabels,
              env,
              isTemporalReprocess: true,
            }),
            projectId: project.id,
            projectName: project.name,
          },
        });
        frame.ssimVsSource = await computeImageSimilaritySsim(
          frame.sourceFramePath,
          frame.editedFramePath
        );
        frame.temporalSimilarityToPrev = await computeImageSimilaritySsim(
          prevEdited,
          frame.editedFramePath
        );
        frame.status = 'reprocessed';
        reprocessedCount += 1;
      } catch {
        if (looksFlickery) temporalFlickerDetected = true;
      }
    }
  }

  const uneditedFrames = state.frames.filter(
    (f) => f.ssimVsSource !== null && f.ssimVsSource !== undefined && f.ssimVsSource >= 0.992
  );
  const sampleIdx = [
    0,
    Math.floor(state.frames.length / 2),
    Math.max(0, state.frames.length - 1),
  ].filter((v, idx, arr) => arr.indexOf(v) === idx && state.frames[v]?.editedFramePath);

  let aiQc: Awaited<ReturnType<typeof inspectSegmentCharacterReplacementQC>> | null = null;
  if (sampleIdx.length > 0 && (mappedCharacterPairs.length > 0 || refChars.length > 0)) {
    try {
      const avgSsim =
        state.frames
          .map((f) => f.ssimVsSource)
          .filter((v): v is number => typeof v === 'number')
          .reduce((a, b) => a + b, 0) / Math.max(1, state.frames.length);

      aiQc = await inspectSegmentCharacterReplacementQC({
        sourceFramePaths: sampleIdx.map((idx) => state.frames[idx].sourceFramePath),
        generatedFramePaths: sampleIdx.map((idx) => state.frames[idx].editedFramePath!),
        characterRefs: refChars,
        mappedCharacterPairs,
        replacementScope: resolvedScope,
        ssimSimilarity: Number.isFinite(avgSsim) ? avgSsim : null,
        projectId: project.id,
        projectName: project.name,
      });
    } catch {
      aiQc = null;
    }
  }

  const qcIssues: string[] = [...(aiQc?.failureReasons ?? [])];
  if (uneditedFrames.length > 0) {
    qcIssues.push(
      `${uneditedFrames.length} edited frame(s) remained nearly identical to original source frames (SSIM >= 0.992).`
    );
  }
  if (temporalFlickerDetected) {
    qcIssues.push('Severe temporal flicker detected between consecutive frames after reprocess.');
  }

  const qcRejected =
    uneditedFrames.length > 0 ||
    (aiQc?.checked === true &&
      (!aiQc.consistent ||
        aiQc.originalFaceStillPresent === true ||
        aiQc.anatomicalValid === false));

  project.qcSummary = {
    passed: !qcRejected,
    inspectedFrames: state.frames.length,
    originalFaceStillPresent:
      uneditedFrames.length > 0 || Boolean(aiQc?.originalFaceStillPresent),
    minIdentityScore: aiQc?.identityScore ?? null,
    anatomicalValid: aiQc?.anatomicalValid ?? true,
    motionMatched: aiQc?.motionMatched ?? true,
    temporalFlickerDetected: Boolean(aiQc?.temporalFlicker || temporalFlickerDetected),
    backgroundDamaged: Boolean(aiQc?.backgroundDamaged),
    playableVerified: false,
    issues: qcIssues,
    checkedAt: new Date().toISOString(),
  };

  if (qcRejected) {
    const qcMsg = `Stage 5 Character Replacement QA failed: ${qcIssues.join(' ')}`;
    project.status = 'partial_failure';
    project.currentStage = 'stage_5_temporal_consistency';
    project.diagnosticDetail = {
      stage: 'stage_5_temporal_consistency',
      provider: project.selectedModels.videoProvider,
      model: project.selectedModels.videoModel,
      httpStatus: 422,
      failureCategory: 'qc_failed',
      userMessage: qcMsg,
      technicalError: qcMsg,
      timestamp: new Date().toISOString(),
    };
    project.errorMessage = qcMsg;
    project.statusMessage = qcMsg;
    appendLog(project, 'stage_5_temporal_consistency', qcMsg, 'error');
    emitProjectUpdate(project);
    return;
  }

  state.lastCompletedStageNumber = Math.max(state.lastCompletedStageNumber, 5);
  markStageCompleted(project, 'stage_5_temporal_consistency');
  appendLog(
    project,
    'stage_5_temporal_consistency',
    `Stage 5 passed across ${state.frames.length} frames (${reprocessedCount} temporal outlier frame(s) smoothed).`,
    'success'
  );
  emitProjectUpdate(project);

  if (isCancelled(projectId)) return;

  // =========================================================================
  // STAGE 6: VIDEO RECONSTRUCTION & FINAL MP4 VERIFICATION
  // =========================================================================
  project.currentStage = 'stage_6_video_reconstruction';
  project.progressPercent = 90;
  project.statusMessage =
    'Stage 6/6: Reassembling processed frames with exact timestamps & synced audio into MP4...';
  emitProjectUpdate(project);

  let generatedScorePath: string | null = null;
  if (
    project.billingMode === 'paid' &&
    (project.audioMode === 'generate_score' ||
      project.audioMode === 'replace_ambient_sfx')
  ) {
    const lyriaPath = path.join(projectDir, 'lyria_score.mp3');
    try {
      const mood =
        project.blueprint?.audioDesignPlan?.musicMood || 'Atmospheric cinematic film score';
      await generateMusicWithLyria(`Create a cinematic film soundtrack matching: ${mood}.`, lyriaPath, {
        projectId: project.id,
        projectName: project.name,
      });
      generatedScorePath = lyriaPath;
      project.selectedModels.audioModel = 'lyria-3-clip-preview';
    } catch {
      generatedScorePath = null;
    }
  }

  const finalMp4Name = `${project.id}_final_${project.resolution}.mp4`;
  const finalAudioName = `${project.id}_audio.mp3`;
  const finalMp4Path = path.join(projectDir, finalMp4Name);
  const finalAudioPath = path.join(projectDir, finalAudioName);

  await assembleFramesToVideo({
    frames: state.frames
      .filter((f) => Boolean(f.editedFramePath))
      .map((f) => ({ path: f.editedFramePath!, timestampSec: f.timestampSec })),
    totalDurationSec: sourceProbe.durationSec,
    targetFps: Math.max(12, Math.min(30, Math.round(sourceProbe.fps || 24))),
    outputPath: finalMp4Path,
    audioOutputPath: finalAudioPath,
    resolution: project.resolution,
    aspectRatio: project.aspectRatio,
    sourceWidth: sourceProbe.width,
    sourceHeight: sourceProbe.height,
    audioMode: project.audioMode,
    originalAudioPath: state.sourceAudioPath,
    generatedScorePath,
    cinematicGrade: resolvedLightingMode === 'enhance',
  });

  if (!fs.existsSync(finalMp4Path) || fs.statSync(finalMp4Path).size < 1024) {
    throw new Error('Stage 6 reconstructed MP4 output file is missing or empty.');
  }

  const finalPlayable = await verifyPlayableVideo(finalMp4Path);
  if (!finalPlayable) {
    throw new Error('Stage 6 reconstructed MP4 failed FFmpeg playback verification.');
  }

  const finalSsim = await computeVideoSimilaritySsim(
    project.sourceVideo.filePath,
    finalMp4Path
  );
  if (finalSsim !== null && finalSsim >= 0.96) {
    const msg = `Stage 6 QA rejected output video because final SSIM=${finalSsim.toFixed(3)} is too close to the unedited source video.`;
    project.qcSummary.passed = false;
    project.qcSummary.originalFaceStillPresent = true;
    project.qcSummary.issues.push(msg);
    throw new Error(msg);
  }

  const probedFinal = await probeVideo(finalMp4Path);
  project.qcSummary.playableVerified = true;
  state.lastCompletedStageNumber = 6;
  project.outputVideoPath = finalMp4Path;
  project.outputVideoUrl = `/storage/projects/${project.id}/${finalMp4Name}`;
  project.outputAudioPath = fs.existsSync(finalAudioPath) ? finalAudioPath : null;
  project.outputAudioUrl = fs.existsSync(finalAudioPath)
    ? `/storage/projects/${project.id}/${finalAudioName}`
    : null;

  project.outputVideoMetadata = {
    width: probedFinal.width,
    height: probedFinal.height,
    durationSec: probedFinal.durationSec,
    fileSizeBytes: probedFinal.fileSizeBytes,
    codec: probedFinal.codec,
    hasAudio: probedFinal.hasAudio,
    isNative1080p: project.resolution === '1080p',
    verifiedPlayable: true,
  };

  project.usageStats.generatedSeconds = Math.round(probedFinal.durationSec);
  markStageCompleted(project, 'stage_6_video_reconstruction');
  markStageCompleted(project, 'validating_output');
  markStageCompleted(project, 'completed');
  project.currentStage = 'completed';
  project.status = 'completed';
  project.progressPercent = 100;
  project.progressIsEstimate = false;
  project.estimatedRemainingSec = 0;
  project.diagnosticDetail = null;
  project.errorMessage = null;
  project.statusMessage = `6-Stage Character Replacement complete & verified playable via ${project.selectedModels.videoProvider} (${project.selectedModels.videoModel}).`;

  appendLog(
    project,
    'completed',
    `Stage 6 complete: Reconstructed playable ${probedFinal.width}x${probedFinal.height} MP4 (${probedFinal.durationSec}s, ${(probedFinal.fileSizeBytes / 1024 / 1024).toFixed(2)} MB).`,
    'success'
  );

  recordUsageEntry({
    id: `usage_${Date.now()}`,
    projectId: project.id,
    projectName: project.name,
    timestamp: new Date().toISOString(),
    provider: project.selectedModels.videoProvider,
    model: project.selectedModels.videoModel,
    operation: '6-Stage Character Replacement Pipeline',
    billingMode: project.billingMode,
    status: 'succeeded',
    segmentsCount: state.frames.length,
    secondsGenerated: Math.round(probedFinal.durationSec),
    creditsConsumed: state.frames.length,
    estimatedCostUsd: project.usageStats.estimatedCostUsd,
  });

  emitProjectUpdate(project);
}

export async function runProjectPipeline(projectId: string): Promise<void> {
  if (activeRuns.has(projectId)) return;
  cancelledJobs.delete(projectId);
  activeRuns.add(projectId);

  let activeProviderName = 'Orchestrator';
  let activeModelName = 'pending';

  try {
    let project = getProject(projectId);
    if (!project) return;

    if (project.billingMode === 'paid' && !project.paidConfirmed) {
      project.status = 'awaiting_paid_confirmation';
      project.statusMessage =
        'Waiting for explicit user confirmation before invoking paid video/music models.';
      emitProjectUpdate(project);
      return;
    }

    if (!project.sourceVideo?.filePath || !fs.existsSync(project.sourceVideo.filePath)) {
      const err = new Error(
        'Uploaded source video is no longer available on disk. Please upload the video again.'
      );
      const diag = classifyPipelineError(err, {
        stage: 'uploading',
        provider: 'Server Storage',
      });
      project.status = 'failed';
      project.currentStage = 'failed';
      project.diagnosticDetail = diag;
      project.errorMessage = diag.userMessage;
      project.statusMessage = diag.userMessage;
      appendLog(project, 'uploading', diag.technicalError, 'error');
      emitProjectUpdate(project);
      return;
    }

    project.qcSummary = null;
    project.status = 'queued';
    project.currentStage = 'queued';
    project.errorMessage = null;
    project.diagnosticDetail = null;
    project.statusMessage = 'Job queued in Smart Job Queue...';
    emitProjectUpdate(project);

    if (project.segments.length === 0 || !project.blueprint) {
      project = await runProjectAnalysis(projectId);
    }

    if (isCancelled(projectId)) return;

    const refChars = project.characterIds
      .map((id) => getCharacter(id))
      .filter((c): c is CharacterAsset => Boolean(c));
    const { mappedPairs: mappedCharacterPairs, preservedLabels: preservedCharacterLabels } =
      resolveMappedCharacters(project, refChars);
    const isReplacementTask = isCharacterReplacementMode(
      project.mode,
      mappedCharacterPairs.length > 0 || refChars.length > 0
    );
    const requiresMultiCharacter = mappedCharacterPairs.length > 1;

    project.status = 'processing';
    project.errorMessage = null;
    project.diagnosticDetail = null;

    // Stage: Connecting to AI provider & Selecting Model
    project.currentStage = 'connecting_provider';
    project.progressPercent = 30;
    project.providerProgressAvailable = false;
    project.statusMessage = 'Connecting to AI provider adapters & checking available free quotas...';
    emitProjectUpdate(project);
    markStageCompleted(project, 'connecting_provider');

    project.currentStage = 'selecting_model';
    project.progressPercent = 32;
    project.statusMessage = isReplacementTask
      ? 'Checking connected V2V reference-conditioned character replacement models...'
      : 'Evaluating connected providers & selecting optimal free/authorized model...';
    emitProjectUpdate(project);

    const candidates = selectCandidateModels({
      billingMode: project.billingMode,
      mode: project.mode,
      resolution: project.resolution,
      hasCharacterRef: mappedCharacterPairs.length > 0 || refChars.length > 0,
      requiresCharacterReplacement: isReplacementTask,
      requiresMultiCharacter,
    });

    const stage4Candidates = isReplacementTask
      ? selectStage4ImageEditCandidates({
          billingMode: project.billingMode,
          replacementScope: project.replacementScope ?? 'full_character_replacement',
          resolution: project.resolution,
          requiresMultiCharacter,
        })
      : [];

    // Route all character replacement tasks through the 6-Stage Modular Frame Pipeline
    // whenever either a Stage 4 image-editing backend is available OR native V2V is unavailable
    // (or when resuming an existing multi-stage pipeline state).
    const useMultiStagePipeline =
      isReplacementTask &&
      (project.pipelineState?.workflowType === 'multistage_frame_replacement' ||
        stage4Candidates.length > 0 ||
        candidates.length === 0 ||
        project.sourceVideo.durationSec > 15);

    if (useMultiStagePipeline) {
      markStageCompleted(project, 'connecting_provider');
      markStageCompleted(project, 'selecting_model');
      await runMultiStageCharacterPipeline({
        projectId,
        project,
        refChars,
        mappedCharacterPairs,
        preservedCharacterLabels,
      });
      return;
    }

    if (candidates.length > 0) {
      const top = candidates[0];
      activeProviderName = top.provider.displayName;
      activeModelName = top.model.id;
      project.selectedModels.videoProvider = top.provider.displayName;
      project.selectedModels.videoModel = top.model.id;
      project.selectedModels.selectionReason = top.reason;
      appendLog(
        project,
        'selecting_model',
        `Selected ${top.provider.displayName} (${top.model.id}) — ${top.reason}`,
        'info'
      );
    } else if (isReplacementTask) {
      const capReport = inspectTaskCapabilities({
        billingMode: project.billingMode,
        mode: project.mode,
        resolution: project.resolution,
        hasCharacterRef: mappedCharacterPairs.length > 0 || refChars.length > 0,
        replacementScope: project.replacementScope,
        requiresMultiCharacter,
      });
      const msg =
        capReport.blockingReason ||
        'Character replacement requires a Stage 4 image-editing backend or native V2V engine.';
      const diag = classifyPipelineError(new Error(msg), {
        stage: 'selecting_model',
        provider: 'Provider Orchestrator',
      });
      project.selectedModels.videoProvider = 'Unavailable';
      project.selectedModels.videoModel = 'none';
      project.status = 'failed';
      project.currentStage = 'failed';
      project.diagnosticDetail = diag;
      project.errorMessage = diag.userMessage;
      project.statusMessage = diag.userMessage;
      appendLog(project, 'selecting_model', msg, 'error');
      emitProjectUpdate(project);
      return;
    } else if (project.billingMode === 'free') {
      if (project.freeFallbackPolicy === 'require_generative_free') {
        const msg =
          'No connected provider currently exposes active free generative video synthesis (unsupported_video_generation). Add HF_TOKEN in Settings > Secrets, or switch Fallback Policy to FFmpeg Mastering, or confirm Paid Mode.';
        const diag = classifyPipelineError(new Error(msg), {
          stage: 'selecting_model',
          provider: 'Provider Orchestrator',
        });
        project.status = 'failed';
        project.currentStage = 'failed';
        project.diagnosticDetail = diag;
        project.errorMessage = diag.userMessage;
        project.statusMessage = diag.userMessage;
        appendLog(project, 'selecting_model', msg, 'error');
        emitProjectUpdate(project);
        return;
      }
      activeProviderName = 'Local FFmpeg Engine';
      activeModelName = 'ffmpeg-free-mastering';
      project.selectedModels.videoProvider = activeProviderName;
      project.selectedModels.videoModel = activeModelName;
      project.selectedModels.selectionReason =
        'No free external video synthesis token configured; executing Gemini 4 Hydrogen analysis + FFmpeg HD mastering (non-character mode).';
      appendLog(
        project,
        'selecting_model',
        'No free generative video provider connected (e.g. HF_TOKEN). Running Free Mode Gemini analysis + FFmpeg HD mastering.',
        'warning'
      );
    } else {
      const msg =
        'Paid Mode is selected, but no enabled paid video provider has a configured server secret (e.g. GEMINI_API_KEY, FAL_KEY, REPLICATE_API_TOKEN, RUNWAYML_API_SECRET, or LUMA_API_KEY).';
      const diag = classifyPipelineError(new Error(msg), {
        stage: 'selecting_model',
        provider: 'Provider Orchestrator',
      });
      project.status = 'failed';
      project.currentStage = 'failed';
      project.diagnosticDetail = diag;
      project.errorMessage = diag.userMessage;
      project.statusMessage = diag.userMessage;
      appendLog(project, 'selecting_model', msg, 'error');
      emitProjectUpdate(project);
      return;
    }

    markStageCompleted(project, 'selecting_model');
    emitProjectUpdate(project);

    const projectDir = path.join(PROJECTS_DIR, project.id);
    const outSegDir = path.join(projectDir, 'generated_segments');
    const checkFramesDir = path.join(projectDir, 'consistency_frames');
    fs.mkdirSync(outSegDir, { recursive: true });
    fs.mkdirSync(checkFramesDir, { recursive: true });

    const env = project.environmentId ? getEnvironment(project.environmentId) : null;
    const resolvedScope: ReplacementScope =
      project.replacementScope ?? 'full_character_replacement';
    const resolvedBackgroundMode =
      project.backgroundMode ?? (project.environmentId ? 'use_env_ref' : 'preserve');
    const resolvedLightingMode = project.lightingMode ?? 'preserve';

    // Stage: Submitting request + Generating segments
    project.currentStage = 'submitting_request';
    project.progressPercent = 34;
    project.statusMessage =
      candidates.length > 0
        ? `Submitting generation request(s) to ${project.selectedModels.videoProvider}...`
        : 'Preparing FFmpeg segment processing pipeline...';
    emitProjectUpdate(project);

    const total = project.segments.length;
    let markedSubmitDone = false;

    for (let i = 0; i < total; i++) {
      if (isCancelled(projectId)) return;

      const seg = project.segments[i];
      if (
        seg.status === 'completed' &&
        seg.outputSegmentPath &&
        fs.existsSync(seg.outputSegmentPath) &&
        (await verifyPlayableVideo(seg.outputSegmentPath)) &&
        (!isReplacementTask || seg.consistencyCheck?.consistent !== false)
      ) {
        continue;
      }

      seg.status = 'processing';
      seg.errorMessage = null;
      const prompt = buildSegmentPrompt(
        project,
        i,
        total,
        mappedCharacterPairs,
        preservedCharacterLabels,
        env?.description ?? null
      );
      seg.promptUsed = prompt;

      project.currentStage = 'generating_segments';
      project.progressPercent = Math.round(36 + (i / total) * 38);
      project.progressIsEstimate = true;
      project.providerProgressAvailable = false;
      project.estimatedRemainingSec =
        candidates.length > 0 ? (total - i) * 35 : (total - i) * 2;
      project.statusMessage =
        candidates.length > 0
          ? `Generating video segment ${i + 1} of ${total} (${activeProviderName})...`
          : `Mastering segment ${i + 1} of ${total} in Free Mode (FFmpeg pipeline)...`;
      emitProjectUpdate(project);

      const outSegFile = `gen_seg_${i}.mp4`;
      const outSegPath = path.join(outSegDir, outSegFile);

      try {
        if (candidates.length > 0) {
          const genRes = await generateSegmentWithFailover({
            billingMode: project.billingMode,
            mode: project.mode,
            resolution: project.resolution,
            requiresCharacterReplacement: isReplacementTask,
            requiresMultiCharacter,
            preferredProviderName: seg.providerUsed !== 'pending' ? seg.providerUsed : undefined,
            requestBase: {
              sourceSegmentPath: seg.sourceSegmentPath,
              keyframePath: seg.keyframePath,
              outSegmentPath: outSegPath,
              durationSec: seg.durationSec,
              aspectRatio: project.aspectRatio,
              sourceWidth: project.sourceVideo.width,
              sourceHeight: project.sourceVideo.height,
              resolution: project.resolution,
              qualityTier: project.qualityTier,
              characterRefs: refChars,
              mappedCharacterPairs,
              preservedCharacterLabels,
              replacementScope: resolvedScope,
              backgroundMode: resolvedBackgroundMode,
              lightingMode: resolvedLightingMode,
              environmentRef: env,
              prompt,
              existingProviderJobId: seg.providerJobId ?? null,
              projectId: project.id,
              projectName: project.name,
              isCancelled: () => isCancelled(projectId),
              onJobCreated: (jobId) => {
                seg.providerJobId = jobId;
                seg.providerJobStatus = 'submitted';
                if (!markedSubmitDone) {
                  markStageCompleted(project!, 'submitting_request');
                  markedSubmitDone = true;
                }
                appendLog(
                  project!,
                  'submitting_request',
                  `Segment ${i + 1}: Created async provider job ${jobId}. Monitoring progress...`,
                  'info'
                );
                emitProjectUpdate(project!);
              },
              onPollProgress: (providerStatus, pollCount) => {
                seg.providerJobStatus = `${providerStatus} (poll #${pollCount})`;
                project!.statusMessage = `Generating video segment ${i + 1} of ${total} · Provider status: ${providerStatus} (check #${pollCount})`;
                emitProjectUpdate(project!);
              },
            },
            onAttemptStart: (provName, modId) => {
              activeProviderName = provName;
              activeModelName = modId;
              seg.providerUsed = provName;
              seg.modelUsed = modId;
            },
            onAttemptLog: (msg, level) => {
              appendLog(project!, 'generating_segments', msg, level);
              emitProjectUpdate(project!);
            },
            onFailedAttempt: (providerName, modelId, errMsg, httpStatus, jobId) => {
              seg.httpStatusCode = httpStatus;
              if (jobId) seg.providerJobId = jobId;
              recordUsageEntry({
                id: `usage_fail_${Date.now()}_${i}`,
                projectId: project!.id,
                projectName: project!.name,
                timestamp: new Date().toISOString(),
                provider: providerName,
                model: modelId,
                operation: `Segment ${i + 1} Attempt`,
                billingMode: project!.billingMode,
                status: 'failed',
                segmentsCount: 0,
                secondsGenerated: 0,
                creditsConsumed: 0,
                estimatedCostUsd: 0,
                errorMessage: sanitizeSecretText(errMsg),
              });
            },
          });

          if (!markedSubmitDone) {
            markStageCompleted(project, 'submitting_request');
            markedSubmitDone = true;
          }

          seg.providerUsed = genRes.providerName;
          seg.modelUsed = genRes.modelUsed;
          seg.providerJobId = genRes.providerJobId ?? seg.providerJobId ?? null;
          seg.providerJobStatus = 'completed';
          seg.httpStatusCode = 200;
          seg.isNativeResolution = genRes.isNativeResolution;
          seg.outputSegmentPath = outSegPath;
          seg.outputSegmentUrl = `/storage/projects/${project.id}/generated_segments/${outSegFile}`;
          seg.status = 'completed';

          if (
            isReplacementTask &&
            (mappedCharacterPairs.length > 0 || refChars.length > 0)
          ) {
            const sampleTimes = [
              Math.max(0.1, seg.durationSec * 0.15),
              Math.max(0.2, seg.durationSec * 0.5),
              Math.max(0.3, seg.durationSec * 0.85),
            ];
            const segSrcFramesDir = path.join(checkFramesDir, `seg_${i}_src`);
            const segGenFramesDir = path.join(checkFramesDir, `seg_${i}_gen`);
            const [srcFramePaths, genFramePaths, ssim] = await Promise.all([
              extractKeyframes(seg.sourceSegmentPath, sampleTimes, segSrcFramesDir),
              extractKeyframes(outSegPath, sampleTimes, segGenFramesDir),
              computeVideoSimilaritySsim(seg.sourceSegmentPath, outSegPath),
            ]);

            try {
              seg.consistencyCheck = await inspectSegmentCharacterReplacementQC({
                sourceFramePaths: srcFramePaths,
                generatedFramePaths: genFramePaths,
                characterRefs: refChars,
                mappedCharacterPairs,
                replacementScope: resolvedScope,
                ssimSimilarity: ssim,
                projectId: project.id,
                projectName: project.name,
              });
              if (
                seg.consistencyCheck.checked &&
                (!seg.consistencyCheck.consistent ||
                  seg.consistencyCheck.originalFaceStillPresent)
              ) {
                appendLog(
                  project,
                  'verifying_continuity',
                  `Segment ${i + 1} failed Character Replacement QC: ${seg.consistencyCheck.notes}`,
                  'warning'
                );
              }
            } catch {
              seg.consistencyCheck = {
                checked: false,
                consistent: true,
                needsReview: true,
                checkedFramesCount: genFramePaths.length,
                failureReasons: [
                  'AI multi-frame QC could not run due to transient/quota error — inspect preview manually.',
                ],
                notes: 'Multi-frame QC skipped due to API quota/transient limit.',
              };
            }
          } else {
            seg.consistencyCheck = {
              checked: false,
              consistent: true,
              needsReview: false,
              checkedFramesCount: 0,
              notes: 'Character replacement QC not applicable for non-character mode.',
            };
          }

          project.usageStats.segmentsGenerated += 1;
          project.usageStats.generatedSeconds += Math.round(seg.durationSec);
          project.usageStats.estimatedCostUsd =
            Math.round(
              (project.usageStats.estimatedCostUsd + genRes.estimatedCostUsd) * 100
            ) / 100;
        } else {
          if (!markedSubmitDone) {
            markStageCompleted(project, 'submitting_request');
            markedSubmitDone = true;
          }
          fs.copyFileSync(seg.sourceSegmentPath, outSegPath);
          const segOk = await verifyPlayableVideo(outSegPath);
          if (!segOk) {
            throw new Error(`Segment ${i + 1} failed FFmpeg verification check.`);
          }
          seg.providerUsed = 'Local FFmpeg Engine';
          seg.modelUsed = 'ffmpeg-free-mastering';
          seg.providerJobStatus = 'completed';
          seg.httpStatusCode = 200;
          seg.isNativeResolution =
            project.resolution === '1080p' && project.sourceVideo.height >= 1080;
          seg.outputSegmentPath = outSegPath;
          seg.outputSegmentUrl = `/storage/projects/${project.id}/generated_segments/${outSegFile}`;
          seg.status = 'completed';
          seg.consistencyCheck = {
            checked: false,
            consistent: true,
            needsReview: false,
            notes:
              'Free Mode FFmpeg mastering: source frames preserved with cinematic grading. Connect HF_TOKEN or confirm Paid Mode for generative character synthesis.',
          };
        }
      } catch (err) {
        const diag = classifyPipelineError(err, {
          stage: 'generating_segments',
          provider: activeProviderName,
          model: activeModelName,
          providerJobId: seg.providerJobId,
        });
        seg.status = 'failed';
        seg.providerJobStatus = 'failed';
        seg.httpStatusCode = diag.httpStatus ?? extractHttpStatusFromError(err);
        seg.errorMessage = diag.userMessage;
        project.diagnosticDetail = diag;
        appendLog(
          project,
          'generating_segments',
          `Segment ${i + 1} failed (${diag.provider}${diag.httpStatus ? ` HTTP ${diag.httpStatus}` : ''}): ${diag.technicalError}`,
          'error'
        );
      }
      emitProjectUpdate(project);
    }

    if (isCancelled(projectId)) return;

    const failedSegs = project.segments.filter((s) => s.status === 'failed');
    if (failedSegs.length > 0) {
      project.status = 'partial_failure';
      project.currentStage = 'failed';
      project.errorMessage =
        project.diagnosticDetail?.userMessage ||
        `${failedSegs.length} segment(s) failed. Retry failed segments individually without losing completed work.`;
      project.statusMessage = project.errorMessage;
      emitProjectUpdate(project);
      return;
    }

    markStageCompleted(project, 'generating_segments');
    project.currentStage = 'verifying_continuity';
    project.progressPercent = 76;
    project.statusMessage =
      'Running multi-frame character replacement Quality Control & identity inspection...';

    // Aggregate QC summary across all segments
    const inspectedFrames = project.segments.reduce(
      (sum, s) => sum + (s.consistencyCheck?.checkedFramesCount ?? 0),
      0
    );
    const anyOriginalFaceStillPresent = project.segments.some(
      (s) => s.consistencyCheck?.originalFaceStillPresent === true
    );
    const scores = project.segments
      .map((s) => s.consistencyCheck?.identityScore)
      .filter((v): v is number => typeof v === 'number');
    const minIdentityScore = scores.length > 0 ? Math.min(...scores) : null;
    const qcIssues: string[] = [];
    for (const s of project.segments) {
      if (s.consistencyCheck?.failureReasons) {
        for (const r of s.consistencyCheck.failureReasons) {
          if (!qcIssues.includes(r)) qcIssues.push(r);
        }
      }
    }

    const qcFailed =
      isReplacementTask &&
      project.segments.some(
        (s) =>
          s.consistencyCheck?.checked &&
          (!s.consistencyCheck.consistent ||
            s.consistencyCheck.originalFaceStillPresent === true)
      );

    const qcSummary: ProjectQcSummary = {
      passed: !qcFailed,
      inspectedFrames,
      originalFaceStillPresent: anyOriginalFaceStillPresent,
      minIdentityScore,
      issues: qcIssues,
      checkedAt: new Date().toISOString(),
    };
    project.qcSummary = qcSummary;

    if (qcFailed) {
      const qcMsg = `Character replacement Quality Control failed across ${inspectedFrames} inspected frame(s): ${qcIssues.join(' ') || 'Original character remained visible or target reference identity did not transfer.'}`;
      project.status = 'partial_failure';
      project.currentStage = 'failed';
      project.diagnosticDetail = {
        stage: 'verifying_continuity',
        provider: project.selectedModels.videoProvider,
        model: project.selectedModels.videoModel,
        httpStatus: null,
        failureCategory: 'qc_failed',
        userMessage: qcMsg,
        technicalError: qcMsg,
        timestamp: new Date().toISOString(),
      };
      project.errorMessage = qcMsg;
      project.statusMessage = qcMsg;
      appendLog(project, 'verifying_continuity', qcMsg, 'error');
      emitProjectUpdate(project);
      return;
    }

    markStageCompleted(project, 'verifying_continuity');
    emitProjectUpdate(project);

    // Stage: Audio Processing
    project.currentStage = 'processing_audio';
    project.progressPercent = 82;
    project.estimatedRemainingSec = 8;
    project.statusMessage = 'Processing audio, dialogue & sound design...';
    emitProjectUpdate(project);

    const origAudioPath = path.join(projectDir, 'original_audio.mp3');
    if (project.sourceVideo.hasAudio && !fs.existsSync(origAudioPath)) {
      await extractAudioTrack(project.sourceVideo.filePath, origAudioPath);
    }

    let generatedScorePath: string | null = null;
    if (
      project.billingMode === 'paid' &&
      (project.audioMode === 'generate_score' ||
        project.audioMode === 'replace_ambient_sfx')
    ) {
      const lyriaPath = path.join(projectDir, 'lyria_score.mp3');
      try {
        const mood =
          project.blueprint?.audioDesignPlan?.musicMood ||
          'Atmospheric cinematic film score';
        await generateMusicWithLyria(
          `Create a cinematic film soundtrack matching: ${mood}.`,
          lyriaPath,
          { projectId: project.id, projectName: project.name }
        );
        generatedScorePath = lyriaPath;
        project.selectedModels.audioModel = 'lyria-3-clip-preview';
        appendLog(
          project,
          'processing_audio',
          'Generated custom score with lyria-3-clip-preview.',
          'success'
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        appendLog(
          project,
          'processing_audio',
          `Optional Lyria score skipped: ${msg}. Using preserved audio track.`,
          'warning'
        );
      }
    }
    markStageCompleted(project, 'processing_audio');

    if (isCancelled(projectId)) return;

    // Stage: Rendering Final Video
    project.currentStage = 'joining_segments';
    project.progressPercent = 88;
    project.estimatedRemainingSec = 6;
    project.statusMessage = `Joining segments & rendering final ${project.resolution} MP4...`;
    emitProjectUpdate(project);

    const finalMp4Name = `${project.id}_final_${project.resolution}.mp4`;
    const finalAudioName = `${project.id}_audio.mp3`;
    const finalMp4Path = path.join(projectDir, finalMp4Name);
    const finalAudioPath = path.join(projectDir, finalAudioName);

    const segPathsToJoin = project.segments
      .map((s) => s.outputSegmentPath)
      .filter((p): p is string => Boolean(p));

    markStageCompleted(project, 'joining_segments');
    project.currentStage = 'encoding_final';
    project.progressPercent = 93;
    project.statusMessage = `Encoding H.264 / AAC ${project.resolution} MP4...`;
    emitProjectUpdate(project);

    await assembleFinalVideo({
      segmentPaths: segPathsToJoin,
      outputPath: finalMp4Path,
      audioOutputPath: finalAudioPath,
      resolution: project.resolution,
      aspectRatio: project.aspectRatio,
      sourceWidth: project.sourceVideo.width,
      sourceHeight: project.sourceVideo.height,
      fps: project.sourceVideo.fps,
      audioMode: project.audioMode,
      originalAudioPath: fs.existsSync(origAudioPath) ? origAudioPath : null,
      generatedScorePath,
      cinematicGrade:
        resolvedLightingMode === 'enhance' && project.mode !== 'character_replacement',
    });

    markStageCompleted(project, 'encoding_final');

    // Stage: Validating Final MP4 & Preparing Download (NEVER show 100% before this passes!)
    project.currentStage = 'validating_output';
    project.progressPercent = 97;
    project.statusMessage =
      'Preparing download: verifying final MP4 file integrity and playback streams...';
    emitProjectUpdate(project);

    if (!fs.existsSync(finalMp4Path) || fs.statSync(finalMp4Path).size < 1024) {
      throw new Error(
        'Final MP4 output file is missing or empty (< 1 KB).'
      );
    }

    const finalPlayable = await verifyPlayableVideo(finalMp4Path);
    if (!finalPlayable) {
      throw new Error(
        'Final MP4 failed FFmpeg playback verification and may be corrupted.'
      );
    }

    const probedFinal = await probeVideo(finalMp4Path);
    const allSegmentsNative108 = project.segments.every(
      (s) => s.isNativeResolution
    );

    project.outputVideoPath = finalMp4Path;
    project.outputVideoUrl = `/storage/projects/${project.id}/${finalMp4Name}`;
    project.outputAudioPath = fs.existsSync(finalAudioPath) ? finalAudioPath : null;
    project.outputAudioUrl = fs.existsSync(finalAudioPath)
      ? `/storage/projects/${project.id}/${finalAudioName}`
      : null;

    project.outputVideoMetadata = {
      width: probedFinal.width,
      height: probedFinal.height,
      durationSec: probedFinal.durationSec,
      fileSizeBytes: probedFinal.fileSizeBytes,
      codec: probedFinal.codec,
      hasAudio: probedFinal.hasAudio,
      isNative1080p:
        project.resolution === '1080p' ? allSegmentsNative108 : false,
      verifiedPlayable: true,
    };

    markStageCompleted(project, 'validating_output');
    markStageCompleted(project, 'completed');
    project.currentStage = 'completed';
    project.status = 'completed';
    project.progressPercent = 100;
    project.progressIsEstimate = false;
    project.estimatedRemainingSec = 0;
    project.diagnosticDetail = null;
    project.errorMessage = null;
    project.statusMessage =
      candidates.length > 0
        ? `Verified playable MP4 ready via ${project.selectedModels.videoProvider} (${project.selectedModels.videoModel}).`
        : 'Free Mode Gemini analysis + FFmpeg HD/Full HD MP4 verified & ready to download.';

    appendLog(
      project,
      'completed',
      `Verified & exported playable ${probedFinal.width}x${probedFinal.height} MP4 (${probedFinal.durationSec}s, ${(probedFinal.fileSizeBytes / 1024 / 1024).toFixed(2)} MB).`,
      'success'
    );

    recordUsageEntry({
      id: `usage_${Date.now()}`,
      projectId: project.id,
      projectName: project.name,
      timestamp: new Date().toISOString(),
      provider: project.selectedModels.videoProvider,
      model: project.selectedModels.videoModel,
      operation:
        candidates.length > 0
          ? 'Multi-Provider AI Video Synthesis'
          : 'Gemini Analysis + FFmpeg Master',
      billingMode: project.billingMode,
      status: 'succeeded',
      segmentsCount: project.segments.length,
      secondsGenerated: Math.round(probedFinal.durationSec),
      creditsConsumed: candidates.length > 0 ? project.segments.length : 0,
      estimatedCostUsd: project.usageStats.estimatedCostUsd,
    });

    emitProjectUpdate(project);
  } catch (err) {
    const project = getProject(projectId);
    if (project && project.status !== 'cancelled') {
      const diag = classifyPipelineError(err, {
        stage: project.currentStage || 'failed',
        provider: activeProviderName,
        model: activeModelName,
      });
      project.status = 'failed';
      project.currentStage = 'failed';
      project.diagnosticDetail = diag;
      project.errorMessage = diag.userMessage;
      project.statusMessage = diag.userMessage;
      appendLog(project, 'failed', diag.technicalError, 'error');
      emitProjectUpdate(project);
    }
  } finally {
    activeRuns.delete(projectId);
    cancelledJobs.delete(projectId);
  }
}

export async function retrySingleSegment(
  projectId: string,
  segmentIndex: number
): Promise<void> {
  const project = getProject(projectId);
  if (!project) throw new Error('Project not found.');
  const seg = project.segments.find((s) => s.index === segmentIndex);
  if (!seg) throw new Error('Segment not found.');

  seg.status = 'pending';
  seg.errorMessage = null;
  seg.consistencyCheck = null;
  seg.providerJobStatus = null;
  if (seg.outputSegmentPath && fs.existsSync(seg.outputSegmentPath)) {
    fs.rmSync(seg.outputSegmentPath, { force: true });
  }
  seg.outputSegmentPath = null;
  seg.outputSegmentUrl = null;
  project.errorMessage = null;
  project.diagnosticDetail = null;
  saveProject(project);

  void runProjectPipeline(projectId);
}
