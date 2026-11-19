import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';
import zlib from 'zlib';
import type {
  AudioMode,
  OutputAspectRatio,
  OutputResolution,
  ReplacementScope,
} from './types.ts';

const execFileAsync = promisify(execFile);

export interface ProbedVideo {
  durationSec: number;
  width: number;
  height: number;
  fps: number;
  codec: string;
  hasAudio: boolean;
  fileSizeBytes: number;
  verifiedPlayable: boolean;
}

const SUPPORTED_VIDEO_CODECS = new Set([
  'h264',
  'avc1',
  'hevc',
  'h265',
  'vp8',
  'vp9',
  'av1',
  'mpeg4',
  'prores',
  'mjpeg',
  'mpeg2video',
  'theora',
]);

function parseFps(rateStr?: string): number {
  if (!rateStr || !rateStr.includes('/')) return 24;
  const [numStr, denStr] = rateStr.split('/');
  const num = Number(numStr);
  const den = Number(denStr);
  if (!den || Number.isNaN(num) || Number.isNaN(den)) return 24;
  return Math.round((num / den) * 100) / 100;
}

export async function verifyPlayableVideo(filePath: string): Promise<boolean> {
  if (!fs.existsSync(filePath) || fs.statSync(filePath).size < 256) {
    return false;
  }
  try {
    await execFileAsync(
      'ffmpeg',
      ['-v', 'error', '-i', filePath, '-frames:v', '1', '-f', 'null', '-'],
      { timeout: 20000 }
    );
    return true;
  } catch {
    return false;
  }
}

export async function probeVideo(filePath: string): Promise<ProbedVideo> {
  if (!fs.existsSync(filePath)) {
    throw new Error('Video file does not exist on disk.');
  }
  const stat = fs.statSync(filePath);
  if (stat.size < 256) {
    throw new Error('Uploaded file is empty or too small to be a valid video.');
  }

  let stdout = '';
  try {
    const res = await execFileAsync(
      'ffprobe',
      [
        '-v',
        'quiet',
        '-print_format',
        'json',
        '-show_format',
        '-show_streams',
        filePath,
      ],
      { timeout: 30000 }
    );
    stdout = res.stdout;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`File integrity check failed (ffprobe could not read container): ${msg}`);
  }

  const parsed = JSON.parse(stdout) as {
    format?: { duration?: string };
    streams?: Array<{
      codec_type?: string;
      codec_name?: string;
      width?: number;
      height?: number;
      r_frame_rate?: string;
      avg_frame_rate?: string;
      duration?: string;
    }>;
  };

  const streams = parsed.streams ?? [];
  const videoStream = streams.find((s) => s.codec_type === 'video');
  if (!videoStream) {
    throw new Error('Uploaded file does not contain a valid video stream.');
  }

  const codec = (videoStream.codec_name ?? 'unknown').toLowerCase();
  if (codec !== 'unknown' && !SUPPORTED_VIDEO_CODECS.has(codec)) {
    throw new Error(
      `Unsupported video codec "${codec}". Please upload an H.264/HEVC MP4, MOV, or VP8/VP9 WEBM file.`
    );
  }

  const width = videoStream.width ?? 0;
  const height = videoStream.height ?? 0;
  if (width <= 0 || height <= 0) {
    throw new Error('Video stream has invalid frame dimensions.');
  }

  const audioStream = streams.find((s) => s.codec_type === 'audio');
  const durationRaw =
    Number(parsed.format?.duration) || Number(videoStream.duration) || 0;
  if (!Number.isFinite(durationRaw) || durationRaw <= 0.1) {
    throw new Error('Video duration could not be determined or clip is shorter than 0.1s.');
  }

  const playable = await verifyPlayableVideo(filePath);
  if (!playable) {
    throw new Error('Video file appears corrupted or unplayable (frame decode check failed).');
  }

  return {
    durationSec: Math.round(durationRaw * 100) / 100,
    width,
    height,
    fps: parseFps(videoStream.avg_frame_rate || videoStream.r_frame_rate),
    codec,
    hasAudio: Boolean(audioStream),
    fileSizeBytes: stat.size,
    verifiedPlayable: true,
  };
}

