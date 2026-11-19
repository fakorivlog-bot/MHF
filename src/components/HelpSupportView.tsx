import React from 'react';
import { HelpCircle, Shield, Sparkles, Video } from 'lucide-react';

export const HelpSupportView: React.FC = () => {
  return (
    <div className="space-y-6 max-w-4xl">
      <div className="border-b border-white/[0.08] pb-5">
        <h1 className="text-2xl font-semibold tracking-tight text-slate-100">
          Help &amp; Filmmaking Guide
        </h1>
        <p className="text-sm text-slate-400 mt-1">
          Practical guidance for achieving strong character identity consistency, scene segmentation, and reliable MP4 exports.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
        <section className="rounded-xl border border-white/[0.08] bg-[#11141B] p-5 space-y-2.5">
          <div className="flex items-center gap-2 text-sm font-semibold text-slate-100">
            <Video className="h-4 w-4 text-[#E5A93C]" />
            <span>1. Best Results for Character Identity</span>
          </div>
          <p className="text-xs text-slate-400 leading-relaxed">
            Upload a sharp, evenly lit front-facing portrait without sunglasses or heavy occlusion. Adding 1–2 optional side or three-quarter angles improves facial stability during turning and walking shots. Generative video models can still exhibit slight variations across rapid motion—any flagged segments can be retried individually.
          </p>
        </section>

        <section className="rounded-xl border border-white/[0.08] bg-[#11141B] p-5 space-y-2.5">
          <div className="flex items-center gap-2 text-sm font-semibold text-slate-100">
            <Sparkles className="h-4 w-4 text-[#E5A93C]" />
            <span>2. Automatic Scene Segmentation</span>
          </div>
          <p className="text-xs text-slate-400 leading-relaxed">
            Videos longer than 10 seconds (including 30s and 60s footage) are automatically split by FFmpeg scene-change detection into compliant 3s–10s segments, processed individually, checked for continuity, and assembled seamlessly into a single H.264 MP4.
          </p>
        </section>

        <section className="rounded-xl border border-white/[0.08] bg-[#11141B] p-5 space-y-2.5">
          <div className="flex items-center gap-2 text-sm font-semibold text-slate-100">
            <Shield className="h-4 w-4 text-emerald-400" />
            <span>3. Free Mode vs Paid AI Video Mode</span>
          </div>
          <p className="text-xs text-slate-400 leading-relaxed">
            Free Mode is active by default so you are never charged unexpectedly. It executes real FFmpeg scene cutting, Gemini 4 Hydrogen character detection, identity profiling, multilingual directing, and HD/Full HD mastering. Paid Mode activates `gemini-omni-1.2-flash` only after you check and confirm the cost dialog.
          </p>
        </section>

        <section className="rounded-xl border border-white/[0.08] bg-[#11141B] p-5 space-y-2.5">
          <div className="flex items-center gap-2 text-sm font-semibold text-slate-100">
            <HelpCircle className="h-4 w-4 text-[#E5A93C]" />
            <span>4. Privacy &amp; Storage</span>
          </div>
          <p className="text-xs text-slate-400 leading-relaxed">
            Uploaded videos, portraits, and exported MP4 files are stored per project on the server filesystem and are never reused across unrelated projects. You can delete any project, character photo, or environment reference at any time.
          </p>
        </section>
      </div>
    </div>
  );
};
