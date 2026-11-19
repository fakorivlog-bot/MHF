import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Cpu,
  Download,
  Film,
  Image as ImageIcon,
  Loader2,
  Music,
  Play,
  RefreshCw,
  ShieldCheck,
  SlidersHorizontal,
  Terminal,
  Upload,
  UserCheck,
  Video,
  X,
  XCircle,
} from 'lucide-react';
import {
  ApiRequestError,
  analyzeProject,
  cancelQueuedJob,
  createProject,
  fetchModelSelectionPreview,
  fetchProject,
  retryProjectSegment,
  startProjectRun,
  updateProject,
  uploadCharacter,
  uploadEnvironment,
  uploadVideoWithProgress,
  verifyVideoDownloadAvailable,
  type VideoUploadPhase,
} from '../api';
import { type AppLocale, STRINGS } from '../i18n';
import type {
  AudioMode,
  BackgroundMode,
  BillingMode,
  CharacterAsset,
  EnvironmentAsset,
  ErrorDiagnosticDetail,
  FreeModeFallbackPolicy,
  LightingMode,
  OutputAspectRatio,
  OutputResolution,
  ProjectRecord,
  QualityTier,
  ReplacementScope,
  TaskCapabilityPreview,
  TransformationMode,
  VideoMetadata,
} from '../types';

interface CreateStudioViewProps {
  locale: AppLocale;
  characters: CharacterAsset[];
  environments: EnvironmentAsset[];
  activeProject: ProjectRecord | null;
  preselectedCharacterId: string | null;
  preselectedEnvironmentId: string | null;
  onRefreshAssets: () => void;
  onProjectChange: (proj: ProjectRecord | null) => void;
}

const PROCESSING_STAGES: Array<{ key: string; label: string }> = [
  { key: 'uploading', label: '1. Uploading video to server' },
  { key: 'upload_completed', label: '2. Upload verified & stored' },
  { key: 'analyzing_scenes', label: '3. Analyzing scenes & boundaries' },
  { key: 'detecting_characters', label: '4. Detecting & matching characters' },
  { key: 'preparing_references', label: '5. Preparing identity & prompt blueprint' },
  { key: 'connecting_provider', label: '6. Connecting to AI provider' },
  { key: 'selecting_model', label: '7. Selecting best eligible model' },
  { key: 'submitting_request', label: '8. Submitting generation request' },
  { key: 'generating_segments', label: '9. Generating / mastering video segments' },
  { key: 'verifying_continuity', label: '10. Verifying identity consistency' },
  { key: 'processing_audio', label: '11. Processing dialogue, music & SFX' },
  { key: 'joining_segments', label: '12. Joining video segments' },
  { key: 'encoding_final', label: '13. Encoding final HD/Full HD MP4' },
  { key: 'validating_output', label: '14. Verifying playable MP4 & download' },
];

const MULTI_STAGE_STEPS: Array<{ key: string; label: string }> = [
  { key: 'stage_1_ingestion', label: 'Stage 1 · Video Ingestion & Validation' },
  { key: 'stage_2_frame_extraction', label: 'Stage 2 · Timestamp Frame Extraction' },
  { key: 'stage_3_character_tracking', label: 'Stage 3 · Character Tracking, Pose & Feather Masks' },
  { key: 'stage_4_character_replacement', label: 'Stage 4 · Reference-Conditioned Frame Replacement' },
  { key: 'stage_5_temporal_consistency', label: 'Stage 5 · Temporal Consistency Repair & 7-Point QA' },
  { key: 'stage_6_video_reconstruction', label: 'Stage 6 · FFmpeg MP4 & Audio Reconstruction' },
];