export async function extractThumbnail(
  videoPath: string,
  outPath: string,
  timestampSec = 0.5
): Promise<void> {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  try {
    await execFileAsync(
      'ffmpeg',
      [
        '-y',
        '-ss',
        String(Math.max(0, timestampSec)),
        '-i',
        videoPath,
        '-frames:v',
        '1',
        '-q:v',
        '2',
        outPath,
      ],
      { timeout: 30000 }
    );
  } catch {
    // Fallback to frame 0 if timestamp seek fails near EOF
    await execFileAsync(
      'ffmpeg',
      ['-y', '-i', videoPath, '-frames:v', '1', '-q:v', '2', outPath],
      { timeout: 30000 }
    );
  }
}

export async function extractKeyframes(
  videoPath: string,
  timestampsSec: number[],
  outDir: string
): Promise<string[]> {
  fs.mkdirSync(outDir, { recursive: true });
  const paths: string[] = [];
  for (let i = 0; i < timestampsSec.length; i++) {
    const outPath = path.join(outDir, `frame_${i}.jpg`);
    try {
      await extractThumbnail(videoPath, outPath, timestampsSec[i]);
    } catch {
      // Ignore single frame failure if others exist
    }
    if (fs.existsSync(outPath) && fs.statSync(outPath).size > 0) {
      paths.push(outPath);
    }
  }
  if (paths.length === 0) {
    const fallbackPath = path.join(outDir, 'frame_0.jpg');
    await extractThumbnail(videoPath, fallbackPath, 0);
    if (fs.existsSync(fallbackPath) && fs.statSync(fallbackPath).size > 0) {
      paths.push(fallbackPath);
    }
  }
  return paths;
}

export async function detectSceneSegments(
  videoPath: string,
  totalDurationSec: number,
  maxSegmentSec = 10,
  minSegmentSec = 3
): Promise<Array<{ startSec: number; durationSec: number }>> {
  const cutPoints: number[] = [0];
  try {
    const { stderr } = await execFileAsync(
      'ffmpeg',
      [
        '-i',
        videoPath,
        '-vf',
        "select='gt(scene,0.32)',showinfo",
        '-f',
        'null',
        '-',
      ],
      { maxBuffer: 1024 * 1024 * 16 }
    );
    const matches = stderr.matchAll(/pts_time:([0-9]+(?:\.[0-9]+)?)/g);
    for (const m of matches) {
      const t = Number(m[1]);
      if (
        Number.isFinite(t) &&
        t - cutPoints[cutPoints.length - 1] >= minSegmentSec &&
        totalDurationSec - t >= minSegmentSec
      ) {
        cutPoints.push(Math.round(t * 100) / 100);
      }
    }
  } catch {
    // Fallback to uniform scene segmentation below
  }

  // Enforce maxSegmentSec ceiling on every scene interval
  const segments: Array<{ startSec: number; durationSec: number }> = [];
  const boundaries = [...cutPoints, totalDurationSec];

  for (let i = 0; i < boundaries.length - 1; i++) {
    let segStart = boundaries[i];
    const segEnd = boundaries[i + 1];
    while (segEnd - segStart > maxSegmentSec) {
      // Avoid tiny tail smaller than minSegmentSec
      const remainingAfterChunk = segEnd - (segStart + maxSegmentSec);
      if (remainingAfterChunk > 0 && remainingAfterChunk < minSegmentSec) {
        const splitDur = Math.round(((segEnd - segStart) / 2) * 100) / 100;
        segments.push({ startSec: segStart, durationSec: splitDur });
        segStart = Math.round((segStart + splitDur) * 100) / 100;
        break;
      }
      segments.push({ startSec: segStart, durationSec: maxSegmentSec });
      segStart = Math.round((segStart + maxSegmentSec) * 100) / 100;
    }
    const finalDur = Math.round((segEnd - segStart) * 100) / 100;
    if (finalDur >= 0.5) {
      segments.push({ startSec: segStart, durationSec: finalDur });
    }
  }

  if (segments.length === 0) {
    segments.push({
      startSec: 0,
      durationSec: Math.min(maxSegmentSec, Math.max(1, totalDurationSec)),
    });
  }
  return segments;
}

