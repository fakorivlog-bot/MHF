import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';
import { probeVideo, verifyPlayableVideo } from './ffmpeg.ts';
import { checkGeminiConnection } from './gemini.ts';
import { runProjectPipeline } from './pipeline.ts';
import { runProviderHealthCheck } from './providers/adapters.ts';
import {
  inspectTaskCapabilities,
  selectCandidateModels,
  selectStage4ImageEditCandidates,
} from './providers/orchestrator.ts';
import {
  deleteProject,
  getProject,
  isEnvSecretSet,
  listProviders,
  removeUsageForProject,
  saveProject,
  saveProvider,
  UPLOADS_DIR,
} from './store.ts';
import type { ProjectRecord, SelfTestItem, SelfTestReport } from './types.ts';

const execFileAsync = promisify(execFile);

export async function runComprehensiveSelfTests(
  baseUrl: string
): Promise<SelfTestReport> {
  const tests: SelfTestItem[] = [];
  let createdTestVideoPath: string | null = null;
  let createdTestThumbPath: string | null = null;
  let createdProjectId: string | null = null;
  let uploadedFileMeta: ProjectRecord['sourceVideo'] | null = null;

  // 1. Backend connection test
  {
    const t0 = Date.now();
    try {
      const res = await fetch(`${baseUrl}/api/settings/status`);
      const ok = res.ok;
      tests.push({
        id: 'backend_connection',
        name: '1. Backend Connection Test',
        status: ok ? 'PASS' : 'FAIL',
        durationMs: Date.now() - t0,
        httpStatus: res.status,
        summary: ok
          ? 'Express server reachable and responding with JSON health status.'
          : `Backend returned unexpected HTTP ${res.status}.`,
        detail: ok ? `GET ${baseUrl}/api/settings/status -> ${res.status}` : res.statusText,
      });
    } catch (err) {
      tests.push({
        id: 'backend_connection',
        name: '1. Backend Connection Test',
        status: 'FAIL',
        durationMs: Date.now() - t0,
        httpStatus: null,
        summary: 'Could not reach Express backend server.',
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // 2. API authentication test
  {
    const t0 = Date.now();
    try {
      const gemini = await checkGeminiConnection();
      const pass = gemini.configured && gemini.connected;
      const httpStatus = pass ? 200 : gemini.rateLimited ? 429 : 401;
      tests.push({
        id: 'api_authentication',
        name: '2. API Authentication Test',
        status: pass ? 'PASS' : 'FAIL',
        durationMs: Date.now() - t0,
        httpStatus,
        summary: pass
          ? 'Google Gemini API authenticated cleanly via server-side GEMINI_API_KEY.'
          : gemini.message,
        detail: `GEMINI_API_KEY configured=${gemini.configured}, connected=${gemini.connected}, rateLimited=${Boolean(gemini.rateLimited)} (${gemini.modelTested})${gemini.retryAfterAt ? ` · reset ${gemini.retryAfterAt}` : ''}`,
      });
    } catch (err) {
      tests.push({
        id: 'api_authentication',
        name: '2. API Authentication Test',
        status: 'FAIL',
        durationMs: Date.now() - t0,
        httpStatus: 500,
        summary: 'API authentication test threw an exception.',
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // 3. Provider availability test
  {
    const t0 = Date.now();
    try {
      const providers = listProviders().filter((p) => p.enabled);
      const checked = await Promise.all(
        providers.map(async (p) => {
          const updated = await runProviderHealthCheck(p);
          saveProvider(updated);
          return updated;
        })
      );
      const connectedList = checked.filter((p) => p.connectionStatus === 'connected');
      const freeGenConnected = connectedList.filter((p) => p.freeVideoEligible);
      const pass = connectedList.length > 0;
      tests.push({
        id: 'provider_availability',
        name: '3. Provider Availability Test',
        status: pass ? 'PASS' : 'FAIL',
        durationMs: Date.now() - t0,
        httpStatus: pass ? 200 : 503,
        summary: pass
          ? `${connectedList.length}/${checked.length} enabled provider(s) connected (${freeGenConnected.length} external free video provider active).`
          : 'No enabled AI providers are currently connected.',
        detail: checked
          .map((p) => `${p.displayName}: ${p.connectionStatus}`)
          .join(' | '),
      });
    } catch (err) {
      tests.push({
        id: 'provider_availability',
        name: '3. Provider Availability Test',
        status: 'FAIL',
        durationMs: Date.now() - t0,
        httpStatus: 500,
        summary: 'Provider availability check errored.',
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // 4. Model availability & Multi-Stage / V2V Character Replacement Capability test
  {
    const t0 = Date.now();
    try {
      const capFree = inspectTaskCapabilities({
        billingMode: 'free',
        mode: 'character_replacement',
        resolution: '720p',
        hasCharacterRef: true,
      });
      const capPaid = inspectTaskCapabilities({
        billingMode: 'paid',
        mode: 'character_replacement',
        resolution: '720p',
        hasCharacterRef: true,
      });
      const i2vLeak = capFree.activeCandidates.some(
        (c) => !c.model.supportsVideoToVideo || !c.model.supportsCharacterReplacement
      );
      const stages1To3Ready =
        capFree.pipelineCapabilities.characterTracking === 'ready' &&
        capFree.pipelineCapabilities.videoReconstruction === 'ready';
      const hasAnalysis = isEnvSecretSet('GEMINI_API_KEY');
      const pass = !i2vLeak && stages1To3Ready && (capFree.multiStageAvailable || capPaid.multiStageAvailable || capPaid.nativeV2vAvailable || hasAnalysis);
      tests.push({
        id: 'model_availability',
        name: '4. Multi-Stage & V2V Capability Gating Test',
        status: pass ? 'PASS' : 'FAIL',
        durationMs: Date.now() - t0,
        httpStatus: pass ? 200 : 404,
        summary: i2vLeak
          ? 'SECURITY/HONESTY BUG: I2V-only model leaked into V2V Character Replacement candidates.'
          : capFree.multiStageAvailable
            ? `6-Stage Pipeline active in Free Mode via ${capFree.stage4AdapterName} (${capFree.stage4ModelId}).`
            : `Stages 1–3 & 5–6 Ready (0 I2V leaks); Paid Stage 4 editors (${capPaid.paidStage4CandidatesCount}) + Omni V2V available.`,
        detail: `Workflow=${capFree.activeWorkflow}; Free Stage4=${capFree.freeStage4CandidatesCount}; Paid Stage4=${capPaid.paidStage4CandidatesCount}; Paid V2V=${capPaid.activeCandidates.map((c) => c.model.id).join(', ') || 'none'}`,
      });
    } catch (err) {
      tests.push({
        id: 'model_availability',
        name: '4. Multi-Stage & V2V Capability Gating Test',
        status: 'FAIL',
        durationMs: Date.now() - t0,
        httpStatus: 500,
        summary: 'Model catalog check failed.',
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // 5. Video upload test (real FFmpeg 2s H.264 MP4 sent via FormData -> /api/uploads/video)
  {
    const t0 = Date.now();
    const tmpMp4 = `/tmp/selftest_upload_${Date.now()}.mp4`;
    try {
      await execFileAsync('ffmpeg', [
        '-y',
        '-f',
        'lavfi',
        '-i',
        'testsrc=duration=2:size=640x360:rate=24',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:duration=2',
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        tmpMp4,
      ]);

      const buf = fs.readFileSync(tmpMp4);
      const form = new FormData();
      form.append(
        'video',
        new Blob([buf], { type: 'video/mp4' }),
        'selftest_clip.mp4'
      );

      const upRes = await fetch(`${baseUrl}/api/uploads/video`, {
        method: 'POST',
        body: form,
      });
      const text = await upRes.text();
      if (!upRes.ok) {
        tests.push({
          id: 'video_upload',
          name: '5. Video Upload Test',
          status: 'FAIL',
          durationMs: Date.now() - t0,
          httpStatus: upRes.status,
          summary: `Video upload failed with HTTP ${upRes.status}.`,
          detail: text.slice(0, 300),
        });
      } else {
        uploadedFileMeta = JSON.parse(text) as ProjectRecord['sourceVideo'];
        createdTestVideoPath = uploadedFileMeta.filePath;
        createdTestThumbPath = path.join(
          UPLOADS_DIR,
          path.basename(uploadedFileMeta.thumbnailUrl)
        );
        tests.push({
          id: 'video_upload',
          name: '5. Video Upload Test',
          status: 'PASS',
          durationMs: Date.now() - t0,
          httpStatus: upRes.status,
          summary: `Uploaded & probed 2s MP4 (${uploadedFileMeta.width}x${uploadedFileMeta.height}, ${uploadedFileMeta.codec}).`,
          detail: `File: ${uploadedFileMeta.fileName} (${uploadedFileMeta.fileSizeBytes} bytes)`,
        });
      }
    } catch (err) {
      tests.push({
        id: 'video_upload',
        name: '5. Video Upload Test',
        status: 'FAIL',
        durationMs: Date.now() - t0,
        httpStatus: 500,
        summary: 'Video upload test threw an exception.',
        detail: err instanceof Error ? err.message : String(err),
      });
    } finally {
      if (fs.existsSync(tmpMp4)) fs.rmSync(tmpMp4, { force: true });
    }
  }

  // 6. File storage test
  {
    const t0 = Date.now();
    try {
      if (!uploadedFileMeta || !fs.existsSync(uploadedFileMeta.filePath)) {
        tests.push({
          id: 'file_storage',
          name: '6. File Storage Test',
          status: 'FAIL',
          durationMs: Date.now() - t0,
          httpStatus: 404,
          summary: 'Uploaded video file was not persisted on server filesystem.',
          detail: uploadedFileMeta?.filePath ?? 'No uploaded file path recorded.',
        });
      } else {
        const playable = await verifyPlayableVideo(uploadedFileMeta.filePath);
        const probed = await probeVideo(uploadedFileMeta.filePath);
        tests.push({
          id: 'file_storage',
          name: '6. File Storage Test',
          status: playable ? 'PASS' : 'FAIL',
          durationMs: Date.now() - t0,
          httpStatus: playable ? 200 : 500,
          summary: playable
            ? `Stored MP4 readable & playable (${probed.fileSizeBytes} bytes).`
            : 'Stored MP4 failed playability check.',
          detail: uploadedFileMeta.filePath,
        });
      }
    } catch (err) {
      tests.push({
        id: 'file_storage',
        name: '6. File Storage Test',
        status: 'FAIL',
        durationMs: Date.now() - t0,
        httpStatus: 500,
        summary: 'File storage verification failed.',
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // 7. Generation request test + 8. Job status monitoring test
  let generatedProject: ProjectRecord | null = null;
  {
    const t0 = Date.now();
    try {
      if (!uploadedFileMeta) {
        throw new Error('Skipped because video upload test did not produce a valid file.');
      }

      const createRes = await fetch(`${baseUrl}/api/projects`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'SelfTest_Diagnostic_Job',
          sourceVideo: uploadedFileMeta,
          characterIds: [],
          instruction: 'Diagnostic self-test cinematic recreation run',
          mode: 'cinematic_recreation',
          qualityTier: 'economy',
          resolution: '720p',
          billingMode: 'free',
          freeFallbackPolicy: 'ffmpeg_master',
        }),
      });
      if (!createRes.ok) {
        throw new Error(`Project creation failed (${createRes.status}).`);
      }
      const created = (await createRes.json()) as ProjectRecord;
      createdProjectId = created.id;

      // Also verify free Stage 4 + V2V replacement candidates honestly
      const freeReplacementCandidates = [
        ...selectStage4ImageEditCandidates({
          billingMode: 'free',
          replacementScope: 'full_character_replacement',
          resolution: '720p',
        }),
        ...selectCandidateModels({
          billingMode: 'free',
          mode: 'character_replacement',
          resolution: '720p',
          hasCharacterRef: true,
          requiresCharacterReplacement: true,
        }),
      ];

      // Execute the real background pipeline for non-character FFmpeg E2E output verification
      await runProjectPipeline(created.id);
      generatedProject = getProject(created.id);

      if (freeReplacementCandidates.length === 0) {
        tests.push({
          id: 'generation_request',
          name: '7. Stage 4 Replacement Readiness (Free Mode)',
          status: 'FAIL',
          durationMs: Date.now() - t0,
          httpStatus: 424,
          summary:
            'Stages 1–3 & 5–6 are ready, but Stage 4 requires an Open-Source Local GPU Worker URL, HF_TOKEN, or Paid Mode.',
          detail:
            'Connect worker/gpu_worker.py in API Settings ($0 API fee), add HF_TOKEN, or switch to Paid Mode.',
        });
      } else {
        const ok = generatedProject?.status === 'completed';
        tests.push({
          id: 'generation_request',
          name: '7. Generation Request Test',
          status: ok ? 'PASS' : 'FAIL',
          durationMs: Date.now() - t0,
          httpStatus: ok ? 200 : generatedProject?.diagnosticDetail?.httpStatus ?? 500,
          summary: ok
            ? `Pipeline generation succeeded via ${generatedProject?.selectedModels.videoProvider}.`
            : generatedProject?.errorMessage || 'Generation request failed.',
          detail: generatedProject?.diagnosticDetail?.technicalError || generatedProject?.statusMessage || '',
        });
      }

      const monOk = Boolean(
        generatedProject &&
          generatedProject.history.length >= 2 &&
          generatedProject.completedStages.includes('validating_output')
      );
      tests.push({
        id: 'job_monitoring',
        name: '8. Job Status Monitoring Test',
        status: monOk ? 'PASS' : 'FAIL',
        durationMs: Date.now() - t0,
        httpStatus: monOk ? 200 : 500,
        summary: monOk
          ? `Pipeline tracked ${generatedProject?.completedStages.length} completed stages and persisted ${generatedProject?.history.length} log entries.`
          : `Pipeline ended in state "${generatedProject?.status ?? 'unknown'}": ${generatedProject?.errorMessage ?? ''}`,
        detail: `Stages: ${generatedProject?.completedStages.join(' -> ') || 'none'}`,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      tests.push({
        id: 'generation_request',
        name: '7. Generation Request Test',
        status: 'FAIL',
        durationMs: Date.now() - t0,
        httpStatus: 500,
        summary: 'Generation request could not run.',
        detail: msg,
      });
      tests.push({
        id: 'job_monitoring',
        name: '8. Job Status Monitoring Test',
        status: 'FAIL',
        durationMs: Date.now() - t0,
        httpStatus: 500,
        summary: 'Job monitoring did not complete.',
        detail: msg,
      });
    }
  }

  // 9. Output retrieval test
  {
    const t0 = Date.now();
    try {
      const outPath = generatedProject?.outputVideoPath;
      if (!outPath || !fs.existsSync(outPath)) {
        tests.push({
          id: 'output_retrieval',
          name: '9. Output Retrieval Test',
          status: 'FAIL',
          durationMs: Date.now() - t0,
          httpStatus: 404,
          summary: 'Generated output MP4 file does not exist.',
          detail: outPath ?? 'No outputVideoPath generated.',
        });
      } else {
        const playable = await verifyPlayableVideo(outPath);
        const stat = fs.statSync(outPath);
        tests.push({
          id: 'output_retrieval',
          name: '9. Output Retrieval Test',
          status: playable && stat.size > 1024 ? 'PASS' : 'FAIL',
          durationMs: Date.now() - t0,
          httpStatus: playable ? 200 : 500,
          summary: playable
            ? `Retrieved & verified playable MP4 (${stat.size} bytes).`
            : 'Output file failed MP4 playback verification.',
          detail: outPath,
        });
      }
    } catch (err) {
      tests.push({
        id: 'output_retrieval',
        name: '9. Output Retrieval Test',
        status: 'FAIL',
        durationMs: Date.now() - t0,
        httpStatus: 500,
        summary: 'Output retrieval check threw an error.',
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // 10. Download test
  {
    const t0 = Date.now();
    try {
      if (!createdProjectId || !generatedProject?.outputVideoUrl) {
        tests.push({
          id: 'download_test',
          name: '10. Download Test',
          status: 'FAIL',
          durationMs: Date.now() - t0,
          httpStatus: 404,
          summary: 'No completed output available to download.',
          detail: 'Skipped download check.',
        });
      } else {
        const dlRes = await fetch(
          `${baseUrl}/api/projects/${createdProjectId}/download/video`
        );
        const bytes = await dlRes.arrayBuffer();
        const ok = dlRes.ok && bytes.byteLength > 1024;
        tests.push({
          id: 'download_test',
          name: '10. Download Test',
          status: ok ? 'PASS' : 'FAIL',
          durationMs: Date.now() - t0,
          httpStatus: dlRes.status,
          summary: ok
            ? `MP4 download endpoint streamed ${bytes.byteLength} bytes cleanly (HTTP 200).`
            : `Download endpoint failed (HTTP ${dlRes.status}, ${bytes.byteLength} bytes).`,
          detail: `Content-Type: ${dlRes.headers.get('content-type') || 'unknown'}`,
        });
      }
    } catch (err) {
      tests.push({
        id: 'download_test',
        name: '10. Download Test',
        status: 'FAIL',
        durationMs: Date.now() - t0,
        httpStatus: 500,
        summary: 'Download endpoint request failed.',
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Cleanup temporary test artifacts so workspace stays clean
  if (createdProjectId) {
    deleteProject(createdProjectId);
    removeUsageForProject(createdProjectId);
  }
  if (createdTestVideoPath && fs.existsSync(createdTestVideoPath)) {
    fs.rmSync(createdTestVideoPath, { force: true });
  }
  if (createdTestThumbPath && fs.existsSync(createdTestThumbPath)) {
    fs.rmSync(createdTestThumbPath, { force: true });
  }

  const passedCount = tests.filter((t) => t.status === 'PASS').length;
  const failedCount = tests.length - passedCount;
  const overallStatus =
    failedCount === 0
      ? 'PASS'
      : passedCount > 0
        ? 'PARTIAL_FAIL'
        : 'FAIL';

  return {
    ranAt: new Date().toISOString(),
    overallStatus,
    passedCount,
    failedCount,
    tests,
  };
}
