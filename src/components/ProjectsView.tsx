import React, { useState } from 'react';
import {
  Download,
  Edit3,
  Film,
  FolderOpen,
  Music,
  Play,
  RefreshCw,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import {
  deleteProject,
  retryProjectSegment,
  updateProject,
  verifyVideoDownloadAvailable,
} from '../api';
import type { ProjectRecord } from '../types';

interface ProjectsViewProps {
  projects: ProjectRecord[];
  onRefresh: () => void;
  onOpenProject: (project: ProjectRecord) => void;
  onCreateNew: () => void;
}

export const ProjectsView: React.FC<ProjectsViewProps> = ({
  projects,
  onRefresh,
  onOpenProject,
  onCreateNew,
}) => {
  const [query, setQuery] = useState('');
  const [filterStatus, setFilterStatus] = useState<string>('all');
  const [previewProject, setPreviewProject] = useState<ProjectRecord | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [downloadError, setDownloadError] = useState<string | null>(null);

  const filtered = projects.filter((p) => {
    const matchesSearch =
      p.name.toLowerCase().includes(query.toLowerCase()) ||
      p.instruction.toLowerCase().includes(query.toLowerCase());
    const matchesStatus = filterStatus === 'all' || p.status === filterStatus;
    return matchesSearch && matchesStatus;
  });

  const handleRenameSubmit = async (id: string) => {
    if (!renameValue.trim()) {
      setRenamingId(null);
      return;
    }
    await updateProject(id, { name: renameValue.trim() });
    setRenamingId(null);
    onRefresh();
  };

  const handleDelete = async (id: string) => {
    await deleteProject(id);
    if (previewProject?.id === id) setPreviewProject(null);
    onRefresh();
  };

  const handleRetryFailed = async (project: ProjectRecord) => {
    const failedSeg = project.segments.find((s) => s.status === 'failed');
    if (!failedSeg) return;
    await retryProjectSegment(project.id, failedSeg.index);
    onRefresh();
    onOpenProject(project);
  };

  const handleVerifiedDownload = async (proj: ProjectRecord) => {
    setDownloadError(null);
    const check = await verifyVideoDownloadAvailable(proj.id);
    if (!check.ok) {
      setDownloadError(check.error || 'MP4 file could not be verified on server.');
      return;
    }
    const a = document.createElement('a');
    a.href = `/api/projects/${proj.id}/download/video`;
    const safeName = proj.name.replace(/[^a-zA-Z0-9_-]+/g, '_');
    a.download = `${safeName}_${proj.resolution}.mp4`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 border-b border-white/[0.08] pb-5">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-slate-100">
            My Projects
          </h1>
          <p className="text-sm text-slate-400 mt-1">
            Manage generated MP4 films, retry failed segments, preview outputs, and download audio stems.
          </p>
        </div>

        <button
          type="button"
          onClick={onCreateNew}
          className="rounded-lg bg-[#E5A93C] px-4 py-2 text-xs font-semibold text-[#0B0D11] hover:bg-[#F0B84D] transition-colors whitespace-nowrap shrink-0"
        >
          Create New Video
        </button>
      </div>

      {/* Search & Segmented Filter */}
      <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3">
        <div className="relative flex-1 max-w-sm">
          <Search className="h-4 w-4 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search projects..."
            className="w-full rounded-lg border border-white/[0.1] bg-[#11141B] pl-9 pr-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:border-[#E5A93C] focus:outline-none"
          />
        </div>

        <div className="flex items-center gap-1 rounded-lg bg-[#11141B] p-1 border border-white/[0.08] overflow-x-auto">
          {[
            { id: 'all', label: 'All' },
            { id: 'completed', label: 'Completed' },
            { id: 'processing', label: 'Processing' },
            { id: 'partial_failure', label: 'Needs Retry' },
          ].map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setFilterStatus(tab.id)}
              className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                filterStatus === tab.id
                  ? 'bg-[#1E2430] text-slate-100'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {downloadError && (
        <div
          role="alert"
          className="flex items-center justify-between gap-3 rounded-lg border border-red-500/30 bg-red-950/30 px-4 py-2.5 text-xs text-red-200"
        >
          <span>{downloadError}</span>
          <button
            type="button"
            onClick={() => setDownloadError(null)}
            className="text-red-300 hover:text-white"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {filtered.length === 0 ? (
        <div className="rounded-xl border border-white/[0.08] bg-[#11141B] p-12 text-center space-y-3">
          <Film className="h-10 w-10 text-slate-500 mx-auto" />
          <h3 className="text-base font-medium text-slate-200">
            No projects match your view
          </h3>
          <p className="text-sm text-slate-400 max-w-md mx-auto">
            Upload a source video and character photograph in Create New Video to produce your first cinematic export.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
          {filtered.map((proj) => {
            const hasFailedSeg = proj.segments.some(
              (s) => s.status === 'failed'
            );
            return (
              <article
                key={proj.id}
                className="rounded-xl border border-white/[0.08] bg-[#11141B] p-4 flex flex-col gap-4"
              >
                <div className="flex gap-4">
                  <div className="w-36 h-24 rounded-lg overflow-hidden bg-[#0B0D11] border border-white/[0.06] shrink-0">
                    {proj.sourceVideo.thumbnailUrl ? (
                      <img
                        src={proj.sourceVideo.thumbnailUrl}
                        alt={proj.name}
                        referrerPolicy="no-referrer"
                        className="h-full w-full object-cover"
                      />
                    ) : (
                      <div className="h-full w-full flex items-center justify-center">
                        <Film className="h-6 w-6 text-slate-600" />
                      </div>
                    )}
                  </div>

                  <div className="min-w-0 flex-1 space-y-1.5">
                    {renamingId === proj.id ? (
                      <div className="flex items-center gap-2">
                        <input
                          type="text"
                          value={renameValue}
                          onChange={(e) => setRenameValue(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') void handleRenameSubmit(proj.id);
                            if (e.key === 'Escape') setRenamingId(null);
                          }}
                          autoFocus
                          className="flex-1 rounded border border-[#E5A93C] bg-[#0B0D11] px-2 py-1 text-sm text-slate-100"
                        />
                        <button
                          type="button"
                          onClick={() => void handleRenameSubmit(proj.id)}
                          className="text-xs font-medium text-[#E5A93C]"
                        >
                          Save
                        </button>
                      </div>
                    ) : (
                      <h3 className="text-base font-semibold text-slate-100 truncate">
                        {proj.name}
                      </h3>
                    )}

                    <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400 font-mono-tabular">
                      <span>{new Date(proj.createdAt).toLocaleDateString()}</span>
                      <span aria-hidden="true">·</span>
                      <span>{proj.resolution}</span>
                      <span aria-hidden="true">·</span>
                      <span>{proj.sourceVideo.durationSec}s</span>
                      <span aria-hidden="true">·</span>
                      <span
                        className={
                          proj.status === 'completed'
                            ? 'text-emerald-400'
                            : proj.status === 'failed' ||
                                proj.status === 'partial_failure'
                              ? 'text-red-400'
                              : 'text-[#E5A93C]'
                        }
                      >
                        {proj.status.replace('_', ' ')}
                      </span>
                    </div>

                    <p className="text-xs text-slate-400 line-clamp-2" dir="auto">
                      {proj.instruction}
                    </p>
                    {proj.qcSummary && !proj.qcSummary.passed && (
                      <p className="text-[11px] text-red-400">
                        QC Failed: Original identity remained or target transfer failed
                        {typeof proj.qcSummary.minIdentityScore === 'number'
                          ? ` (${proj.qcSummary.minIdentityScore}/100)`
                          : ''}
                      </p>
                    )}
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2 border-t border-white/[0.06] pt-3">
                  <button
                    type="button"
                    onClick={() => onOpenProject(proj)}
                    className="inline-flex items-center gap-1.5 rounded-md border border-white/[0.12] bg-[#171B24] px-3 py-1.5 text-xs font-medium text-slate-200 hover:border-white/[0.25]"
                  >
                    <FolderOpen className="h-3.5 w-3.5" />
                    Open Project
                  </button>

                  {proj.outputVideoUrl && (
                    <button
                      type="button"
                      onClick={() => setPreviewProject(proj)}
                      className="inline-flex items-center gap-1.5 rounded-md border border-white/[0.12] bg-[#171B24] px-3 py-1.5 text-xs font-medium text-slate-200 hover:border-[#E5A93C]/50"
                    >
                      <Play className="h-3.5 w-3.5 text-[#E5A93C]" />
                      Preview Video
                    </button>
                  )}

                  {proj.outputVideoUrl && (
                    <button
                      type="button"
                      onClick={() => void handleVerifiedDownload(proj)}
                      className="inline-flex items-center gap-1.5 rounded-md bg-emerald-600/90 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-500"
                    >
                      <Download className="h-3.5 w-3.5" />
                      Download MP4
                    </button>
                  )}

                  {proj.outputAudioUrl && (
                    <a
                      href={`/api/projects/${proj.id}/download/audio`}
                      download
                      className="inline-flex items-center gap-1.5 rounded-md border border-white/[0.12] bg-[#171B24] px-3 py-1.5 text-xs font-medium text-slate-200 hover:border-white/[0.25]"
                    >
                      <Music className="h-3.5 w-3.5" />
                      Download Audio
                    </a>
                  )}

                  {hasFailedSeg && (
                    <button
                      type="button"
                      onClick={() => void handleRetryFailed(proj)}
                      className="inline-flex items-center gap-1.5 rounded-md border border-amber-500/40 bg-amber-950/30 px-3 py-1.5 text-xs font-medium text-amber-300 hover:bg-amber-900/40"
                    >
                      <RefreshCw className="h-3.5 w-3.5" />
                      Retry Failed Segment
                    </button>
                  )}

                  <div className="ml-auto flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => {
                        setRenamingId(proj.id);
                        setRenameValue(proj.name);
                      }}
                      title="Rename Project"
                      className="rounded-md p-1.5 text-slate-400 hover:text-slate-100 hover:bg-white/[0.06]"
                    >
                      <Edit3 className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleDelete(proj.id)}
                      title="Delete Project"
                      className="rounded-md p-1.5 text-slate-400 hover:text-red-400 hover:bg-red-950/30"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      )}

      {/* Video Preview Modal */}
      {previewProject && previewProject.outputVideoUrl && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
        >
          <div className="w-full max-w-3xl rounded-xl border border-white/[0.12] bg-[#11141B] overflow-hidden">
            <div className="flex items-center justify-between px-5 py-3.5 border-b border-white/[0.08]">
              <h3 className="text-sm font-semibold text-slate-100">
                {previewProject.name} · {previewProject.resolution}
              </h3>
              <button
                type="button"
                onClick={() => setPreviewProject(null)}
                className="text-slate-400 hover:text-white"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="bg-black">
              <video
                src={previewProject.outputVideoUrl}
                controls
                autoPlay
                className="w-full max-h-[70vh]"
              />
            </div>
            <div className="flex items-center justify-between px-5 py-3 border-t border-white/[0.08]">
              <span className="text-xs text-slate-400 font-mono-tabular">
                {previewProject.outputVideoMetadata
                  ? `${previewProject.outputVideoMetadata.width}×${previewProject.outputVideoMetadata.height} · ${previewProject.outputVideoMetadata.durationSec}s`
                  : ''}
              </span>
              <button
                type="button"
                onClick={() => void handleVerifiedDownload(previewProject)}
                className="inline-flex items-center gap-2 rounded-lg bg-[#E5A93C] px-4 py-2 text-xs font-semibold text-[#0B0D11]"
              >
                <Download className="h-3.5 w-3.5" />
                Download MP4
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