export async function cutVideoSegment(
  videoPath: string,
  startSec: number,
  durationSec: number,
  outPath: string
): Promise<void> {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  await execFileAsync('ffmpeg', [
    '-y',
    '-ss',
    String(startSec),
    '-i',
    videoPath,
    '-t',
    String(durationSec),
    '-c:v',
    'libx264',
    '-preset',
    'fast',
    '-crf',
    '20',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-b:a',
    '160k',
    '-movflags',
    '+faststart',
    outPath,
  ]);
}

export async function extractAudioTrack(
  videoPath: string,
  outPath: string
): Promise<boolean> {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  try {
    await execFileAsync('ffmpeg', [
      '-y',
      '-i',
      videoPath,
      '-vn',
      '-acodec',
      'libmp3lame',
      '-b:a',
      '192k',
      outPath,
    ]);
    return fs.existsSync(outPath) && fs.statSync(outPath).size > 0;
  } catch {
    return false;
  }
}

export function computeTargetDimensions(
  resolution: OutputResolution,
  aspectRatio: OutputAspectRatio,
  sourceWidth: number,
  sourceHeight: number
): { width: number; height: number } {
  const baseH = resolution === '1080p' ? 1080 : 720;
  if (aspectRatio === '16:9') {
    return resolution === '1080p'
      ? { width: 1920, height: 1080 }
      : { width: 1280, height: 720 };
  }
  if (aspectRatio === '9:16') {
    return resolution === '1080p'
      ? { width: 1080, height: 1920 }
      : { width: 720, height: 1280 };
  }
  if (aspectRatio === '1:1') {
    return resolution === '1080p'
      ? { width: 1080, height: 1080 }
      : { width: 720, height: 720 };
  }
  // original aspect ratio scaled cleanly to even dimensions
  const ratio = sourceWidth > 0 && sourceHeight > 0 ? sourceWidth / sourceHeight : 16 / 9;
  if (ratio >= 1) {
    const w = Math.round((baseH * ratio) / 2) * 2;
    return { width: w, height: baseH };
  } else {
    const w = baseH;
    const h = Math.round((baseH / ratio) / 2) * 2;
    return { width: w, height: h };
  }
}

