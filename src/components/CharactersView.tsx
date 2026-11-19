import React, { useRef, useState } from 'react';
import {
  CheckCircle2,
  Loader2,
  RefreshCw,
  Trash2,
  Upload,
  UserPlus,
} from 'lucide-react';
import { deleteCharacter, reanalyzeCharacter, uploadCharacter } from '../api';
import type { CharacterAsset } from '../types';

interface CharactersViewProps {
  characters: CharacterAsset[];
  onRefresh: () => void;
  onUseCharacter: (id: string) => void;
}

export const CharactersView: React.FC<CharactersViewProps> = ({
  characters,
  onRefresh,
  onUseCharacter,
}) => {
  const fileRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState('');
  const [notes, setNotes] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [uploading, setUploading] = useState(false);
  const [analyzingId, setAnalyzingId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleUpload = async (e: React.FormEvent) => {
    e.preventDefault();
    if (files.length === 0) {
      setError('Select at least one character photograph (JPG, JPEG, PNG, WEBP).');
      return;
    }
    setUploading(true);
    setError(null);
    setNotice(null);
    try {
      const res = await uploadCharacter({
        name: name.trim() || files[0].name.replace(/\.[^.]+$/, ''),
        notes: notes.trim(),
        files,
      });
      setName('');
      setNotes('');
      setFiles([]);
      if (res.analysisWarning) {
        setNotice(
          `Character saved, but automatic Gemini profile extraction returned a warning: ${res.analysisWarning}`
        );
      } else {
        setNotice('Character saved and facial identity profile extracted.');
      }
      onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setUploading(false);
    }
  };

  const handleReanalyze = async (id: string) => {
    setAnalyzingId(id);
    setError(null);
    try {
      await reanalyzeCharacter(id);
      onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setAnalyzingId(null);
    }
  };

  const handleDelete = async (id: string) => {
    await deleteCharacter(id);
    onRefresh();
  };

  return (
    <div className="space-y-6">
      <div className="border-b border-white/[0.08] pb-5">
        <h1 className="text-2xl font-semibold tracking-tight text-slate-100">
          Character Library
        </h1>
        <p className="text-sm text-slate-400 mt-1">
          Upload personal reference portraits once and reuse extracted facial identity profiles across projects.
        </p>
      </div>

      {/* Upload Form */}
      <form
        onSubmit={(e) => void handleUpload(e)}
        className="rounded-xl border border-white/[0.08] bg-[#11141B] p-5 space-y-4"
      >
        <div className="flex items-center gap-2 text-sm font-semibold text-slate-100">
          <UserPlus className="h-4 w-4 text-[#E5A93C]" />
          <span>Add New Character Reference</span>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div>
            <label className="block text-xs font-medium text-slate-400 mb-1.5">
              Character Name
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g., Aria — Lead Actor"
              className="w-full rounded-lg border border-white/[0.1] bg-[#0B0D11] px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-400 mb-1.5">
              Notes (Optional)
            </label>
            <input
              type="text"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="e.g., Front & side profile studio light"
              className="w-full rounded-lg border border-white/[0.1] bg-[#0B0D11] px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-400 mb-1.5">
              Reference Photo(s) (1–4 images)
            </label>
            <input
              ref={fileRef}
              type="file"
              multiple
              accept=".jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp"
              onChange={(e) => setFiles(Array.from(e.target.files ?? []).slice(0, 4))}
              className="hidden"
            />
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              className="w-full inline-flex items-center justify-center gap-2 rounded-lg border border-white/[0.12] bg-[#171B24] px-3 py-2 text-xs font-medium text-slate-200 hover:border-[#E5A93C]/50"
            >
              <Upload className="h-3.5 w-3.5 text-[#E5A93C]" />
              {files.length > 0
                ? `${files.length} file(s) selected`
                : 'Choose JPG / PNG / WEBP'}
            </button>
          </div>
        </div>

        {error && <p className="text-xs text-red-400">{error}</p>}
        {notice && <p className="text-xs text-emerald-400">{notice}</p>}

        <div className="flex justify-end">
          <button
            type="submit"
            disabled={uploading || files.length === 0}
            className="inline-flex items-center gap-2 rounded-lg bg-[#E5A93C] px-4 py-2 text-xs font-semibold text-[#0B0D11] hover:bg-[#F0B84D] disabled:opacity-45"
          >
            {uploading && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Upload &amp; Analyze Identity
          </button>
        </div>
      </form>

      {/* Saved Characters Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
        {characters.map((char) => (
          <article
            key={char.id}
            className="rounded-xl border border-white/[0.08] bg-[#11141B] p-5 space-y-4"
          >
            <div className="flex gap-4">
              <img
                src={char.primaryImageUrl}
                alt={char.name}
                referrerPolicy="no-referrer"
                className="h-24 w-24 rounded-lg object-cover border border-white/[0.08] shrink-0 bg-[#171B24]"
              />
              <div className="min-w-0 flex-1 space-y-1">
                <div className="flex items-center justify-between gap-2">
                  <h3 className="text-base font-semibold text-slate-100 truncate">
                    {char.name}
                  </h3>
                  <span className="text-[11px] font-mono-tabular text-slate-400 shrink-0">
                    {char.isPreset ? 'Sample Preset' : 'Uploaded'}
                  </span>
                </div>
                <p className="text-xs text-slate-400 font-mono-tabular">
                  ID: {char.id}
                </p>
                {char.notes && (
                  <p className="text-xs text-slate-300">{char.notes}</p>
                )}
              </div>
            </div>

            {char.profile ? (
              <div className="rounded-lg border border-white/[0.06] bg-[#0B0D11]/60 p-3.5 space-y-2 text-xs">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1.5">
                  <div>
                    <span className="text-slate-500">Face: </span>
                    <span className="text-slate-300">
                      {char.profile.facialStructure}
                    </span>
                  </div>
                  <div>
                    <span className="text-slate-500">Eyes: </span>
                    <span className="text-slate-300">{char.profile.eyeShape}</span>
                  </div>
                  <div>
                    <span className="text-slate-500">Hair: </span>
                    <span className="text-slate-300">{char.profile.hair}</span>
                  </div>
                  <div>
                    <span className="text-slate-500">Features: </span>
                    <span className="text-slate-300">
                      {char.profile.distinctiveFeatures}
                    </span>
                  </div>
                </div>
                <p className="text-slate-400 pt-1 border-t border-white/[0.06]">
                  {char.profile.identitySummaryPrompt}
                </p>
              </div>
            ) : (
              <p className="text-xs text-amber-300">
                Identity profile not extracted yet. Click Analyze Identity to run Gemini 4 Hydrogen inspection.
              </p>
            )}

            <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
              <button
                type="button"
                onClick={() => onUseCharacter(char.id)}
                className="inline-flex items-center gap-1.5 rounded-lg bg-[#E5A93C] px-3.5 py-2 text-xs font-semibold text-[#0B0D11] hover:bg-[#F0B84D]"
              >
                <CheckCircle2 className="h-3.5 w-3.5" />
                Use in New Video
              </button>

              <div className="flex items-center gap-2">
                {!char.isPreset && (
                  <button
                    type="button"
                    disabled={analyzingId === char.id}
                    onClick={() => void handleReanalyze(char.id)}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-white/[0.12] bg-[#171B24] px-3 py-1.5 text-xs text-slate-200 hover:border-white/[0.25]"
                  >
                    {analyzingId === char.id ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <RefreshCw className="h-3.5 w-3.5" />
                    )}
                    Re-analyze
                  </button>
                )}
                {!char.isPreset && (
                  <button
                    type="button"
                    onClick={() => void handleDelete(char.id)}
                    className="rounded-lg border border-white/[0.12] p-1.5 text-slate-400 hover:text-red-400 hover:border-red-500/40"
                    title="Delete character"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            </div>
          </article>
        ))}
      </div>
    </div>
  );
};
