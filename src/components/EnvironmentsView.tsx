import React, { useRef, useState } from 'react';
import { CheckCircle2, ImagePlus, Loader2, Trash2, Upload } from 'lucide-react';
import { deleteEnvironment, uploadEnvironment } from '../api';
import type { EnvironmentAsset } from '../types';

interface EnvironmentsViewProps {
  environments: EnvironmentAsset[];
  onRefresh: () => void;
  onUseEnvironment: (id: string) => void;
}

export const EnvironmentsView: React.FC<EnvironmentsViewProps> = ({
  environments,
  onRefresh,
  onUseEnvironment,
}) => {
  const fileRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState('');
  const [category, setCategory] = useState('Nature / Exterior');
  const [description, setDescription] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleUpload = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!file) {
      setError('Please select an environment reference image.');
      return;
    }
    setUploading(true);
    setError(null);
    try {
      await uploadEnvironment({
        name: name.trim() || file.name.replace(/\.[^.]+$/, ''),
        category: category.trim(),
        description:
          description.trim() ||
          'Custom visual backdrop reference for environment transformation.',
        file,
      });
      setName('');
      setDescription('');
      setFile(null);
      onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="border-b border-white/[0.08] pb-5">
        <h1 className="text-2xl font-semibold tracking-tight text-slate-100">
          Environment References
        </h1>
        <p className="text-sm text-slate-400 mt-1">
          Upload location, weather, or architectural backdrops to guide visual atmosphere across scenes.
        </p>
      </div>

      <form
        onSubmit={(e) => void handleUpload(e)}
        className="rounded-xl border border-white/[0.08] bg-[#11141B] p-5 space-y-4"
      >
        <div className="flex items-center gap-2 text-sm font-semibold text-slate-100">
          <ImagePlus className="h-4 w-4 text-[#E5A93C]" />
          <span>Upload Environment Backdrop</span>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div>
            <label className="block text-xs font-medium text-slate-400 mb-1.5">
              Location Name
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g., Misty Pine Forest at Dawn"
              className="w-full rounded-lg border border-white/[0.1] bg-[#0B0D11] px-3 py-2 text-sm text-slate-100"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-400 mb-1.5">
              Category
            </label>
            <input
              type="text"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              className="w-full rounded-lg border border-white/[0.1] bg-[#0B0D11] px-3 py-2 text-sm text-slate-100"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-400 mb-1.5">
              Reference Image
            </label>
            <input
              ref={fileRef}
              type="file"
              accept=".jpg,.jpeg,.png,.webp"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              className="hidden"
            />
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              className="w-full inline-flex items-center justify-center gap-2 rounded-lg border border-white/[0.12] bg-[#171B24] px-3 py-2 text-xs font-medium text-slate-200 hover:border-[#E5A93C]/50"
            >
              <Upload className="h-3.5 w-3.5 text-[#E5A93C]" />
              {file ? file.name : 'Choose Image'}
            </button>
          </div>
        </div>

        <div>
          <label className="block text-xs font-medium text-slate-400 mb-1.5">
            Visual Atmosphere Notes
          </label>
          <input
            type="text"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Describe lighting, weather, and architectural style..."
            className="w-full rounded-lg border border-white/[0.1] bg-[#0B0D11] px-3 py-2 text-sm text-slate-100"
          />
        </div>

        {error && <p className="text-xs text-red-400">{error}</p>}

        <div className="flex justify-end">
          <button
            type="submit"
            disabled={uploading || !file}
            className="inline-flex items-center gap-2 rounded-lg bg-[#E5A93C] px-4 py-2 text-xs font-semibold text-[#0B0D11] hover:bg-[#F0B84D] disabled:opacity-45"
          >
            {uploading && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Save Environment Reference
          </button>
        </div>
      </form>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
        {environments.map((env) => (
          <article
            key={env.id}
            className="rounded-xl border border-white/[0.08] bg-[#11141B] overflow-hidden flex flex-col"
          >
            <div className="aspect-video w-full bg-[#0B0D11]">
              <img
                src={env.imageUrl}
                alt={env.name}
                referrerPolicy="no-referrer"
                className="h-full w-full object-cover"
              />
            </div>
            <div className="p-4 flex-1 flex flex-col gap-3">
              <div>
                <div className="text-xs text-slate-400 font-mono-tabular">
                  {env.category} · {env.isPreset ? 'Sample Preset' : 'Uploaded'}
                </div>
                <h3 className="text-sm font-semibold text-slate-100 mt-1">
                  {env.name}
                </h3>
                <p className="text-xs text-slate-400 mt-1 line-clamp-2">
                  {env.description}
                </p>
              </div>

              <div className="mt-auto flex items-center justify-between pt-2 border-t border-white/[0.06]">
                <button
                  type="button"
                  onClick={() => onUseEnvironment(env.id)}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-[#E5A93C] px-3 py-1.5 text-xs font-semibold text-[#0B0D11] hover:bg-[#F0B84D]"
                >
                  <CheckCircle2 className="h-3.5 w-3.5" />
                  Use in New Video
                </button>
                {!env.isPreset && (
                  <button
                    type="button"
                    onClick={() => {
                      void deleteEnvironment(env.id).then(onRefresh);
                    }}
                    className="rounded-md p-1.5 text-slate-400 hover:text-red-400"
                    title="Delete environment"
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
