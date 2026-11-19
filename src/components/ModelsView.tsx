import React from 'react';
import { Cpu, ShieldCheck, Zap } from 'lucide-react';
import type { ModelCatalogItem } from '../types';

interface ModelsViewProps {
  models: ModelCatalogItem[];
}

export const ModelsView: React.FC<ModelsViewProps> = ({ models }) => {
  return (
    <div className="space-y-6">
      <div className="border-b border-white/[0.08] pb-5">
        <h1 className="text-2xl font-semibold tracking-tight text-slate-100">
          AI Models &amp; Orchestration
        </h1>
        <p className="text-sm text-slate-400 mt-1">
          Officially supported Google Gemini API models routed through server-side adapters. Paid models never run without explicit user confirmation.
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        {models.map((m) => (
          <article
            key={m.id}
            className="rounded-xl border border-white/[0.08] bg-[#11141B] p-5 space-y-3"
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-xs text-slate-400 font-mono-tabular">
                  {m.provider} · {m.id}
                </div>
                <h2 className="text-base font-semibold text-slate-100 mt-0.5">
                  {m.name}
                </h2>
              </div>
              <span
                className={`inline-flex items-center gap-1.5 text-xs font-medium whitespace-nowrap shrink-0 ${
                  m.billingTier === 'free_eligible'
                    ? 'text-emerald-400'
                    : 'text-[#E5A93C]'
                }`}
              >
                {m.billingTier === 'free_eligible' ? (
                  <ShieldCheck className="h-3.5 w-3.5" />
                ) : (
                  <Zap className="h-3.5 w-3.5" />
                )}
                {m.billingTier === 'free_eligible'
                  ? 'Free-Tier Eligible'
                  : 'Paid Key Required'}
              </span>
            </div>

            <div className="text-xs font-medium text-slate-300 flex items-center gap-1.5">
              <Cpu className="h-3.5 w-3.5 text-slate-400" />
              <span>{m.category}</span>
            </div>

            <ul className="space-y-1 text-xs text-slate-400 list-disc pl-4">
              {m.capabilities.map((cap) => (
                <li key={cap}>{cap}</li>
              ))}
            </ul>

            <div className="border-t border-white/[0.06] pt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-400 font-mono-tabular">
              <span>{m.limits}</span>
              <div className="flex items-center gap-3">
                {m.hardwareRequirement && (
                  <span className="text-slate-300">{m.hardwareRequirement}</span>
                )}
                {m.estimatedCostPerFrameUsd !== undefined && (
                  <span className={m.estimatedCostPerFrameUsd === 0 ? 'text-emerald-400' : 'text-[#E5A93C]'}>
                    {m.estimatedCostPerFrameUsd === 0
                      ? '$0/frame'
                      : `~$${m.estimatedCostPerFrameUsd.toFixed(2)}/frame`}
                  </span>
                )}
                {m.estimatedCostPerSecUsd !== undefined && m.estimatedCostPerFrameUsd === undefined && (
                  <span className="text-[#E5A93C]">
                    ~${m.estimatedCostPerSecUsd.toFixed(2)}/sec
                  </span>
                )}
              </div>
            </div>
          </article>
        ))}
      </div>
    </div>
  );
};