const MODE_OPTIONS: Array<{
  id: TransformationMode;
  title: string;
  desc: string;
}> = [
  {
    id: 'cinematic_recreation_with_character',
    title: 'Default · Cinematic Recreation + Character Replacement',
    desc: 'Recreate the scene cinematically with preserved motion while replacing the lead character.',
  },
  {
    id: 'character_replacement',
    title: 'Mode A · Character Replacement',
    desc: 'Swap the selected source character with your reference photo while keeping background and framing.',
  },
  {
    id: 'cinematic_recreation',
    title: 'Mode B · Cinematic Recreation',
    desc: 'Recreate camera style, lighting, and movement inspired by the original footage.',
  },
  {
    id: 'environment_transformation',
    title: 'Mode C · Environment Transformation',
    desc: 'Transform location, weather, atmosphere, and lighting while preserving subject action.',
  },
  {
    id: 'creative_transformation',
    title: 'Mode D · Complete Creative Transformation',
    desc: 'Substantially reimagine the film scene guided by your natural-language direction.',
  },
];

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export const CreateStudioView: React.FC<CreateStudioViewProps> = ({
  locale,
  characters,
  environments,
  activeProject,
  preselectedCharacterId,
  preselectedEnvironmentId,
  onRefreshAssets,
  onProjectChange,
}) => {
  const t = STRINGS[locale];
  const videoInputRef = useRef<HTMLInputElement>(null);
  const envVideoInputRef = useRef<HTMLInputElement>(null);
  const charInputRef = useRef<HTMLInputElement>(null);
  const envInputRef = useRef<HTMLInputElement>(null);

  const [projectName, setProjectName] = useState('');
  const [sourceVideo, setSourceVideo] = useState<VideoMetadata | null>(
    activeProject?.sourceVideo ?? null
  );
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [uploadPhase, setUploadPhase] = useState<VideoUploadPhase | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const [selectedCharIds, setSelectedCharIds] = useState<string[]>(() => {
    if (activeProject?.characterIds?.length) return activeProject.characterIds;
    if (preselectedCharacterId) return [preselectedCharacterId];
    return [];
  });
  const [charUploadLoading, setCharUploadLoading] = useState(false);

  const [selectedEnvId, setSelectedEnvId] = useState<string | null>(() => {
    if (activeProject?.environmentId) return activeProject.environmentId;
    return preselectedEnvironmentId ?? null;
  });
  const [envVideo, setEnvVideo] = useState<VideoMetadata | null>(
    activeProject?.environmentVideo ?? null
  );
  const [envUploadLoading, setEnvUploadLoading] = useState(false);
  const [envVideoProgress, setEnvVideoProgress] = useState<number | null>(null);

  const [instruction, setInstruction] = useState(
    activeProject?.instruction ?? ''
  );
  const [mode, setMode] = useState<TransformationMode>(
    activeProject?.mode ?? 'cinematic_recreation_with_character'
  );
  const [replacementScope, setReplacementScope] = useState<ReplacementScope>(
    activeProject?.replacementScope ?? 'full_character_replacement'
  );
  const [backgroundMode, setBackgroundMode] = useState<BackgroundMode>(
    activeProject?.backgroundMode ?? (activeProject?.environmentId ? 'use_env_ref' : 'preserve')
  );
  const [lightingMode, setLightingMode] = useState<LightingMode>(
    activeProject?.lightingMode ?? 'preserve'
  );

  // Advanced settings hidden by default
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [resolution, setResolution] = useState<OutputResolution>(
    activeProject?.resolution ?? '720p'
  );
  const [aspectRatio, setAspectRatio] = useState<OutputAspectRatio>(
    activeProject?.aspectRatio ?? 'original'
  );
  const [qualityTier, setQualityTier] = useState<QualityTier>(
    activeProject?.qualityTier ?? 'economy'
  );
  const [audioMode, setAudioMode] = useState<AudioMode>(
    activeProject?.audioMode ?? 'preserve_dialogue'
  );
  const [billingMode, setBillingMode] = useState<BillingMode>(
    activeProject?.billingMode ?? 'free'
  );
  const [freeFallbackPolicy, setFreeFallbackPolicy] =
    useState<FreeModeFallbackPolicy>(
      activeProject?.freeFallbackPolicy ?? 'ffmpeg_master'
    );

  const [selectionPreview, setSelectionPreview] = useState<
    Array<{
      providerName: string;
      modelId: string;
      score: number;
      reason: string;
      freeTierEligible: boolean;
    }>
  >([]);
  const [capabilityPreview, setCapabilityPreview] =
    useState<TaskCapabilityPreview | null>(null);

  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionDiagnostic, setActionDiagnostic] =
    useState<ErrorDiagnosticDetail | null>(null);
  const [downloadingVideo, setDownloadingVideo] = useState(false);
  const [paidModalOpen, setPaidModalOpen] = useState(false);
  const [paidCheckbox, setPaidCheckbox] = useState(false);
  const [pendingPaidProjectId, setPendingPaidProjectId] = useState<string | null>(null);

  useEffect(() => {
    if (preselectedCharacterId && !selectedCharIds.includes(preselectedCharacterId)) {
      setSelectedCharIds((prev) => [
        preselectedCharacterId,
        ...prev.filter((x) => x !== preselectedCharacterId),
      ]);
    }
  }, [preselectedCharacterId]);

  useEffect(() => {
    if (preselectedEnvironmentId) {
      setSelectedEnvId(preselectedEnvironmentId);
      setBackgroundMode('use_env_ref');
    }
  }, [preselectedEnvironmentId]);

  useEffect(() => {
    if (activeProject) {
      setSourceVideo(activeProject.sourceVideo);
      setProjectName(activeProject.name);
      setSelectedCharIds(activeProject.characterIds);
      setSelectedEnvId(activeProject.environmentId);
      setEnvVideo(activeProject.environmentVideo ?? null);
      setInstruction(activeProject.instruction);
      setMode(activeProject.mode);
      setReplacementScope(
        activeProject.replacementScope ?? 'full_character_replacement'
      );
      setBackgroundMode(
        activeProject.backgroundMode ??
          (activeProject.environmentId ? 'use_env_ref' : 'preserve')
      );
      setLightingMode(activeProject.lightingMode ?? 'preserve');
      setResolution(activeProject.resolution);
      setAspectRatio(activeProject.aspectRatio);
      setQualityTier(activeProject.qualityTier);
      setAudioMode(activeProject.audioMode);
      setBillingMode(activeProject.billingMode);
      setFreeFallbackPolicy(activeProject.freeFallbackPolicy ?? 'ffmpeg_master');
    }
  }, [activeProject?.id]);

  // Live Smart Model Selection & 8-Indicator Pipeline Capability Matrix Preview
  useEffect(() => {
    void fetchModelSelectionPreview({
      billingMode,
      mode,
      resolution,
      replacementScope,
      hasCharacterRef: selectedCharIds.length > 0,
      requiresMultiCharacter: selectedCharIds.length > 1,
    })
      .then((res) => {
        setSelectionPreview(res.candidates);
        setCapabilityPreview(res.capabilities ?? null);
      })
      .catch(() => {
        setSelectionPreview([]);
        setCapabilityPreview(null);
      });
  }, [billingMode, mode, resolution, replacementScope, selectedCharIds.length]);

  // Real-time SSE listener + automatic 2.5s polling fallback for active project
  useEffect(() => {
    if (!activeProject?.id) return;
    const isLive =
      activeProject.status === 'queued' ||
      activeProject.status === 'analyzing' ||
      activeProject.status === 'processing';
    if (!isLive) return;

    let disposed = false;
    const projectId = activeProject.id;

    const syncLatest = async () => {
      try {
        const fresh = await fetchProject(projectId);
        if (!disposed) {
          onProjectChange(fresh);
        }
      } catch {
        // Retry automatically on next poll tick
      }
    };

    const es = new EventSource(`/api/projects/${projectId}/events`);
    es.onmessage = (ev) => {
      if (disposed) return;
      try {
        const updated = JSON.parse(ev.data) as ProjectRecord;
        onProjectChange(updated);
      } catch {
        // ignore malformed heartbeat/message
      }
    };
    es.onerror = () => {
      // Do not give up on proxy timeout — polling continues smoothly
      void syncLatest();
    };

    const pollTimer = window.setInterval(() => {
      void syncLatest();
    }, 2500);

    return () => {
      disposed = true;
      es.close();
      window.clearInterval(pollTimer);
    };
  }, [activeProject?.id, activeProject?.status]);

  const estimatedSegments = useMemo(() => {
    if (!sourceVideo) return 0;
    const segLen = qualityTier === 'economy' ? 8 : 10;
    return Math.max(1, Math.ceil(sourceVideo.durationSec / segLen));
  }, [sourceVideo, qualityTier]);

  const estimatedPaidCost = useMemo(() => {
    if (!sourceVideo || billingMode === 'free') return 0;
    const videoCost = sourceVideo.durationSec * 0.15;
    const audioCost =
      audioMode === 'generate_score' || audioMode === 'replace_ambient_sfx'
        ? 0.08
        : 0;
    return Math.round((videoCost + audioCost) * 100) / 100;
  }, [sourceVideo, billingMode, audioMode]);

  const handleVideoFile = async (file: File) => {
    setUploadError(null);
    setActionError(null);
    setActionDiagnostic(null);
    setUploadProgress(0);
    setUploadPhase('uploading');
    try {
      const meta = await uploadVideoWithProgress(
        file,
        setUploadProgress,
        setUploadPhase
      );
      setSourceVideo(meta);
      if (!projectName) {
        setProjectName(meta.originalName.replace(/\.[^.]+$/, ''));
      }
      onProjectChange(null);
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : String(err));
    } finally {
      setUploadProgress(null);
      setUploadPhase(null);
    }
  };

  const handleEnvVideoFile = async (file: File) => {
    setActionError(null);
    setEnvVideoProgress(0);
    try {
      const meta = await uploadVideoWithProgress(file, setEnvVideoProgress);
      setEnvVideo(meta);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setEnvVideoProgress(null);
    }
  };

  const handleQuickCharUpload = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setCharUploadLoading(true);
    setActionError(null);
    try {
      const fileArr = Array.from(files).slice(0, 4);
      const baseName = fileArr[0].name.replace(/\.[^.]+$/, '');
      const { character } = await uploadCharacter({
        name: baseName || 'Character Reference',
        files: fileArr,
      });
      onRefreshAssets();
      setSelectedCharIds((prev) => [character.id, ...prev]);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setCharUploadLoading(false);
    }
  };

  const handleQuickEnvUpload = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setEnvUploadLoading(true);
    setActionError(null);
    try {
      const file = files[0];
      const baseName = file.name.replace(/\.[^.]+$/, '');
      const created = await uploadEnvironment({
        name: baseName || 'Custom Environment',
        category: 'Uploaded',
        description: `Uploaded environment reference (${baseName})`,
        file,
      });
      onRefreshAssets();
      setSelectedEnvId(created.id);
      setBackgroundMode('use_env_ref');
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setEnvUploadLoading(false);
    }
  };

  const ensureProjectCreated = async (): Promise<ProjectRecord> => {
    if (!sourceVideo) {
      throw new Error('Please upload a source video first.');
    }
    if (
      activeProject &&
      activeProject.sourceVideo.fileName === sourceVideo.fileName
    ) {
      const updated = await updateProject(activeProject.id, {
        name: projectName.trim() || activeProject.name,
        instruction: instruction.trim() || activeProject.instruction,
        characterIds: selectedCharIds,
        environmentId: selectedEnvId,
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
        environmentVideo: envVideo,
      });
      onProjectChange(updated);
      return updated;
    }
    const created = await createProject({
      name: projectName.trim() || undefined,
      sourceVideo,
      characterIds: selectedCharIds,
      environmentId: selectedEnvId,
      environmentVideo: envVideo,
      instruction:
        instruction.trim() ||
        'Recreate this video cinematically while preserving the reference character identity.',
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
      paidConfirmed: false,
    });
    onProjectChange(created);
    return created;
  };

  const captureError = (err: unknown) => {
    if (err instanceof ApiRequestError) {
      setActionError(err.message);
      if (err.diagnosticDetail) {
        setActionDiagnostic(err.diagnosticDetail);
      }
    } else {
      setActionError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleAnalyzeOnly = async () => {
    setActionError(null);
    setActionDiagnostic(null);
    setBusyAction('analyzing');
    try {
      const proj = await ensureProjectCreated();
      const analyzed = await analyzeProject(proj.id);
      onProjectChange(analyzed);
    } catch (err) {
      captureError(err);
      if (activeProject?.id) {
        void fetchProject(activeProject.id).then(onProjectChange).catch(() => {});
      }
    } finally {
      setBusyAction(null);
    }
  };

  const handleRunClick = async () => {
    setActionError(null);
    setActionDiagnostic(null);
    if (!sourceVideo) {
      setActionError('Upload a reference video (MP4, MOV, or WEBM) first.');
      return;
    }

    setBusyAction('preparing');
    try {
      const proj = await ensureProjectCreated();
      if (billingMode === 'paid' && !proj.paidConfirmed) {
        setPendingPaidProjectId(proj.id);
        setPaidCheckbox(false);
        setPaidModalOpen(true);
        setBusyAction(null);
        return;
      }
      await startProjectRun(proj.id, proj.paidConfirmed);
      const updated = await fetchProject(proj.id);
      onProjectChange(updated);
    } catch (err) {
      captureError(err);
    } finally {
      setBusyAction(null);
    }
  };

  const handleResumeFromStage4 = async () => {
    if (!activeProject) return;
    setActionError(null);
    setActionDiagnostic(null);
    setBusyAction('resuming');
    try {
      if (billingMode === 'paid' && !activeProject.paidConfirmed) {
        setPendingPaidProjectId(activeProject.id);
        setPaidCheckbox(false);
        setPaidModalOpen(true);
        setBusyAction(null);
        return;
      }
      await startProjectRun(
        activeProject.id,
        activeProject.paidConfirmed,
        false
      );
      const updated = await fetchProject(activeProject.id);
      onProjectChange(updated);
    } catch (err) {
      captureError(err);
    } finally {
      setBusyAction(null);
    }
  };

  const confirmAndRunPaid = async () => {
    if (!pendingPaidProjectId || !paidCheckbox) return;
    setPaidModalOpen(false);
    setBusyAction('running');
    setActionError(null);
    setActionDiagnostic(null);
    try {
      await startProjectRun(pendingPaidProjectId, true);
      const updated = await fetchProject(pendingPaidProjectId);
      onProjectChange(updated);
    } catch (err) {
      captureError(err);
    } finally {
      setBusyAction(null);
      setPendingPaidProjectId(null);
    }
  };

  const handleCancelJob = async () => {
    if (!activeProject) return;
    const updated = await cancelQueuedJob(activeProject.id);
    onProjectChange(updated);
  };

  const handleMappingChange = async (sourceCharId: string, refCharId: string) => {
    if (!activeProject) return;
    const nextMap = {
      ...activeProject.characterMapping,
      [sourceCharId]: refCharId || null,
    };
    const updated = await updateProject(activeProject.id, {
      characterMapping: nextMap,
    });
    onProjectChange(updated);
  };

  const handleRetrySegment = async (segIdx: number) => {
    if (!activeProject) return;
    setActionError(null);
    setActionDiagnostic(null);
    try {
      await retryProjectSegment(activeProject.id, segIdx);
      const updated = await fetchProject(activeProject.id);
      onProjectChange(updated);
    } catch (err) {
      captureError(err);
    }
  };

  const handleVerifiedMp4Download = async (project: ProjectRecord) => {
    setActionError(null);
    setDownloadingVideo(true);
    try {
      const check = await verifyVideoDownloadAvailable(project.id);
      if (!check.ok) {
        setActionError(
          check.error || 'Generated MP4 file could not be verified for download.'
        );
        return;
      }
      const a = document.createElement('a');
      a.href = `/api/projects/${project.id}/download/video`;
      const safeName = project.name.replace(/[^a-zA-Z0-9_-]+/g, '_');
      a.download = `${safeName}_${project.resolution}.mp4`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    } finally {
      setDownloadingVideo(false);
    }
  };

  const selectedCharacters = characters.filter((c) =>
    selectedCharIds.includes(c.id)
  );
  const topAutoCandidate = selectionPreview[0] ?? null;
  const activeDiagnostic = activeProject?.diagnosticDetail ?? actionDiagnostic;

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-1 border-b border-white/[0.08] pb-5">
        <h1 className="text-2xl font-semibold tracking-tight text-slate-100">
          {t.create.title}
        </h1>
        <p className="text-sm text-slate-400 max-w-3xl">{t.create.subtitle}</p>
      </div>

      {actionError && (
        <div
          role="alert"
          className="flex items-start gap-3 rounded-lg border border-red-500/30 bg-red-950/30 px-4 py-3 text-sm text-red-200"
        >
          <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0 text-red-400" />
          <div className="flex-1">{actionError}</div>
          <button
            type="button"
            onClick={() => setActionError(null)}
            className="text-red-300 hover:text-white"
            aria-label="Dismiss error"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-start">
        {/* LEFT COLUMN: 4-STEP STUDIO WORKBENCH */}
        <div className="xl:col-span-7 space-y-6">
          {/* STEP 1: REFERENCE VIDEO */}
          <section className="rounded-xl border border-white/[0.08] bg-[#11141B] p-5 space-y-4">
            <div className="flex items-center justify-between gap-4">
              <h2 className="text-base font-semibold text-slate-100">
                {t.create.step1}
              </h2>
              {sourceVideo && (
                <button
                  type="button"
                  onClick={() => videoInputRef.current?.click()}
                  className="text-xs font-medium text-[#E5A93C] hover:text-[#F0B84D] transition-colors whitespace-nowrap shrink-0"
                >
                  Replace Video
                </button>
              )}
            </div>

            <input
              ref={videoInputRef}
              type="file"
              accept=".mp4,.mov,.webm,video/mp4,video/quicktime,video/webm"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void handleVideoFile(file);
                e.target.value = '';
              }}
            />

            {!sourceVideo ? (
              <div
                role="button"
                tabIndex={0}
                onClick={() => videoInputRef.current?.click()}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    videoInputRef.current?.click();
                  }
                }}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  const file = e.dataTransfer.files?.[0];
                  if (file) void handleVideoFile(file);
                }}
                className="flex flex-col items-center justify-center rounded-lg border border-dashed border-white/[0.15] bg-[#0B0D11]/60 px-6 py-10 text-center cursor-pointer hover:border-[#E5A93C]/60 transition-colors"
              >
                <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-[#171B24] text-[#E5A93C] mb-3">
                  <Upload className="h-5 w-5" />
                </div>
                <p className="text-sm font-medium text-slate-200">
                  Drop reference video here or click to browse
                </p>
                <p className="mt-1 text-xs text-slate-400">
                  Supports MP4, MOV, WEBM · 720p HD, 1080p Full HD · 5s to 60s+
                </p>
              </div>
            ) : (
              <div className="space-y-3">
                <div className="overflow-hidden rounded-lg border border-white/[0.08] bg-black">
                  <video
                    src={sourceVideo.url}
                    poster={sourceVideo.thumbnailUrl}
                    controls
                    className="w-full max-h-[300px] object-contain"
                  />
                </div>
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-400 font-mono-tabular">
                    <span className="text-slate-200 font-sans font-medium truncate max-w-[200px]">
                      {sourceVideo.originalName}
                    </span>
                    <div className="flex flex-wrap items-center gap-2">
                      <span>{sourceVideo.durationSec}s</span>
                      <span aria-hidden="true">·</span>
                      <span>
                        {sourceVideo.width}×{sourceVideo.height}
                      </span>
                      <span aria-hidden="true">·</span>
                      <span>{sourceVideo.codec}</span>
                      <span aria-hidden="true">·</span>
                      <span>{formatBytes(sourceVideo.fileSizeBytes)}</span>
                      {sourceVideo.verifiedPlayable && (
                        <>
                          <span aria-hidden="true">·</span>
                          <span className="text-emerald-400 font-sans font-medium">
                            Upload verified
                          </span>
                        </>
                      )}
                    </div>
                  </div>
                </div>
              )}

            {uploadProgress !== null && (
              <div className="space-y-1.5 rounded-lg border border-white/[0.08] bg-[#0B0D11]/70 p-3">
                <div className="flex justify-between text-xs text-slate-300 font-mono-tabular">
                  <span>
                    {uploadPhase === 'validating'
                      ? 'Validating codec, duration (≤60s) & MP4 integrity...'
                      : 'Uploading video chunks to server storage...'}
                  </span>
                  <span>
                    {uploadPhase === 'validating' ? 'Verifying...' : `${uploadProgress}%`}
                  </span>
                </div>
                <div className="h-1.5 w-full rounded-full bg-white/[0.08] overflow-hidden">
                  <div
                    className={`h-full transition-all duration-150 ${
                      uploadPhase === 'validating' ? 'bg-emerald-400' : 'bg-[#E5A93C]'
                    }`}
                    style={{ width: `${uploadPhase === 'validating' ? 98 : uploadProgress}%` }}
                  />
                </div>
              </div>
            )}

            {uploadError && (
              <div className="rounded-lg border border-red-500/30 bg-red-950/30 px-3 py-2 text-xs text-red-300">
                {uploadError}
              </div>
            )}
          </section>

          {/* STEP 2: CHARACTER REFERENCE PHOTOGRAPHS */}
          <section className="rounded-xl border border-white/[0.08] bg-[#11141B] p-5 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-base font-semibold text-slate-100">
                  {t.create.step2}
                </h2>
                <p className="text-xs text-slate-400 mt-0.5">
                  Single clear portrait by default; add extra angles optionally for stronger facial consistency.
                </p>
              </div>
              <button
                type="button"
                disabled={charUploadLoading}
                onClick={() => charInputRef.current?.click()}
                className="inline-flex items-center gap-2 rounded-lg border border-white/[0.12] bg-[#171B24] px-3.5 py-2 text-xs font-medium text-slate-100 hover:border-[#E5A93C]/50 transition-colors whitespace-nowrap shrink-0"
              >
                {charUploadLoading ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Upload className="h-3.5 w-3.5 text-[#E5A93C]" />
                )}
                Upload Photo(s)
              </button>
              <input
                ref={charInputRef}
                type="file"
                multiple
                accept=".jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp"
                className="hidden"
                onChange={(e) => {
                  void handleQuickCharUpload(e.target.files);
                  e.target.value = '';
                }}
              />
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              {characters.map((char) => {
                const isSelected = selectedCharIds.includes(char.id);
                return (
                  <button
                    key={char.id}
                    type="button"
                    onClick={() =>
                      setSelectedCharIds((prev) =>
                        prev.includes(char.id)
                          ? prev.filter((id) => id !== char.id)
                          : [...prev, char.id]
                      )
                    }
                    className={`group text-left rounded-lg border p-2.5 transition-colors ${
                      isSelected
                        ? 'border-[#E5A93C] bg-[#E5A93C]/[0.08]'
                        : 'border-white/[0.08] bg-[#0B0D11]/50 hover:border-white/[0.2]'
                    }`}
                  >
                    <div className="aspect-square w-full overflow-hidden rounded-md bg-[#171B24] mb-2">
                      <img
                        src={char.primaryImageUrl}
                        alt={char.name}
                        referrerPolicy="no-referrer"
                        className="h-full w-full object-cover"
                      />
                    </div>
                    <div className="flex items-center justify-between gap-1">
                      <span className="text-xs font-medium text-slate-200 truncate">
                        {char.name}
                      </span>
                      {isSelected && (
                        <CheckCircle2 className="h-3.5 w-3.5 text-[#E5A93C] shrink-0" />
                      )}
                    </div>
                    <p className="text-[11px] text-slate-400 truncate mt-0.5">
                      {char.isPreset ? 'Sample Preset' : 'Saved Character'}
                    </p>
                  </button>
                );
              })}
            </div>

            {selectedCharacters.length > 0 && selectedCharacters[0].profile && (
              <div className="rounded-lg border border-white/[0.06] bg-[#0B0D11]/60 p-3.5 space-y-1.5">
                <div className="flex items-center gap-2 text-xs font-medium text-[#E5A93C]">
                  <UserCheck className="h-3.5 w-3.5" />
                  <span>
                    Extracted Identity Profile · {selectedCharacters[0].name}
                  </span>
                </div>
                <p className="text-xs text-slate-300 leading-relaxed">
                  {selectedCharacters[0].profile.identitySummaryPrompt}
                </p>
              </div>
            )}

            {/* Replacement Scope Selector */}
            {(selectedCharIds.length > 0 ||
              mode === 'character_replacement' ||
              mode === 'cinematic_recreation_with_character') && (
              <div className="border-t border-white/[0.06] pt-4 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-slate-300">
                    Character Replacement Scope
                  </span>
                  <span className="text-[11px] text-slate-500">
                    Controls full-body vs face/head identity lock
                  </span>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                  <button
                    type="button"
                    onClick={() =>
                      setReplacementScope('full_character_replacement')
                    }
                    className={`rounded-lg border p-3 text-left transition-colors ${
                      replacementScope === 'full_character_replacement'
                        ? 'border-[#E5A93C] bg-[#E5A93C]/[0.08]'
                        : 'border-white/[0.08] bg-[#0B0D11]/60 hover:border-white/[0.2]'
                    }`}
                  >
                    <div className="text-xs font-semibold text-slate-100">
                      Mode B · Full Character Replacement
                    </div>
                    <p className="text-[11px] text-slate-400 mt-0.5 leading-relaxed">
                      Default · Replaces face, head, hair, body build, and styling while preserving original motion.
                    </p>
                  </button>
                  <button
                    type="button"
                    onClick={() => setReplacementScope('face_replacement')}
                    className={`rounded-lg border p-3 text-left transition-colors ${
                      replacementScope === 'face_replacement'
                        ? 'border-[#E5A93C] bg-[#E5A93C]/[0.08]'
                        : 'border-white/[0.08] bg-[#0B0D11]/60 hover:border-white/[0.2]'
                    }`}
                  >
                    <div className="text-xs font-semibold text-slate-100">
                      Mode A · Face &amp; Head Replacement Only
                    </div>
                    <p className="text-[11px] text-slate-400 mt-0.5 leading-relaxed">
                      Replaces face, head, and hair while retaining the source character’s original clothing and pose.
                    </p>
                  </button>
                </div>
              </div>
            )}
          </section>

          {/* STEP 3: NATURAL-LANGUAGE DIRECTION & MODE */}
          <section className="rounded-xl border border-white/[0.08] bg-[#11141B] p-5 space-y-4">
            <h2 className="text-base font-semibold text-slate-100">
              {t.create.step3}
            </h2>

            <div>
              <label
                htmlFor="project-name-input"
                className="block text-xs font-medium text-slate-400 mb-1.5"
              >
                Project Name
              </label>
              <input
                id="project-name-input"
                type="text"
                value={projectName}
                onChange={(e) => setProjectName(e.target.value)}
                placeholder="Alpine Village Walk — Lead Replacement"
                className="w-full rounded-lg border border-white/[0.1] bg-[#0B0D11] px-3.5 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:border-[#E5A93C] focus:outline-none"
              />
            </div>

            <div>
              <label
                htmlFor="instruction-textarea"
                className="block text-xs font-medium text-slate-400 mb-1.5"
              >
                Natural-Language Instruction (Persian, English, or any language)
              </label>
              <textarea
                id="instruction-textarea"
                rows={4}
                dir="auto"
                value={instruction}
                onChange={(e) => setInstruction(e.target.value)}
                placeholder={t.create.instructionPlaceholder}
                className="w-full rounded-lg border border-white/[0.1] bg-[#0B0D11] px-3.5 py-2.5 text-sm text-slate-100 placeholder:text-slate-500 focus:border-[#E5A93C] focus:outline-none leading-relaxed"
              />
              <div className="mt-2 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() =>
                    setInstruction(
                      'Replace the main character with my uploaded photograph. Keep the original walking movement. Change the background into a snowy mountain village. Add realistic snowfall and cinematic lighting. Replace the original environmental sound with wind and footsteps.'
                    )
                  }
                  className="rounded-md border border-white/[0.08] bg-[#171B24] px-2.5 py-1 text-xs text-slate-300 hover:border-[#E5A93C]/40 hover:text-white transition-colors"
                >
                  Preset: Snowy Village Walk
                </button>
                <button
                  type="button"
                  onClick={() =>
                    setInstruction(
                      'چهره شخصیت اصلی را با عکس آپلود شده من جایگزین کن. ظاهر چهره کاملاً ثابت بماند. صحنه را در یک شهر باستانی در شب با نور مشعل و فضای سینمایی بازآفرینی کن.'
                    )
                  }
                  className="rounded-md border border-white/[0.08] bg-[#171B24] px-2.5 py-1 text-xs text-slate-300 hover:border-[#E5A93C]/40 hover:text-white transition-colors"
                >
                  Preset (FA): شهر باستانی در شب
                </button>
              </div>
            </div>

            <div>
              <label
                htmlFor="transformation-mode"
                className="block text-xs font-medium text-slate-400 mb-1.5"
              >
                Transformation Mode
              </label>
              <select
                id="transformation-mode"
                value={mode}
                onChange={(e) => setMode(e.target.value as TransformationMode)}
                className="w-full rounded-lg border border-white/[0.1] bg-[#0B0D11] px-3.5 py-2.5 text-sm text-slate-100 focus:border-[#E5A93C] focus:outline-none"
              >
                {MODE_OPTIONS.map((opt) => (
                  <option key={opt.id} value={opt.id}>
                    {opt.title}
                  </option>
                ))}
              </select>
              <p className="mt-1.5 text-xs text-slate-400">
                {MODE_OPTIONS.find((o) => o.id === mode)?.desc}
              </p>
            </div>
          </section>

          {/* STEP 4: OPTIONAL ENVIRONMENT REFERENCE (IMAGE OR VIDEO) + ADVANCED SETTINGS */}
          <section className="rounded-xl border border-white/[0.08] bg-[#11141B] p-5 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-base font-semibold text-slate-100">
                  {t.create.step4}
                </h2>
                <p className="text-xs text-slate-400 mt-0.5">
                  Optional location image or reference video to guide environment, lighting, and atmosphere.
                </p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={envUploadLoading}
                  onClick={() => envInputRef.current?.click()}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-white/[0.12] bg-[#171B24] px-3 py-2 text-xs font-medium text-slate-100 hover:border-[#E5A93C]/50 transition-colors whitespace-nowrap"
                >
                  {envUploadLoading ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <ImageIcon className="h-3.5 w-3.5 text-[#E5A93C]" />
                  )}
                  Env Image
                </button>
                <button
                  type="button"
                  onClick={() => envVideoInputRef.current?.click()}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-white/[0.12] bg-[#171B24] px-3 py-2 text-xs font-medium text-slate-100 hover:border-[#E5A93C]/50 transition-colors whitespace-nowrap"
                >
                  <Video className="h-3.5 w-3.5 text-[#E5A93C]" />
                  Env Video
                </button>
              </div>
              <input
                ref={envInputRef}
                type="file"
                accept=".jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp"
                className="hidden"
                onChange={(e) => {
                  void handleQuickEnvUpload(e.target.files);
                  e.target.value = '';
                }}
              />
              <input
                ref={envVideoInputRef}
                type="file"
                accept=".mp4,.mov,.webm,video/mp4,video/quicktime,video/webm"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void handleEnvVideoFile(f);
                  e.target.value = '';
                }}
              />
            </div>

            {envVideoProgress !== null && (
              <div className="text-xs text-slate-300 font-mono-tabular">
                Uploading environment video... {envVideoProgress}%
              </div>
            )}

            {envVideo && (
              <div className="flex items-center justify-between gap-3 rounded-lg border border-[#E5A93C]/30 bg-[#E5A93C]/[0.06] px-3.5 py-2.5 text-xs">
                <span className="text-slate-200 truncate">
                  Environment Reference Video: <strong>{envVideo.originalName}</strong> ({envVideo.durationSec}s)
                </span>
                <button
                  type="button"
                  onClick={() => setEnvVideo(null)}
                  className="text-slate-400 hover:text-white"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            )}

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <button
                type="button"
                onClick={() => {
                  setSelectedEnvId(null);
                  if (backgroundMode === 'use_env_ref') {
                    setBackgroundMode('preserve');
                  }
                }}
                className={`rounded-lg border p-2.5 text-left transition-colors ${
                  selectedEnvId === null
                    ? 'border-[#E5A93C] bg-[#E5A93C]/[0.08]'
                    : 'border-white/[0.08] bg-[#0B0D11]/50 hover:border-white/[0.2]'
                }`}
              >
                <div className="aspect-video w-full rounded bg-[#171B24] flex items-center justify-center text-xs text-slate-400 mb-2">
                  Follow Prompt / Original
                </div>
                <span className="text-xs font-medium text-slate-200 block truncate">
                  No Image Ref
                </span>
              </button>

              {environments.map((env) => {
                const active = selectedEnvId === env.id;
                return (
                  <button
                    key={env.id}
                    type="button"
                    onClick={() => {
                      setSelectedEnvId(env.id);
                      setBackgroundMode('use_env_ref');
                    }}
                    className={`rounded-lg border p-2 text-left transition-colors ${
                      active
                        ? 'border-[#E5A93C] bg-[#E5A93C]/[0.08]'
                        : 'border-white/[0.08] bg-[#0B0D11]/50 hover:border-white/[0.2]'
                    }`}
                  >
                    <div className="aspect-video w-full overflow-hidden rounded bg-[#171B24] mb-2">
                      <img
                        src={env.imageUrl}
                        alt={env.name}
                        referrerPolicy="no-referrer"
                        className="h-full w-full object-cover"
                      />
                    </div>
                    <span className="text-xs font-medium text-slate-200 block truncate">
                      {env.name}
                    </span>
                    <span className="text-[11px] text-slate-400 block truncate">
                      {env.category}
                    </span>
                  </button>
                );
              })}
            </div>

            {/* Scene Background & Lighting Preservation Controls */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 border-t border-white/[0.06] pt-3">
              <div>
                <label className="block text-xs font-medium text-slate-400 mb-1.5">
                  Background Continuity
                </label>
                <select
                  value={backgroundMode}
                  onChange={(e) =>
                    setBackgroundMode(e.target.value as BackgroundMode)
                  }
                  className="w-full rounded-lg border border-white/[0.1] bg-[#0B0D11] px-3 py-2 text-xs text-slate-100"
                >
                  <option value="preserve">
                    Preserve Original Background (Default)
                  </option>
                  <option value="use_env_ref">
                    Use Selected Environment Reference
                  </option>
                  <option value="transform">
                    Transform Background via Prompt
                  </option>
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-400 mb-1.5">
                  Lighting Continuity
                </label>
                <select
                  value={lightingMode}
                  onChange={(e) =>
                    setLightingMode(e.target.value as LightingMode)
                  }
                  className="w-full rounded-lg border border-white/[0.1] bg-[#0B0D11] px-3 py-2 text-xs text-slate-100"
                >
                  <option value="preserve">
                    Preserve Original Scene Lighting (Default)
                  </option>
                  <option value="enhance">
                    Apply Cinematic Relighting &amp; Contrast
                  </option>
                </select>
              </div>
            </div>

            {/* Collapsible Advanced Settings */}
            <div className="border-t border-white/[0.08] pt-4">
              <button
                type="button"
                onClick={() => setShowAdvanced((v) => !v)}
                className="flex w-full items-center justify-between text-sm font-medium text-slate-300 hover:text-white transition-colors"
              >
                <span className="inline-flex items-center gap-2">
                  <SlidersHorizontal className="h-4 w-4 text-[#E5A93C]" />
                  {t.actions.advancedSettings}
                </span>
                {showAdvanced ? (
                  <ChevronUp className="h-4 w-4" />
                ) : (
                  <ChevronDown className="h-4 w-4" />
                )}
              </button>

              {showAdvanced && (
                <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-4 pt-2">
                  <div>
                    <label className="block text-xs font-medium text-slate-400 mb-1.5">
                      Output Resolution
                    </label>
                    <select
                      value={resolution}
                      onChange={(e) =>
                        setResolution(e.target.value as OutputResolution)
                      }
                      className="w-full rounded-lg border border-white/[0.1] bg-[#0B0D11] px-3 py-2 text-sm text-slate-100"
                    >
                      <option value="720p">720p HD</option>
                      <option value="1080p">1080p Full HD</option>
                    </select>
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-slate-400 mb-1.5">
                      Aspect Ratio
                    </label>
                    <select
                      value={aspectRatio}
                      onChange={(e) =>
                        setAspectRatio(e.target.value as OutputAspectRatio)
                      }
                      className="w-full rounded-lg border border-white/[0.1] bg-[#0B0D11] px-3 py-2 text-sm text-slate-100"
                    >
                      <option value="original">Original Source Ratio</option>
                      <option value="16:9">16:9 Landscape</option>
                      <option value="9:16">9:16 Vertical</option>
                      <option value="1:1">1:1 Square</option>
                    </select>
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-slate-400 mb-1.5">
                      Quality Tier
                    </label>
                    <select
                      value={qualityTier}
                      onChange={(e) =>
                        setQualityTier(e.target.value as QualityTier)
                      }
                      className="w-full rounded-lg border border-white/[0.1] bg-[#0B0D11] px-3 py-2 text-sm text-slate-100"
                    >
                      <option value="economy">Economy (Default)</option>
                      <option value="balanced">Balanced</option>
                      <option value="maximum">Maximum Quality</option>
                    </select>
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-slate-400 mb-1.5">
                      Audio &amp; Sound Design
                    </label>
                    <select
                      value={audioMode}
                      onChange={(e) => setAudioMode(e.target.value as AudioMode)}
                      className="w-full rounded-lg border border-white/[0.1] bg-[#0B0D11] px-3 py-2 text-sm text-slate-100"
                    >
                      <option value="preserve_dialogue">
                        Preserve Original Dialogue / Audio
                      </option>
                      <option value="replace_ambient_sfx">
                        Replace Ambient &amp; Generate Soundscape
                      </option>
                      <option value="generate_score">
                        Generate New Score (Lyria · Paid)
                      </option>
                      <option value="silent">Silent Video Track</option>
                    </select>
                  </div>

                  <div className="sm:col-span-2">
                    <label className="block text-xs font-medium text-slate-400 mb-1.5">
                      Free-First Provider Fallback Policy
                    </label>
                    <select
                      value={freeFallbackPolicy}
                      onChange={(e) =>
                        setFreeFallbackPolicy(
                          e.target.value as FreeModeFallbackPolicy
                        )
                      }
                      className="w-full rounded-lg border border-white/[0.1] bg-[#0B0D11] px-3 py-2 text-sm text-slate-100"
                    >
                      <option value="ffmpeg_master">
                        Master via FFmpeg + Gemini Analysis if no free video generator quota is connected
                      </option>
                      <option value="require_generative_free">
                        Require external free generative video provider (stop if none available)
                      </option>
                    </select>
                  </div>
                </div>
              )}
            </div>
          </section>
        </div>

        {/* RIGHT COLUMN: SMART AUTO MODEL SELECTION & REAL-TIME MONITOR */}
        <div className="xl:col-span-5 space-y-6">
          {/* PRE-FLIGHT & RUN CARD */}
          <section className="rounded-xl border border-white/[0.08] bg-[#11141B] p-5 space-y-4">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-base font-semibold text-slate-100">
                Automatic Model Selection &amp; Cost Guard
              </h2>
              <span className="text-xs text-slate-400 font-mono-tabular">
                {estimatedSegments > 0
                  ? `~${estimatedSegments} segment(s)`
                  : 'No video yet'}
              </span>
            </div>

            {/* Free-First vs Paid Mode Switch */}
            <div className="grid grid-cols-2 gap-2 rounded-lg bg-[#0B0D11] p-1 border border-white/[0.06]">
              <button
                type="button"
                onClick={() => setBillingMode('free')}
                className={`rounded-md px-3 py-2 text-xs font-medium transition-colors ${
                  billingMode === 'free'
                    ? 'bg-[#1E2430] text-emerald-300 border border-emerald-500/30'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                Automatic Free Mode
              </button>
              <button
                type="button"
                onClick={() => setBillingMode('paid')}
                className={`rounded-md px-3 py-2 text-xs font-medium transition-colors ${
                  billingMode === 'paid'
                    ? 'bg-[#1E2430] text-[#E5A93C] border border-[#E5A93C]/40'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                Paid AI Video Mode
              </button>
            </div>

            {/* Smart Model Selection & 8-Indicator Pipeline Capability Matrix */}
            <div className="rounded-lg border border-white/[0.06] bg-[#0B0D11]/70 p-3.5 text-xs space-y-3">
              {capabilityPreview && (
                <>
                  <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/[0.06] pb-2">
                    <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                      Pipeline Capability Matrix
                    </span>
                    <span
                      className={`rounded px-2 py-0.5 text-[10px] font-mono-tabular font-medium ${
                        capabilityPreview.activeWorkflow === 'multistage_frame_replacement'
                          ? 'bg-emerald-950/60 text-emerald-300 border border-emerald-500/30'
                          : capabilityPreview.activeWorkflow === 'native_v2v'
                            ? 'bg-emerald-950/60 text-emerald-300 border border-emerald-500/30'
                            : capabilityPreview.canRunPartialStages1To3
                              ? 'bg-amber-950/50 text-amber-300 border border-amber-500/30'
                              : 'bg-white/[0.05] text-slate-300 border border-white/[0.1]'
                      }`}
                    >
                      {capabilityPreview.activeWorkflow === 'multistage_frame_replacement'
                        ? 'Multi-Stage Frame Pipeline'
                        : capabilityPreview.activeWorkflow === 'native_v2v'
                          ? 'Native V2V Engine'
                          : capabilityPreview.canRunPartialStages1To3
                            ? 'Stages 1–3 Ready · Stage 4 Setup Needed'
                            : 'Legacy Video Mode'}
                    </span>
                  </div>
                  <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 border-b border-white/[0.06] pb-2.5 text-[11px] font-mono-tabular">
                    {(
                      [
                        ['Video Analysis', capabilityPreview.pipelineCapabilities.videoAnalysis],
                        ['Character Detection', capabilityPreview.pipelineCapabilities.characterDetection],
                        ['Character Tracking', capabilityPreview.pipelineCapabilities.characterTracking],
                        ['Image Replacement', capabilityPreview.pipelineCapabilities.imageBasedReplacement],
                        ['Temporal Consistency', capabilityPreview.pipelineCapabilities.temporalConsistency],
                        ['Full-Body Replacement', capabilityPreview.pipelineCapabilities.fullBodyReplacement],
                        ['Multi-Character', capabilityPreview.pipelineCapabilities.multiCharacterReplacement],
                        ['Video Reconstruction', capabilityPreview.pipelineCapabilities.videoReconstruction],
                      ] as const
                    ).map(([label, state]) => (
                      <div key={label} className="flex items-center justify-between gap-1.5">
                        <span className="text-slate-400 truncate">{label}:</span>
                        <span
                          className={
                            state === 'ready'
                              ? 'text-emerald-400 shrink-0'
                              : 'text-amber-400 shrink-0'
                          }
                        >
                          {state === 'ready' ? 'Ready' : 'Unavailable'}
                        </span>
                      </div>
                    ))}
                  </div>
                </>
              )}

              {billingMode === 'free' ? (
                <>
                  <div className="flex items-center gap-2 text-emerald-300 font-medium">
                    <ShieldCheck className="h-4 w-4 shrink-0" />
                    <span>Free-First Mode Active · No Paid Fallback</span>
                  </div>
                  {capabilityPreview?.isCharacterReplacementTask &&
                  capabilityPreview.multiStageAvailable ? (
                    <div className="space-y-1 text-slate-300">
                      <div className="flex items-center gap-1.5 text-slate-200 font-medium">
                        <Cpu className="h-3.5 w-3.5 text-[#E5A93C]" />
                        <span>
                          Stage 4 Frame Engine: {capabilityPreview.stage4AdapterName ?? topAutoCandidate?.providerName} ·{' '}
                          <code className="font-mono">
                            {capabilityPreview.stage4ModelId ?? topAutoCandidate?.modelId}
                          </code>
                        </span>
                      </div>
                      {capabilityPreview.stage4HardwareNote && (
                        <p className="text-[11px] text-slate-400">
                          {capabilityPreview.stage4HardwareNote}
                          {capabilityPreview.stage4CostEstimateNote
                            ? ` · ${capabilityPreview.stage4CostEstimateNote}`
                            : ''}
                        </p>
                      )}
                    </div>
                  ) : topAutoCandidate ? (
                    <div className="space-y-1 text-slate-300">
                      <div className="flex items-center gap-1.5 text-slate-200 font-medium">
                        <Cpu className="h-3.5 w-3.5 text-[#E5A93C]" />
                        <span>
                          Auto-Selected: {topAutoCandidate.providerName} ·{' '}
                          <code className="font-mono">{topAutoCandidate.modelId}</code>
                        </span>
                      </div>
                      <p className="text-[11px] text-slate-400">
                        {topAutoCandidate.reason}. Automatic failover enabled across{' '}
                        {selectionPreview.length} eligible free candidate(s).
                      </p>
                    </div>
                  ) : capabilityPreview?.isCharacterReplacementTask &&
                    capabilityPreview.blockingReason ? (
                    <div className="space-y-2 rounded border border-amber-500/35 bg-amber-950/25 p-2.5 text-[11px] text-amber-200">
                      <p className="leading-relaxed">
                        {capabilityPreview.blockingReason}
                      </p>
                      <p className="text-[10px] text-amber-300/90">
                        Running now will complete Stages 1–3 (ingestion, frame extraction, character tracking &amp; masks) and pause cleanly at Stage 4 until a frame-editing backend is configured.
                      </p>
                      {capabilityPreview.paidStage4CandidatesCount > 0 && (
                        <button
                          type="button"
                          onClick={() => setBillingMode('paid')}
                          className="rounded border border-[#E5A93C]/50 bg-[#E5A93C]/15 px-2.5 py-1 text-[11px] font-medium text-[#E5A93C] hover:bg-[#E5A93C]/25 transition-colors"
                        >
                          Switch to Paid Mode for Stage 4 Image Editing
                        </button>
                      )}
                    </div>
                  ) : (
                    <p className="text-slate-400 leading-relaxed">
                      Stages 1–3 and Stage 6 run locally with Gemini analysis + FFmpeg. Configure the free Local GPU Worker or Hugging Face token in Provider Settings to enable Stage 4 frame replacement.
                    </p>
                  )}
                </>
              ) : (
                <>
                  <div className="flex items-center gap-2 text-[#E5A93C] font-medium">
                    <AlertTriangle className="h-4 w-4 shrink-0" />
                    <span>Paid Generation Requires Explicit Confirmation</span>
                  </div>
                  <div className="space-y-1 text-slate-300 font-mono-tabular">
                    <div className="flex justify-between">
                      <span className="text-slate-400">Selected Model:</span>
                      <span>
                        {capabilityPreview?.stage4ModelId ??
                          topAutoCandidate?.modelId ??
                          'gemini-3.1-flash-lite-image'}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-400">Est. Duration:</span>
                      <span>{sourceVideo ? `${sourceVideo.durationSec}s` : '—'}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-400">Est. Cost:</span>
                      <span>
                        {sourceVideo ? `~$${estimatedPaidCost.toFixed(2)} USD` : '—'}
                      </span>
                    </div>
                  </div>
                </>
              )}
            </div>

            <div className="flex flex-col sm:flex-row gap-2.5">
              <button
                type="button"
                disabled={!sourceVideo || Boolean(busyAction)}
                onClick={() => void handleRunClick()}
                className="flex-1 inline-flex items-center justify-center gap-2 rounded-lg bg-[#E5A93C] px-5 py-3 text-sm font-semibold text-[#0B0D11] hover:bg-[#F0B84D] disabled:opacity-45 disabled:cursor-not-allowed transition-colors whitespace-nowrap"
              >
                {busyAction ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Play className="h-4 w-4 fill-current" />
                )}
                {t.actions.run}
              </button>
              <button
                type="button"
                disabled={!sourceVideo || Boolean(busyAction)}
                onClick={() => void handleAnalyzeOnly()}
                className="inline-flex items-center justify-center gap-2 rounded-lg border border-white/[0.12] bg-[#171B24] px-4 py-3 text-xs font-medium text-slate-200 hover:border-white/[0.25] disabled:opacity-45 disabled:cursor-not-allowed transition-colors whitespace-nowrap shrink-0"
              >
                {t.actions.analyzeFirst}
              </button>
            </div>
          </section>

          {/* REAL-TIME PROCESSING & OUTPUT MONITOR */}
          {activeProject && (
            <section className="rounded-xl border border-white/[0.08] bg-[#11141B] p-5 space-y-5">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h2 className="text-base font-semibold text-slate-100 truncate">
                    {activeProject.name}
                  </h2>
                  <p className="text-xs text-slate-400 mt-0.5">
                    {activeProject.statusMessage}
                  </p>
                  <p className="text-[11px] text-slate-500 font-mono-tabular mt-1">
                    Provider: {activeProject.selectedModels.videoProvider} ·{' '}
                    {activeProject.selectedModels.videoModel}
                  </p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <span
                    className={`text-xs font-medium font-mono-tabular whitespace-nowrap ${
                      activeProject.status === 'completed'
                        ? 'text-emerald-400'
                        : activeProject.status === 'failed' ||
                            activeProject.status === 'partial_failure' ||
                            activeProject.status === 'cancelled'
                          ? 'text-red-400'
                          : 'text-[#E5A93C]'
                    }`}
                  >
                    {activeProject.status === 'completed'
                      ? '100%'
                      : activeProject.providerProgressAvailable === false &&
                          activeProject.status === 'processing'
                        ? `Stage ${Math.min(99, activeProject.progressPercent)}% (Est.)`
                        : `${Math.min(99, activeProject.progressPercent)}%`}
                  </span>
                  {(activeProject.status === 'queued' ||
                    activeProject.status === 'analyzing' ||
                    activeProject.status === 'processing') && (
                    <button
                      type="button"
                      onClick={() => void handleCancelJob()}
                      className="inline-flex items-center gap-1 rounded border border-red-500/30 px-2 py-1 text-[11px] text-red-300 hover:bg-red-950/30"
                    >
                      <XCircle className="h-3 w-3" />
                      Cancel
                    </button>
                  )}
                </div>
              </div>

              {/* Real Progress Bar (Never shows 100% until MP4 playback verification passes) */}
              <div className="space-y-1.5">
                <div className="h-2 w-full rounded-full bg-white/[0.08] overflow-hidden">
                  <div
                    className={`h-full transition-all duration-300 ${
                      activeProject.status === 'failed' ||
                      activeProject.status === 'cancelled' ||
                      activeProject.status === 'partial_failure'
                        ? 'bg-red-500'
                        : activeProject.status === 'completed'
                          ? 'bg-emerald-500'
                          : 'bg-[#E5A93C]'
                    }`}
                    style={{
                      width: `${
                        activeProject.status === 'completed'
                          ? 100
                          : Math.min(99, activeProject.progressPercent)
                      }%`,
                    }}
                  />
                </div>
                {activeProject.estimatedRemainingSec !== null &&
                  activeProject.estimatedRemainingSec > 0 &&
                  activeProject.status === 'processing' && (
                    <p className="text-[11px] text-slate-400 font-mono-tabular text-right">
                      Est. remaining: ~{activeProject.estimatedRemainingSec}s
                    </p>
                  )}
              </div>

              {/* Developer Error Diagnostic & Recovery Panel */}
              {(activeProject.status === 'failed' ||
                activeProject.status === 'partial_failure' ||
                activeDiagnostic) && (
                <div className="rounded-lg border border-red-500/35 bg-red-950/25 p-4 space-y-3">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="flex items-center gap-2 text-xs font-semibold text-red-300">
                      <Terminal className="h-4 w-4 text-red-400 shrink-0" />
                      <span>
                        Pipeline Diagnostic Report
                        {activeDiagnostic?.failureCategory && (
                          <span className="ml-2 font-mono text-[11px] text-amber-300">
                            [
                            {activeDiagnostic.failureCategory === 'quota_exhausted'
                              ? 'Quota Exhausted'
                              : activeDiagnostic.failureCategory === 'auth_failed'
                                ? 'API Authentication Failed'
                                : activeDiagnostic.failureCategory === 'provider_unavailable'
                                  ? 'Provider Unavailable'
                                  : activeDiagnostic.failureCategory === 'unsupported_video_generation'
                                    ? 'V2V Replacement Capability Missing'
                                    : activeDiagnostic.failureCategory === 'missing_stage_dependency'
                                      ? 'Stage 4 Frame Editor Setup Required'
                                      : activeDiagnostic.failureCategory === 'qc_failed'
                                        ? 'Character Replacement QC Failed'
                                        : 'Processing Error'}
                            ]
                          </span>
                        )}
                      </span>
                    </div>
                    <button
                      type="button"
                      disabled={Boolean(busyAction)}
                      onClick={() =>
                        void (activeProject.pipelineState?.missingDependency
                          ? handleResumeFromStage4()
                          : handleRunClick())
                      }
                      className="inline-flex items-center gap-1.5 rounded-md border border-red-400/40 bg-red-900/40 px-3 py-1.5 text-xs font-medium text-red-100 hover:bg-red-800/50 disabled:opacity-50"
                    >
                      <RefreshCw className="h-3.5 w-3.5" />
                      {activeProject.pipelineState?.missingDependency
                        ? 'Resume from Stage 4'
                        : 'Retry Generation'}
                    </button>
                  </div>

                  <p className="text-xs text-red-100 leading-relaxed">
                    {activeDiagnostic?.userMessage ||
                      activeProject.errorMessage ||
                      'Video generation encountered an error.'}
                  </p>

                  {activeDiagnostic && (
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 rounded-md border border-white/[0.08] bg-[#0B0D11]/80 p-3 text-[11px] font-mono-tabular">
                      <div>
                        <span className="text-slate-500">Failed Stage:</span>{' '}
                        <span className="text-slate-200">{activeDiagnostic.stage}</span>
                      </div>
                      <div>
                        <span className="text-slate-500">Provider:</span>{' '}
                        <span className="text-slate-200">{activeDiagnostic.provider}</span>
                      </div>
                      {activeDiagnostic.model && (
                        <div>
                          <span className="text-slate-500">Model:</span>{' '}
                          <span className="text-slate-200">{activeDiagnostic.model}</span>
                        </div>
                      )}
                      {typeof activeDiagnostic.httpStatus === 'number' && (
                        <div>
                          <span className="text-slate-500">HTTP Status:</span>{' '}
                          <span className="text-red-300">{activeDiagnostic.httpStatus}</span>
                        </div>
                      )}
                      {activeDiagnostic.quotaIdentifier && (
                        <div className="sm:col-span-2 break-all">
                          <span className="text-slate-500">Quota ID:</span>{' '}
                          <span className="text-amber-300">
                            {activeDiagnostic.quotaIdentifier}
                            {typeof activeDiagnostic.dailyLimit === 'number'
                              ? ` (${activeDiagnostic.dailyLimit} req/day)`
                              : ''}
                          </span>
                        </div>
                      )}
                      {activeDiagnostic.retryAfterAt && (
                        <div className="sm:col-span-2">
                          <span className="text-slate-500">Retry / Reset After:</span>{' '}
                          <span className="text-slate-200">
                            {new Date(activeDiagnostic.retryAfterAt).toLocaleString()}
                          </span>
                        </div>
                      )}
                      {activeDiagnostic.providerJobId && (
                        <div className="sm:col-span-2 break-all">
                          <span className="text-slate-500">Provider Job ID:</span>{' '}
                          <span className="text-slate-200">{activeDiagnostic.providerJobId}</span>
                        </div>
                      )}
                      <div className="sm:col-span-2 text-slate-300 font-mono break-words border-t border-white/[0.06] pt-2 mt-1">
                        {activeDiagnostic.technicalError}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* Missing Stage 4 Frame-Replacement Setup & Resume Card */}
              {activeProject.pipelineState?.missingDependency && (
                <div className="rounded-lg border border-amber-500/35 bg-amber-950/20 p-4 space-y-3">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <h3 className="text-xs font-semibold text-amber-200">
                        {activeProject.pipelineState.missingDependency.title}
                      </h3>
                      <p className="text-[11px] text-amber-100/80 mt-0.5 leading-relaxed">
                        {activeProject.pipelineState.missingDependency.description}
                      </p>
                    </div>
                    <button
                      type="button"
                      disabled={Boolean(busyAction)}
                      onClick={() => void handleResumeFromStage4()}
                      className="inline-flex items-center gap-1.5 rounded-md bg-[#E5A93C] px-3 py-1.5 text-xs font-semibold text-[#0B0D11] hover:bg-[#F0B84D] disabled:opacity-45 shrink-0"
                    >
                      <Play className="h-3.5 w-3.5 fill-current" />
                      Resume from Stage 4
                    </button>
                  </div>
                  <div className="space-y-2">
                    {activeProject.pipelineState.missingDependency.setupOptions.map((opt) => (
                      <div
                        key={opt.id}
                        className="rounded-md border border-white/[0.08] bg-[#0B0D11]/80 p-2.5 text-[11px] space-y-1"
                      >
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <span className="font-medium text-slate-100">{opt.label}</span>
                          <span className="font-mono-tabular text-[10px] text-emerald-300">
                            {opt.costLabel} · {opt.hardwareRequirement}
                          </span>
                        </div>
                        <p className="text-slate-400 leading-relaxed">{opt.instructions}</p>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Pipeline Progress Checklist (6-Stage Modular or 14-Stage Legacy) */}
              <div className="space-y-1.5 border-t border-white/[0.06] pt-3">
                {(activeProject.pipelineState?.workflowType === 'multistage_frame_replacement'
                  ? MULTI_STAGE_STEPS
                  : PROCESSING_STAGES
                ).map((st) => {
                  const done = activeProject.completedStages.includes(st.key);
                  const current =
                    activeProject.currentStage === st.key &&
                    activeProject.status !== 'completed' &&
                    activeProject.status !== 'failed' &&
                    activeProject.status !== 'partial_failure' &&
                    activeProject.status !== 'cancelled';
                  const failedHere =
                    (activeProject.status === 'failed' ||
                      activeProject.status === 'partial_failure') &&
                    (activeDiagnostic?.stage === st.key ||
                      activeProject.currentStage === st.key);
                  return (
                    <div
                      key={st.key}
                      className="flex items-center justify-between text-xs py-0.5"
                    >
                      <span
                        className={
                          failedHere
                            ? 'text-red-400 font-medium'
                            : done
                              ? 'text-slate-200'
                              : current
                                ? 'text-[#E5A93C] font-medium'
                                : 'text-slate-500'
                        }
                      >
                        {st.label}
                      </span>
                      <span className="font-mono-tabular text-[11px]">
                        {failedHere ? (
                          <span className="text-red-400">
                            {activeProject.status === 'partial_failure' ? 'Paused' : 'Failed'}
                          </span>
                        ) : done ? (
                          <span className="text-emerald-400">Done</span>
                        ) : current ? (
                          <span className="text-[#E5A93C]">Running</span>
                        ) : (
                          <span className="text-slate-600">Pending</span>
                        )}
                      </span>
                    </div>
                  );
                })}
              </div>

              {/* Detected Characters & Optional Correction Mapping */}
              {activeProject.detectedCharacters.length > 0 && (
                <div className="border-t border-white/[0.06] pt-4 space-y-3">
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-400">
                    Detected Characters &amp; Reference Mapping
                  </h3>
                  <div className="space-y-2.5">
                    {activeProject.detectedCharacters.map((dc) => (
                      <div
                        key={dc.id}
                        className="flex items-center gap-3 rounded-lg border border-white/[0.06] bg-[#0B0D11]/60 p-2.5"
                      >
                        {dc.thumbnailUrl ? (
                          <img
                            src={dc.thumbnailUrl}
                            alt={dc.label}
                            referrerPolicy="no-referrer"
                            className="h-12 w-12 rounded object-cover shrink-0 bg-[#171B24]"
                          />
                        ) : (
                          <div className="h-12 w-12 rounded bg-[#171B24] flex items-center justify-center shrink-0">
                            <Film className="h-4 w-4 text-slate-500" />
                          </div>
                        )}
                        <div className="min-w-0 flex-1">
                          <div className="text-xs font-medium text-slate-200 truncate">
                            {dc.label} · {dc.role === 'main' ? 'Main' : 'Secondary'}
                          </div>
                          <div className="text-[11px] text-slate-400 truncate">
                            {dc.actions}
                          </div>
                          <select
                            value={
                              activeProject.characterMapping[dc.id] ??
                              dc.matchedCharacterId ??
                              ''
                            }
                            onChange={(e) =>
                              void handleMappingChange(dc.id, e.target.value)
                            }
                            className="mt-1.5 w-full rounded border border-white/[0.1] bg-[#171B24] px-2 py-1 text-xs text-slate-200"
                          >
                            <option value="">Keep Original (Do Not Replace)</option>
                            {characters.map((c) => (
                              <option key={c.id} value={c.id}>
                                Replace with → {c.name}
                              </option>
                            ))}
                          </select>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Segment Grid + Per-Segment Retry & Identity Review Flags */}
              {activeProject.segments.length > 0 && (
                <div className="border-t border-white/[0.06] pt-4 space-y-2.5">
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-semibold uppercase tracking-wider text-slate-400">
                      Scene Segments ({activeProject.segments.length})
                    </span>
                    <span className="font-mono-tabular text-slate-400">
                      {activeProject.segments.filter((s) => s.status === 'completed').length}
                      /{activeProject.segments.length} ready
                    </span>
                  </div>
                  <div className="space-y-2 max-h-64 overflow-y-auto pr-1">
                    {activeProject.segments.map((seg) => (
                      <div
                        key={seg.index}
                        className="flex items-center gap-3 rounded-lg border border-white/[0.06] bg-[#0B0D11]/60 p-2.5"
                      >
                        {seg.keyframeUrl ? (
                          <img
                            src={seg.keyframeUrl}
                            alt={`Segment ${seg.index + 1}`}
                            referrerPolicy="no-referrer"
                            className="h-11 w-16 rounded object-cover shrink-0 bg-[#171B24]"
                          />
                        ) : (
                          <div className="h-11 w-16 rounded bg-[#171B24] shrink-0" />
                        )}
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-xs font-medium text-slate-200 font-mono-tabular">
                              Seg {seg.index + 1} · {seg.startSec.toFixed(1)}s–
                              {(seg.startSec + seg.durationSec).toFixed(1)}s
                            </span>
                            <span
                              className={`text-[11px] font-medium ${
                                seg.status === 'completed'
                                  ? 'text-emerald-400'
                                  : seg.status === 'failed'
                                    ? 'text-red-400'
                                    : seg.status === 'processing'
                                      ? 'text-[#E5A93C]'
                                      : 'text-slate-500'
                              }`}
                            >
                              {seg.status}
                            </span>
                          </div>
                          <div className="text-[10px] text-slate-500 font-mono-tabular truncate">
                            {seg.providerUsed} · {seg.modelUsed}
                            {seg.providerJobId ? ` · job:${seg.providerJobId.slice(0, 14)}` : ''}
                            {seg.providerJobStatus ? ` (${seg.providerJobStatus})` : ''}
                          </div>
                          {seg.errorMessage && (
                            <p className="text-[11px] text-red-400 mt-0.5 break-words">
                              {seg.errorMessage}
                            </p>
                          )}
                          {seg.consistencyCheck && seg.consistencyCheck.checked && (
                            <div
                              className={`text-[11px] mt-0.5 ${
                                seg.consistencyCheck.consistent &&
                                !seg.consistencyCheck.originalFaceStillPresent
                                  ? 'text-emerald-400'
                                  : 'text-amber-300'
                              }`}
                            >
                              <span>
                                QC ({seg.consistencyCheck.checkedFramesCount ?? 1} frames):{' '}
                                {typeof seg.consistencyCheck.identityScore === 'number'
                                  ? `Identity ${seg.consistencyCheck.identityScore}/100 · `
                                  : ''}
                                {seg.consistencyCheck.notes}
                              </span>
                            </div>
                          )}
                          {seg.consistencyCheck?.needsReview &&
                            !seg.consistencyCheck.checked && (
                              <p className="text-[11px] text-amber-300 mt-0.5">
                                {seg.consistencyCheck.notes}
                              </p>
                            )}
                        </div>
                        {(seg.status === 'failed' ||
                          seg.consistencyCheck?.needsReview) && (
                          <button
                            type="button"
                            onClick={() => void handleRetrySegment(seg.index)}
                            className="inline-flex items-center gap-1 rounded border border-white/[0.15] bg-[#171B24] px-2.5 py-1.5 text-[11px] font-medium text-slate-200 hover:border-[#E5A93C] shrink-0"
                          >
                            <RefreshCw className="h-3 w-3" />
                            Retry
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Stage 2/3/4 Extracted Frames, Feather Masks & Edited Frame Preview Strip */}
              {activeProject.pipelineState &&
                activeProject.pipelineState.frames.length > 0 && (
                  <div className="border-t border-white/[0.06] pt-4 space-y-2.5">
                    <div className="flex items-center justify-between text-xs">
                      <span className="font-semibold uppercase tracking-wider text-slate-400">
                        Frame Extraction, Masks &amp; Stage 4 Edits (
                        {activeProject.pipelineState.frames.length} @{' '}
                        {activeProject.pipelineState.samplingFps}fps)
                      </span>
                      <span className="font-mono-tabular text-slate-400">
                        {
                          activeProject.pipelineState.frames.filter(
                            (f) => f.status === 'edited' || f.status === 'reprocessed'
                          ).length
                        }
                        /{activeProject.pipelineState.frames.length} edited
                      </span>
                    </div>
                    <div className="space-y-2 max-h-72 overflow-y-auto pr-1">
                      {activeProject.pipelineState.frames.slice(0, 12).map((fr) => (
                        <div
                          key={fr.index}
                          className="rounded-lg border border-white/[0.06] bg-[#0B0D11]/60 p-2.5 space-y-2"
                        >
                          <div className="flex items-center justify-between text-[11px] font-mono-tabular">
                            <span className="text-slate-200 font-medium">
                              Frame #{fr.index + 1} · {fr.timestampSec.toFixed(2)}s
                            </span>
                            <div className="flex items-center gap-2">
                              {typeof fr.ssimVsSource === 'number' && (
                                <span className="text-slate-400">
                                  SSIM {fr.ssimVsSource.toFixed(3)}
                                </span>
                              )}
                              <span
                                className={
                                  fr.status === 'edited' || fr.status === 'reprocessed'
                                    ? 'text-emerald-400'
                                    : fr.status === 'failed'
                                      ? 'text-red-400'
                                      : 'text-amber-300'
                                }
                              >
                                {fr.status}
                              </span>
                            </div>
                          </div>
                          <div className="grid grid-cols-3 gap-2">
                            <div className="space-y-1">
                              <img
                                src={fr.sourceFrameUrl}
                                alt={`Source frame ${fr.index + 1}`}
                                referrerPolicy="no-referrer"
                                className="h-14 w-full rounded object-cover bg-[#171B24]"
                              />
                              <div className="text-[10px] text-slate-500 text-center">Source</div>
                            </div>
                            <div className="space-y-1">
                              {fr.unionMaskUrl ? (
                                <img
                                  src={fr.unionMaskUrl}
                                  alt={`Mask frame ${fr.index + 1}`}
                                  referrerPolicy="no-referrer"
                                  className="h-14 w-full rounded object-cover bg-[#171B24]"
                                />
                              ) : (
                                <div className="h-14 w-full rounded bg-[#171B24] flex items-center justify-center text-[10px] text-slate-600">
                                  None
                                </div>
                              )}
                              <div className="text-[10px] text-slate-500 text-center">Feather Mask</div>
                            </div>
                            <div className="space-y-1">
                              {fr.editedFrameUrl ? (
                                <img
                                  src={fr.editedFrameUrl}
                                  alt={`Edited frame ${fr.index + 1}`}
                                  referrerPolicy="no-referrer"
                                  className="h-14 w-full rounded object-cover bg-[#171B24]"
                                />
                              ) : (
                                <div className="h-14 w-full rounded bg-[#171B24] flex items-center justify-center text-[10px] text-slate-600">
                                  Pending Stage 4
                                </div>
                              )}
                              <div className="text-[10px] text-slate-500 text-center">Replaced</div>
                            </div>
                          </div>
                          {fr.tracks.length > 0 && (
                            <div className="text-[10px] text-slate-400 truncate">
                              {fr.tracks
                                .map(
                                  (tr) =>
                                    `${tr.label}: bbox[${tr.bbox.join(',')}] · ${tr.poseSummary}`
                                )
                                .join(' | ')}
                            </div>
                          )}
                          {fr.errorMessage && (
                            <p className="text-[10px] text-red-400 break-words">
                              {fr.errorMessage}
                            </p>
                          )}
                        </div>
                      ))}
                      {activeProject.pipelineState.frames.length > 12 && (
                        <p className="text-[11px] text-slate-500 text-center">
                          Showing 12 of {activeProject.pipelineState.frames.length} extracted frames.
                        </p>
                      )}
                    </div>
                  </div>
                )}

              {/* 7-Point Character Replacement QC Verification Summary */}
              {activeProject.qcSummary && (
                <div
                  className={`rounded-lg border p-3.5 text-xs space-y-2.5 ${
                    activeProject.qcSummary.passed
                      ? 'border-emerald-500/30 bg-emerald-950/20 text-emerald-200'
                      : 'border-red-500/35 bg-red-950/25 text-red-200'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2 font-medium">
                    <span className="inline-flex items-center gap-1.5">
                      {activeProject.qcSummary.passed ? (
                        <CheckCircle2 className="h-4 w-4 text-emerald-400" />
                      ) : (
                        <AlertTriangle className="h-4 w-4 text-red-400" />
                      )}
                      {activeProject.qcSummary.passed
                        ? '7-Point Replacement QC Passed'
                        : 'Character Replacement QC Failed'}
                    </span>
                    <span className="font-mono-tabular text-[11px]">
                      {activeProject.qcSummary.inspectedFrames} frames ·{' '}
                      {typeof activeProject.qcSummary.minIdentityScore === 'number'
                        ? `Identity ${activeProject.qcSummary.minIdentityScore}/100`
                        : 'Checked'}
                    </span>
                  </div>
                  <div className="grid grid-cols-2 gap-1.5 text-[11px] font-mono-tabular border-t border-white/[0.08] pt-2">
                    <div className="flex justify-between gap-1">
                      <span className="text-slate-300/80">1. Orig Face Gone:</span>
                      <span
                        className={
                          !activeProject.qcSummary.originalFaceStillPresent
                            ? 'text-emerald-300'
                            : 'text-red-300'
                        }
                      >
                        {!activeProject.qcSummary.originalFaceStillPresent ? 'Pass' : 'Fail'}
                      </span>
                    </div>
                    <div className="flex justify-between gap-1">
                      <span className="text-slate-300/80">2. Identity Match:</span>
                      <span
                        className={
                          (activeProject.qcSummary.minIdentityScore ?? 0) >= 60
                            ? 'text-emerald-300'
                            : 'text-amber-300'
                        }
                      >
                        {activeProject.qcSummary.minIdentityScore ?? '—'}/100
                      </span>
                    </div>
                    <div className="flex justify-between gap-1">
                      <span className="text-slate-300/80">3. Anatomy Valid:</span>
                      <span
                        className={
                          activeProject.qcSummary.anatomicalValid !== false
                            ? 'text-emerald-300'
                            : 'text-red-300'
                        }
                      >
                        {activeProject.qcSummary.anatomicalValid !== false ? 'Pass' : 'Fail'}
                      </span>
                    </div>
                    <div className="flex justify-between gap-1">
                      <span className="text-slate-300/80">4. Motion Matched:</span>
                      <span
                        className={
                          activeProject.qcSummary.motionMatched !== false
                            ? 'text-emerald-300'
                            : 'text-red-300'
                        }
                      >
                        {activeProject.qcSummary.motionMatched !== false ? 'Pass' : 'Fail'}
                      </span>
                    </div>
                    <div className="flex justify-between gap-1">
                      <span className="text-slate-300/80">5. Temporal Stable:</span>
                      <span
                        className={
                          activeProject.qcSummary.temporalFlickerDetected !== true
                            ? 'text-emerald-300'
                            : 'text-red-300'
                        }
                      >
                        {activeProject.qcSummary.temporalFlickerDetected !== true ? 'Pass' : 'Flicker'}
                      </span>
                    </div>
                    <div className="flex justify-between gap-1">
                      <span className="text-slate-300/80">6. Scene Intact:</span>
                      <span
                        className={
                          activeProject.qcSummary.backgroundDamaged !== true
                            ? 'text-emerald-300'
                            : 'text-red-300'
                        }
                      >
                        {activeProject.qcSummary.backgroundDamaged !== true ? 'Pass' : 'Damaged'}
                      </span>
                    </div>
                    <div className="col-span-2 flex justify-between gap-1">
                      <span className="text-slate-300/80">7. Playable MP4 &amp; Diff Verified:</span>
                      <span
                        className={
                          activeProject.qcSummary.playableVerified === true
                            ? 'text-emerald-300'
                            : 'text-amber-300'
                        }
                      >
                        {activeProject.qcSummary.playableVerified === true ? 'Verified' : 'Pending'}
                      </span>
                    </div>
                  </div>
                  {activeProject.qcSummary.issues.length > 0 && (
                    <ul className="list-disc pl-4 space-y-0.5 text-[11px] border-t border-white/[0.08] pt-2">
                      {activeProject.qcSummary.issues.map((iss) => (
                        <li key={iss}>{iss}</li>
                      ))}
                    </ul>
                  )}
                </div>
              )}

              {/* Final Output Preview & Genuine Download Buttons */}
              {activeProject.status === 'completed' &&
                activeProject.outputVideoUrl && (
                  <div className="border-t border-white/[0.08] pt-4 space-y-3">
                    <div className="flex items-center justify-between text-xs text-emerald-400 font-medium">
                      <span className="inline-flex items-center gap-1.5">
                        <Video className="h-4 w-4" />
                        Validated Output Ready
                      </span>
                      {activeProject.outputVideoMetadata && (
                        <span className="font-mono-tabular text-slate-300">
                          {activeProject.outputVideoMetadata.width}×
                          {activeProject.outputVideoMetadata.height}
                          {activeProject.resolution === '1080p' &&
                          !activeProject.outputVideoMetadata.isNative1080p
                            ? ' (Mastered)'
                            : ''}{' '}
                          · {activeProject.outputVideoMetadata.durationSec}s ·{' '}
                          {formatBytes(
                            activeProject.outputVideoMetadata.fileSizeBytes
                          )}
                        </span>
                      )}
                    </div>

                    <div className="overflow-hidden rounded-lg border border-white/[0.1] bg-black">
                      <video
                        src={activeProject.outputVideoUrl}
                        controls
                        className="w-full max-h-[280px] object-contain"
                      />
                    </div>

                    <div className="flex flex-wrap gap-2.5">
                      <button
                        type="button"
                        disabled={downloadingVideo}
                        onClick={() => void handleVerifiedMp4Download(activeProject)}
                        className="flex-1 inline-flex items-center justify-center gap-2 rounded-lg bg-emerald-600 px-4 py-2.5 text-xs font-semibold text-white hover:bg-emerald-500 disabled:opacity-50 transition-colors whitespace-nowrap"
                      >
                        {downloadingVideo ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <Download className="h-4 w-4" />
                        )}
                        {downloadingVideo ? 'Verifying MP4...' : t.actions.downloadMp4}
                      </button>
                      {activeProject.outputAudioUrl && (
                        <a
                          href={`/api/projects/${activeProject.id}/download/audio`}
                          download
                          className="inline-flex items-center justify-center gap-2 rounded-lg border border-white/[0.12] bg-[#171B24] px-4 py-2.5 text-xs font-medium text-slate-200 hover:border-white/[0.25] transition-colors whitespace-nowrap"
                        >
                          <Music className="h-4 w-4 text-[#E5A93C]" />
                          {t.actions.downloadAudio}
                        </a>
                      )}
                    </div>
                  </div>
                )}
            </section>
          )}
        </div>
      </div>

      {/* MANDATORY EXPLICIT PAID MODEL CONFIRMATION MODAL */}
      {paidModalOpen && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4"
        >
          <div className="w-full max-w-md rounded-xl border border-white/[0.12] bg-[#11141B] p-6 space-y-4">
            <div className="flex items-start gap-3">
              <AlertTriangle className="h-5 w-5 text-[#E5A93C] shrink-0 mt-0.5" />
              <div>
                <h3 className="text-base font-semibold text-slate-100">
                  Confirm Paid AI Video Generation
                </h3>
                <p className="text-xs text-slate-400 mt-1">
                  This operation uses paid-tier generative models billed to your attached provider key.
                </p>
              </div>
            </div>

            <div className="rounded-lg border border-white/[0.08] bg-[#0B0D11] p-3.5 text-xs space-y-2 font-mono-tabular">
              <div className="flex justify-between">
                <span className="text-slate-400">Provider:</span>
                <span className="text-slate-200">
                  {topAutoCandidate?.providerName ?? 'Google Gemini API'}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-400">Video Model:</span>
                <span className="text-slate-200">
                  {topAutoCandidate?.modelId ?? 'gemini-omni-1.2-flash'}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-400">Output Duration:</span>
                <span className="text-slate-200">
                  {sourceVideo?.durationSec ?? 0}s ({estimatedSegments} segments)
                </span>
              </div>
              <div className="flex justify-between border-t border-white/[0.08] pt-2">
                <span className="text-slate-400">Estimated Cost:</span>
                <span className="text-[#E5A93C] font-semibold">
                  ~${estimatedPaidCost.toFixed(2)} USD
                </span>
              </div>
            </div>

            <label className="flex items-start gap-2.5 text-xs text-slate-300 cursor-pointer">
              <input
                type="checkbox"
                checked={paidCheckbox}
                onChange={(e) => setPaidCheckbox(e.target.checked)}
                className="mt-0.5 rounded border-white/20 bg-[#0B0D11]"
              />
              <span>
                I confirm that I want to execute paid generation using my billing-enabled provider key.
              </span>
            </label>

            <div className="flex items-center justify-end gap-2.5 pt-2">
              <button
                type="button"
                onClick={() => {
                  setPaidModalOpen(false);
                  setPendingPaidProjectId(null);
                }}
                className="rounded-lg border border-white/[0.12] px-4 py-2 text-xs font-medium text-slate-300 hover:text-white"
              >
                Cancel (Stay in Free Mode)
              </button>
              <button
                type="button"
                disabled={!paidCheckbox}
                onClick={() => void confirmAndRunPaid()}
                className="rounded-lg bg-[#E5A93C] px-4 py-2 text-xs font-semibold text-[#0B0D11] hover:bg-[#F0B84D] disabled:opacity-40"
              >
                Confirm &amp; Generate
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