export async function assembleFinalVideo(params: {
  segmentPaths: string[];
  outputPath: string;
  audioOutputPath: string;
  resolution: OutputResolution;
  aspectRatio: OutputAspectRatio;
  sourceWidth: number;
  sourceHeight: number;
  fps: number;
  audioMode: AudioMode;
  originalAudioPath: string | null;
  generatedScorePath: string | null;
  cinematicGrade?: boolean;
}): Promise<void> {
  fs.mkdirSync(path.dirname(params.outputPath), { recursive: true });

  const { width, height } = computeTargetDimensions(
    params.resolution,
    params.aspectRatio,
    params.sourceWidth,
    params.sourceHeight
  );

  const workDir = path.dirname(params.outputPath);
  const normalizedPaths: string[] = [];

  // Normalize each segment to exact uniform resolution/fps/pixel format before concat
  for (let i = 0; i < params.segmentPaths.length; i++) {
    const segIn = params.segmentPaths[i];
    const segNorm = path.join(workDir, `norm_seg_${i}.mp4`);
    const scaleFilter = `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1`;
    const colorFilter = params.cinematicGrade
      ? ',eq=contrast=1.06:saturation=1.08:brightness=0.01'
      : '';
    await execFileAsync('ffmpeg', [
      '-y',
      '-i',
      segIn,
      '-vf',
      `${scaleFilter}${colorFilter}`,
      '-r',
      String(Math.min(60, Math.max(24, Math.round(params.fps || 24)))),
      '-c:v',
      'libx264',
      '-preset',
      'medium',
      '-crf',
      params.resolution === '1080p' ? '18' : '20',
      '-pix_fmt',
      'yuv420p',
      '-an',
      segNorm,
    ]);
    normalizedPaths.push(segNorm);
  }

  const concatListPath = path.join(workDir, 'concat_list.txt');
  const listContent = normalizedPaths
    .map((p) => `file '${p.replace(/'/g, "'\\''")}'`)
    .join('\n');
  fs.writeFileSync(concatListPath, listContent, 'utf8');

  const silentVideoPath = path.join(workDir, 'assembled_silent.mp4');
  await execFileAsync('ffmpeg', [
    '-y',
    '-f',
    'concat',
    '-safe',
    '0',
    '-i',
    concatListPath,
    '-c:v',
    'copy',
    silentVideoPath,
  ]);

  const probedSilent = await probeVideo(silentVideoPath);
  const targetDuration = probedSilent.durationSec;

  // Audio track selection & synchronization
  let finalAudioSource: string | null = null;
  const hasOriginalAudio =
    Boolean(params.originalAudioPath) &&
    fs.existsSync(params.originalAudioPath!) &&
    fs.statSync(params.originalAudioPath!).size > 0;
  const hasGeneratedScore =
    Boolean(params.generatedScorePath) &&
    fs.existsSync(params.generatedScorePath!) &&
    fs.statSync(params.generatedScorePath!).size > 0;

  if (params.audioMode === 'silent') {
    finalAudioSource = null;
  } else if (hasGeneratedScore && hasOriginalAudio && params.audioMode === 'preserve_dialogue') {
    // Mix original dialogue/audio (100%) with subtle generated score (35%)
    const mixedPath = path.join(workDir, 'mixed_audio.mp3');
    await execFileAsync('ffmpeg', [
      '-y',
      '-i',
      params.originalAudioPath!,
      '-stream_loop',
      '-1',
      '-i',
      params.generatedScorePath!,
      '-filter_complex',
      `[0:a]volume=1.0[a0];[1:a]volume=0.35[a1];[a0][a1]amix=inputs=2:duration=first:dropout_transition=2[out]`,
      '-map',
      '[out]',
      '-t',
      String(targetDuration),
      '-acodec',
      'libmp3lame',
      '-b:a',
      '192k',
      mixedPath,
    ]);
    finalAudioSource = mixedPath;
  } else if (hasGeneratedScore) {
    const trimmedScore = path.join(workDir, 'trimmed_score.mp3');
    await execFileAsync('ffmpeg', [
      '-y',
      '-stream_loop',
      '-1',
      '-i',
      params.generatedScorePath!,
      '-t',
      String(targetDuration),
      '-acodec',
      'libmp3lame',
      '-b:a',
      '192k',
      trimmedScore,
    ]);
    finalAudioSource = trimmedScore;
  } else if (hasOriginalAudio) {
    const trimmedOrig = path.join(workDir, 'trimmed_orig.mp3');
    await execFileAsync('ffmpeg', [
      '-y',
      '-i',
      params.originalAudioPath!,
      '-t',
      String(targetDuration),
      '-acodec',
      'libmp3lame',
      '-b:a',
      '192k',
      trimmedOrig,
    ]);
    finalAudioSource = trimmedOrig;
  }

  if (finalAudioSource && fs.existsSync(finalAudioSource)) {
    fs.copyFileSync(finalAudioSource, params.audioOutputPath);
    await execFileAsync('ffmpeg', [
      '-y',
      '-i',
      silentVideoPath,
      '-i',
      finalAudioSource,
      '-c:v',
      'copy',
      '-c:a',
      'aac',
      '-b:a',
      '192k',
      '-shortest',
      '-movflags',
      '+faststart',
      params.outputPath,
    ]);
  } else {
    // Generate clean silent AAC stream for universal MP4 player compatibility
    await execFileAsync('ffmpeg', [
      '-y',
      '-i',
      silentVideoPath,
      '-f',
      'lavfi',
      '-i',
      'anullsrc=channel_layout=stereo:sample_rate=44100',
      '-c:v',
      'copy',
      '-c:a',
      'aac',
      '-b:a',
      '128k',
      '-shortest',
      '-movflags',
      '+faststart',
      params.outputPath,
    ]);
    // Also export silent audio placeholder mp3 if user clicks Download Audio
    await execFileAsync('ffmpeg', [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'anullsrc=channel_layout=stereo:sample_rate=44100',
      '-t',
      String(Math.max(1, targetDuration)),
      '-acodec',
      'libmp3lame',
      '-b:a',
      '128k',
      params.audioOutputPath,
    ]);
  }
}

/**
 * Computes average perceptual similarity (SSIM 0..1) between two videos resized to
 * matching resolution so QC can detect if an output segment is virtually identical
 * to the original source segment (meaning the character was not replaced).
 */
export async function computeVideoSimilaritySsim(
  sourceVideoPath: string,
  generatedVideoPath: string
): Promise<number | null> {
  if (!fs.existsSync(sourceVideoPath) || !fs.existsSync(generatedVideoPath)) {
    return null;
  }
  try {
    const { stderr } = await execFileAsync(
      'ffmpeg',
      [
        '-i',
        sourceVideoPath,
        '-i',
        generatedVideoPath,
        '-lavfi',
        '[0:v]scale=320:180,setsar=1[v0];[1:v]scale=320:180,setsar=1[v1];[v0][v1]ssim',
        '-f',
        'null',
        '-',
      ],
      { timeout: 25000, maxBuffer: 1024 * 1024 * 8 }
    );
    const match = stderr.match(/All:([0-9]+(?:\.[0-9]+)?)/i);
    if (match) {
      const val = Number(match[1]);
      return Number.isFinite(val) ? val : null;
    }
    return null;
  } catch {
    return null;
  }
}

export async function computeImageSimilaritySsim(
  imgPathA: string,
  imgPathB: string
): Promise<number | null> {
  if (!fs.existsSync(imgPathA) || !fs.existsSync(imgPathB)) {
    return null;
  }
  try {
    const { stderr } = await execFileAsync(
      'ffmpeg',
      [
        '-i',
        imgPathA,
        '-i',
        imgPathB,
        '-lavfi',
        '[0:v]scale=256:144,setsar=1[v0];[1:v]scale=256:144,setsar=1[v1];[v0][v1]ssim',
        '-f',
        'null',
        '-',
      ],
      { timeout: 15000, maxBuffer: 1024 * 1024 * 4 }
    );
    const match = stderr.match(/All:([0-9]+(?:\.[0-9]+)?)/i);
    if (match) {
      const val = Number(match[1]);
      return Number.isFinite(val) ? Math.round(val * 1000) / 1000 : null;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Stage 2: Extract frames at a controlled sampling FPS while preserving exact timestamps
 * and avoiding duplicate frames at clip boundaries.
 */
export async function extractSampledFrames(params: {
  videoPath: string;
  durationSec: number;
  samplingFps: number;
  outDir: string;
  maxFrames?: number;
}): Promise<Array<{ index: number; timestampSec: number; framePath: string }>> {
  fs.mkdirSync(params.outDir, { recursive: true });
  const maxFrames = params.maxFrames ?? 36;
  const safeDur = Math.max(0.2, params.durationSec);
  const targetStep = 1 / Math.max(0.5, params.samplingFps);
  const desiredCount = Math.max(2, Math.round(safeDur / targetStep) + 1);
  const count = Math.min(maxFrames, desiredCount);

  const timestamps: number[] = [];
  for (let i = 0; i < count; i++) {
    const t =
      count === 1
        ? 0
        : Math.min(Math.max(0, safeDur - 0.08), (i / (count - 1)) * Math.max(0, safeDur - 0.08));
    const rounded = Math.round(t * 1000) / 1000;
    if (timestamps.length === 0 || rounded - timestamps[timestamps.length - 1] >= 0.03) {
      timestamps.push(rounded);
    }
  }

  const results: Array<{ index: number; timestampSec: number; framePath: string }> = [];
  for (let i = 0; i < timestamps.length; i++) {
    const outPath = path.join(
      params.outDir,
      `src_frame_${String(i).padStart(4, '0')}.png`
    );
    try {
      await execFileAsync(
        'ffmpeg',
        [
          '-y',
          '-ss',
          String(timestamps[i]),
          '-i',
          params.videoPath,
          '-frames:v',
          '1',
          outPath,
        ],
        { timeout: 20000 }
      );
      if (fs.existsSync(outPath) && fs.statSync(outPath).size > 0) {
        results.push({
          index: results.length,
          timestampSec: timestamps[i],
          framePath: outPath,
        });
      }
    } catch {
      // Skip frame seek failure cleanly
    }
  }

  if (results.length === 0) {
    const fallbackPath = path.join(params.outDir, 'src_frame_0000.png');
    await execFileAsync(
      'ffmpeg',
      ['-y', '-i', params.videoPath, '-frames:v', '1', fallbackPath],
      { timeout: 20000 }
    );
    if (fs.existsSync(fallbackPath) && fs.statSync(fallbackPath).size > 0) {
      results.push({ index: 0, timestampSec: 0, framePath: fallbackPath });
    }
  }

  return results;
}

// Pure-Node PNG writer for Stage 3 binary/feathered segmentation masks
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  const combined = Buffer.concat([typeBuf, data]);
  crcBuf.writeUInt32BE(crc32(combined), 0);
  return Buffer.concat([lenBuf, combined, crcBuf]);
}

/**
 * Generates a grayscale (L8) feathered PNG segmentation mask from normalized
 * tracking bounding boxes and optional face boxes for Stage 3/4 character editing.
 */
export async function generateFeatherMaskPng(params: {
  width: number;
  height: number;
  boxes: Array<{
    bbox: [number, number, number, number];
    faceBox?: [number, number, number, number];
  }>;
  scope: ReplacementScope;
  outPath: string;
}): Promise<void> {
  fs.mkdirSync(path.dirname(params.outPath), { recursive: true });
  const w = Math.max(64, Math.min(768, Math.round(params.width || 512)));
  const h = Math.max(64, Math.min(768, Math.round(params.height || 512)));
  const rowSize = w + 1; // +1 filter byte per scanline (filter type 0 = None)
  const raw = Buffer.alloc(rowSize * h, 0);

  const normalizedRegions = params.boxes.map((item) => {
    const chosen =
      params.scope === 'face_replacement' && item.faceBox
        ? item.faceBox
        : item.bbox;
    const x0 = Math.max(0, Math.min(1, chosen[0]));
    const y0 = Math.max(0, Math.min(1, chosen[1]));
    const bw = Math.max(0.05, Math.min(1 - x0, chosen[2]));
    const bh = Math.max(0.05, Math.min(1 - y0, chosen[3]));
    return {
      cx: (x0 + bw / 2) * w,
      cy: (y0 + bh / 2) * h,
      rx: Math.max(8, (bw * w) / 2),
      ry: Math.max(8, (bh * h) / 2),
      isFace: params.scope === 'face_replacement',
    };
  });

  for (let y = 0; y < h; y++) {
    const rowOff = y * rowSize;
    raw[rowOff] = 0; // PNG filter type 0
    for (let x = 0; x < w; x++) {
      let maxVal = 0;
      for (const r of normalizedRegions) {
        const dx = (x - r.cx) / r.rx;
        const dy = (y - r.cy) / r.ry;
        // Superellipse / soft rounded silhouette for body vs oval for face
        const exp = r.isFace ? 2.0 : 3.2;
        const dist = Math.pow(
          Math.pow(Math.abs(dx), exp) + Math.pow(Math.abs(dy), exp),
          1 / exp
        );
        if (dist <= 0.86) {
          maxVal = 255;
          break;
        } else if (dist < 1.14) {
          const alpha = Math.round(((1.14 - dist) / 0.28) * 255);
          if (alpha > maxVal) maxVal = alpha;
        }
      }
      raw[rowOff + 1 + x] = maxVal;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth 8
  ihdr[9] = 0; // color type 0 (grayscale)
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const idat = zlib.deflateSync(raw, { level: 6 });
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const png = Buffer.concat([
    signature,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
  fs.writeFileSync(params.outPath, png);
}

/**
 * Stage 6: Reassembles edited frames cleanly using exact original timestamps, target resolution,
 * motion-smoothed target FPS, and synced original/generated audio into a playable MP4.
 */
export async function assembleFramesToVideo(params: {
  frames: Array<{ path: string; timestampSec: number }>;
  totalDurationSec: number;
  targetFps: number;
  outputPath: string;
  audioOutputPath: string;
  resolution: OutputResolution;
  aspectRatio: OutputAspectRatio;
  sourceWidth: number;
  sourceHeight: number;
  audioMode: AudioMode;
  originalAudioPath: string | null;
  generatedScorePath: string | null;
  cinematicGrade?: boolean;
}): Promise<void> {
  if (params.frames.length === 0) {
    throw new Error('Cannot reconstruct video: no processed frames available.');
  }

  fs.mkdirSync(path.dirname(params.outputPath), { recursive: true });
  const workDir = path.dirname(params.outputPath);
  const { width, height } = computeTargetDimensions(
    params.resolution,
    params.aspectRatio,
    params.sourceWidth,
    params.sourceHeight
  );

  // Write FFmpeg concat demuxer script with exact frame-to-frame durations preserving original pacing
  const sorted = [...params.frames].sort((a, b) => a.timestampSec - b.timestampSec);
  const lines: string[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const cur = sorted[i];
    const nextTs =
      i + 1 < sorted.length
        ? sorted[i + 1].timestampSec
        : Math.max(cur.timestampSec + 0.08, params.totalDurationSec);
    const dur = Math.max(0.04, Math.round((nextTs - cur.timestampSec) * 1000) / 1000);
    lines.push(`file '${cur.path.replace(/'/g, "'\\''")}'`);
    lines.push(`duration ${dur}`);
  }
  // FFmpeg concat requires repeating last file path after final duration
  lines.push(`file '${sorted[sorted.length - 1].path.replace(/'/g, "'\\''")}'`);

  const listPath = path.join(workDir, 'frames_concat.txt');
  fs.writeFileSync(listPath, lines.join('\n'), 'utf8');

  const safeFps = Math.min(30, Math.max(12, Math.round(params.targetFps || 24)));
  const scaleFilter = `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1`;
  const gradeFilter = params.cinematicGrade
    ? ',eq=contrast=1.04:saturation=1.06'
    : '';
  const vfChain = `${scaleFilter},fps=${safeFps}${gradeFilter}`;

  const silentVideoPath = path.join(workDir, 'reconstructed_silent.mp4');
  await execFileAsync(
    'ffmpeg',
    [
      '-y',
      '-f',
      'concat',
      '-safe',
      '0',
      '-i',
      listPath,
      '-vf',
      vfChain,
      '-t',
      String(Math.max(0.2, params.totalDurationSec)),
      '-c:v',
      'libx264',
      '-preset',
      'medium',
      '-crf',
      params.resolution === '1080p' ? '18' : '20',
      '-pix_fmt',
      'yuv420p',
      '-an',
      silentVideoPath,
    ],
    { timeout: 60000 }
  );

  // Reuse final audio mux logic cleanly
  await assembleFinalVideo({
    segmentPaths: [silentVideoPath],
    outputPath: params.outputPath,
    audioOutputPath: params.audioOutputPath,
    resolution: params.resolution,
    aspectRatio: params.aspectRatio,
    sourceWidth: width,
    sourceHeight: height,
    fps: safeFps,
    audioMode: params.audioMode,
    originalAudioPath: params.originalAudioPath,
    generatedScorePath: params.generatedScorePath,
    cinematicGrade: false,
  });
}

