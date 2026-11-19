import React, { useState } from 'react';
import {
  AlertTriangle,
  BarChart3,
  Clock,
  Download,
  FolderOpen,
  Layers,
  RefreshCw,
  ShieldCheck,
  XCircle,
} from 'lucide-react';
import { cancelQueuedJob, retryProjectSegment } from '../api';
import type {
  ProjectRecord,
  QueueOverview,
  QuotaDashboardResponse,
} from '../types';

interface UsageCostViewProps {
  quotaData: QuotaDashboardResponse | null;
  queue: QueueOverview | null;
  onRefresh: () => void;
  onOpenProject: (proj: ProjectRecord) => void;
}

export const UsageCostView: React.FC<UsageCostViewProps> = ({
  quotaData,
  queue,
  onRefresh,
  onOpenProject,
}) => {
  const [queueTab, setQueueTab] = useState<
    'active' | 'pending' | 'completed' | 'failed'
  >('active');

  const totals = quotaData?.totals ?? {
    totalConfirmedFreeCredits: null,
    hasConfirmedFreeVideoQuota: false,
    manualEstimatedDailyCredits: null,
    manualEstimatedMonthlyCredits: null,
    manualEstimatedSecondsRemaining: null,
    secondsGeneratedToday: 0,
    minutesGeneratedToday: 0,
    minutesGeneratedThisMonth: 0,
    totalSegments: 0,
    totalSeconds: 0,
    totalEstimatedCostUsd: 0,
    freeRuns: 0,
    paidRuns: 0,
    failedAttempts: 0,
  };

  const providers = quotaData?.providers ?? [];
  const entries = quotaData?.entries ?? [];
  const consumedByProvider = quotaData?.consumedByProvider ?? {};
  const modelQuotas = quotaData?.modelQuotas ?? [];
  const projectQuotas = quotaData?.projectQuotas ?? [];
  const cacheStats = quotaData?.cacheStats ?? { cachedEntries: 0, cacheHitsToday: 0 };

  const activeJobs = queue?.[queueTab] ?? [];

  const handleCancel = async (id: string) => {
    await cancelQueuedJob(id);
    onRefresh();
  };

  const handleRetry = async (proj: ProjectRecord) => {
    const failed = proj.segments.find((s) => s.status === 'failed');
    if (failed) {
      await retryProjectSegment(proj.id, failed.index);
    }
    onRefresh();
    onOpenProject(proj);
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 border-b border-white/[0.08] pb-5">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-slate-100">
            Daily &amp; Monthly Video Credit Dashboard
          </h1>
          <p className="text-sm text-slate-400 mt-1">
            Confirmed provider quotas are shown separately from manual user estimates. Track generated seconds, failed attempts, and manage the job queue.
          </p>
        </div>

        <button
          type="button"
          onClick={onRefresh}
          className="inline-flex items-center gap-1.5 rounded-lg border border-white/[0.12] bg-[#11141B] px-3.5 py-2 text-xs font-medium text-slate-200 hover:border-white/[0.25] whitespace-nowrap shrink-0"
        >
          <RefreshCw className="h-3.5 w-3.5 text-[#E5A93C]" />
          Refresh Quotas
        </button>
      </div>

      {/* Confirmed vs Estimated Top Capacity KPI Strip */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="rounded-xl border border-white/[0.08] bg-[#11141B] p-4 space-y-1">
          <div className="flex items-center justify-between text-xs text-slate-400">
            <span>Confirmed Free Video Credits</span>
            <ShieldCheck className="h-4 w-4 text-emerald-400" />
          </div>
          <div className="text-2xl font-semibold text-slate-100 font-mono-tabular">
            {totals.hasConfirmedFreeVideoQuota
              ? totals.totalConfirmedFreeCredits
              : 'Unavailable'}
          </div>
          <p className="text-[11px] text-slate-500">
            {totals.hasConfirmedFreeVideoQuota
              ? 'Live from provider APIs'
              : 'Providers do not expose live free video counts'}
          </p>
        </div>

        <div className="rounded-xl border border-white/[0.08] bg-[#11141B] p-4 space-y-1">
          <div className="flex items-center justify-between text-xs text-slate-400">
            <span>Manual Estimated Capacity</span>
            <Layers className="h-4 w-4 text-[#E5A93C]" />
          </div>
          <div className="text-2xl font-semibold text-slate-100 font-mono-tabular">
            {totals.manualEstimatedMonthlyCredits !== null
              ? `${totals.manualEstimatedMonthlyCredits} cr`
              : 'Not set'}
          </div>
          <p className="text-[11px] text-slate-500 font-mono-tabular">
            Daily: {totals.manualEstimatedDailyCredits ?? '—'} · Est. Secs:{' '}
            {totals.manualEstimatedSecondsRemaining ?? '—'}
          </p>
        </div>

        <div className="rounded-xl border border-white/[0.08] bg-[#11141B] p-4 space-y-1">
          <div className="flex items-center justify-between text-xs text-slate-400">
            <span>Generated Today / Month</span>
            <Clock className="h-4 w-4 text-[#E5A93C]" />
          </div>
          <div className="text-2xl font-semibold text-slate-100 font-mono-tabular">
            {totals.secondsGeneratedToday}s / {totals.minutesGeneratedThisMonth}m
          </div>
          <p className="text-[11px] text-slate-500 font-mono-tabular">
            {totals.minutesGeneratedToday} min today · {totals.totalSegments}{' '}
            segments total
          </p>
        </div>

        <div className="rounded-xl border border-white/[0.08] bg-[#11141B] p-4 space-y-1">
          <div className="flex items-center justify-between text-xs text-slate-400">
            <span>Runs, Errors &amp; Cache Hits</span>
            <BarChart3 className="h-4 w-4 text-slate-400" />
          </div>
          <div className="text-2xl font-semibold text-slate-100 font-mono-tabular">
            {totals.freeRuns}F · {totals.paidRuns}P · {totals.failedAttempts} Err
          </div>
          <p className="text-[11px] text-slate-500 font-mono-tabular">
            Est. paid spend: ${totals.totalEstimatedCostUsd.toFixed(2)} · Cache hits today: {cacheStats.cacheHitsToday} ({cacheStats.cachedEntries} saved)
          </p>
        </div>
      </div>

      {/* Per-Provider & Per-Model Quota Tracker */}
      <section className="rounded-xl border border-white/[0.08] bg-[#11141B] overflow-hidden">
        <div className="px-5 py-3.5 border-b border-white/[0.08] flex flex-col sm:flex-row sm:items-center justify-between gap-2">
          <div>
            <h2 className="text-sm font-semibold text-slate-100">
              Per-Provider &amp; Per-Model API Quota Tracker
            </h2>
            <p className="text-[11px] text-slate-400 mt-0.5">
              Tracks daily requests per model and circuit-breaker cooldowns. Confirmed limits appear only when officially exposed by API headers or HTTP 429 quota metadata.
            </p>
          </div>
          <span className="text-[11px] font-mono-tabular text-slate-400">
            Analysis cache: {cacheStats.cacheHitsToday} hit(s) today · {cacheStats.cachedEntries} stored
          </span>
        </div>

        {modelQuotas.length === 0 ? (
          <div className="p-6 text-center text-xs text-slate-400">
            No model API calls recorded yet today.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-white/[0.08] text-slate-400 bg-[#0B0D11]/50">
                <tr>
                  <th className="px-4 py-2.5 font-medium">Provider / Model</th>
                  <th className="px-4 py-2.5 font-medium">Task &amp; Tier</th>
                  <th className="px-4 py-2.5 font-medium text-right">Confirmed Limit</th>
                  <th className="px-4 py-2.5 font-medium text-right">Used Today</th>
                  <th className="px-4 py-2.5 font-medium text-right">Remaining</th>
                  <th className="px-4 py-2.5 font-medium">Status</th>
                  <th className="px-4 py-2.5 font-medium">Quota ID / Reset</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/[0.06]">
                {modelQuotas.map((mq) => (
                  <tr
                    key={`${mq.providerId}::${mq.modelId}`}
                    className="hover:bg-white/[0.02]"
                  >
                    <td className="px-4 py-2.5">
                      <div className="font-medium text-slate-200">{mq.providerName}</div>
                      <div className="text-[11px] font-mono text-slate-400">{mq.modelId}</div>
                    </td>
                    <td className="px-4 py-2.5 font-mono-tabular text-slate-300">
                      <div>{mq.taskType.replace('_', ' ')}</div>
                      <div className="text-[11px] text-slate-500">
                        {mq.freeTierEligible ? 'Free-tier eligible' : 'Paid credits'}
                      </div>
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono-tabular text-slate-200">
                      {mq.confirmedDailyLimit !== null
                        ? `${mq.confirmedDailyLimit}/day`
                        : 'Unavailable'}
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono-tabular text-slate-200">
                      {mq.usedRequestsToday}
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono-tabular text-slate-200">
                      {mq.remainingRequestsToday !== null
                        ? mq.remainingRequestsToday
                        : 'Unavailable'}
                    </td>
                    <td className="px-4 py-2.5 font-mono-tabular">
                      <span
                        className={
                          mq.rateLimitStatus === 'available'
                            ? 'text-emerald-400'
                            : mq.rateLimitStatus === 'daily_exhausted' ||
                                mq.rateLimitStatus === 'auth_failed'
                              ? 'text-red-400'
                              : 'text-amber-300'
                        }
                      >
                        {mq.rateLimitStatus}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 font-mono-tabular text-[11px] text-slate-400">
                      {mq.quotaIdentifier && (
                        <div className="text-slate-300 truncate max-w-[220px]">
                          {mq.quotaIdentifier}
                        </div>
                      )}
                      <div>
                        {mq.resetAt
                          ? `Resets: ${new Date(mq.resetAt).toLocaleString()}`
                          : mq.retryAfterAt
                            ? `Retry after: ${new Date(mq.retryAfterAt).toLocaleTimeString()}`
                            : '—'}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Per-Project API Request Breakdown */}
      {projectQuotas.length > 0 && (
        <section className="rounded-xl border border-white/[0.08] bg-[#11141B] overflow-hidden">
          <div className="px-5 py-3.5 border-b border-white/[0.08]">
            <h2 className="text-sm font-semibold text-slate-100">
              Per-Project API Usage Today
            </h2>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-white/[0.08] text-slate-400 bg-[#0B0D11]/50">
                <tr>
                  <th className="px-4 py-2.5 font-medium">Project</th>
                  <th className="px-4 py-2.5 font-medium">Provider / Model</th>
                  <th className="px-4 py-2.5 font-medium text-right">Requests</th>
                  <th className="px-4 py-2.5 font-medium text-right">Succeeded</th>
                  <th className="px-4 py-2.5 font-medium text-right">HTTP 429</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/[0.06]">
                {projectQuotas.flatMap((pq) =>
                  Object.values(pq.byProviderModel).map((sub) => (
                    <tr
                      key={`${pq.projectId}::${sub.providerId}::${sub.modelId}`}
                      className="hover:bg-white/[0.02]"
                    >
                      <td className="px-4 py-2.5 font-medium text-slate-200">
                        {pq.projectName}
                      </td>
                      <td className="px-4 py-2.5 font-mono text-slate-400">
                        {sub.providerId} · {sub.modelId}
                      </td>
                      <td className="px-4 py-2.5 text-right font-mono-tabular text-slate-200">
                        {sub.requestsMade}
                      </td>
                      <td className="px-4 py-2.5 text-right font-mono-tabular text-emerald-400">
                        {sub.succeeded}
                      </td>
                      <td className="px-4 py-2.5 text-right font-mono-tabular text-red-400">
                        {sub.failed429}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* Per-Provider Quota & Consumption Cards */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-slate-200">
          Provider Capacity Breakdown
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {providers.map((p) => {
            const consumed = consumedByProvider[p.displayName] ?? {
              credits: 0,
              seconds: 0,
              failed: 0,
            };
            return (
              <div
                key={p.id}
                className="rounded-xl border border-white/[0.08] bg-[#11141B] p-4 space-y-2 text-xs"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-semibold text-slate-100 truncate">
                    {p.displayName}
                  </span>
                  <span
                    className={`font-mono-tabular ${
                      p.connectionStatus === 'connected'
                        ? 'text-emerald-400'
                        : 'text-slate-500'
                    }`}
                  >
                    {p.connectionStatus}
                  </span>
                </div>

                <div className="text-slate-400 font-mono-tabular space-y-1">
                  <div>
                    Confirmed:{' '}
                    {p.confirmedQuota.exposedByApi &&
                    p.confirmedQuota.confirmedCreditsRemaining !== null
                      ? `${p.confirmedQuota.confirmedCreditsRemaining} ${p.confirmedQuota.unitLabel}`
                      : 'Unavailable via API'}
                  </div>
                  <div>
                    Manual Est.:{' '}
                    {p.manualEstimate.monthlyCreditsRemaining !== null
                      ? `${p.manualEstimate.monthlyCreditsRemaining} monthly`
                      : 'Not entered'}
                    {p.manualEstimate.nextResetAt
                      ? ` · Reset ${p.manualEstimate.nextResetAt}`
                      : ''}
                  </div>
                  <div className="pt-1 border-t border-white/[0.06] text-slate-300">
                    Consumed: {consumed.credits} cr · {consumed.seconds}s ·{' '}
                    {consumed.failed} failed
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* SMART JOB QUEUE */}
      <section className="rounded-xl border border-white/[0.08] bg-[#11141B] overflow-hidden">
        <div className="px-5 py-3.5 border-b border-white/[0.08] flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <h2 className="text-sm font-semibold text-slate-100">
            Smart Job Queue
          </h2>
          <div className="flex items-center gap-1 rounded-lg bg-[#0B0D11] p-1 border border-white/[0.06]">
            {(
              [
                { id: 'active', label: `Active (${queue?.active.length ?? 0})` },
                { id: 'pending', label: `Pending (${queue?.pending.length ?? 0})` },
                {
                  id: 'completed',
                  label: `Completed (${queue?.completed.length ?? 0})`,
                },
                { id: 'failed', label: `Failed (${queue?.failed.length ?? 0})` },
              ] as const
            ).map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setQueueTab(t.id)}
                className={`rounded-md px-3 py-1 text-xs font-medium transition-colors whitespace-nowrap ${
                  queueTab === t.id
                    ? 'bg-[#1E2430] text-slate-100'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>

        {activeJobs.length === 0 ? (
          <div className="p-8 text-center text-xs text-slate-400">
            No {queueTab} jobs in queue.
          </div>
        ) : (
          <div className="divide-y divide-white/[0.06]">
            {activeJobs.map((job) => (
              <div
                key={job.id}
                className="px-5 py-3.5 flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs"
              >
                <div className="min-w-0 space-y-1">
                  <div className="font-semibold text-slate-100 truncate">
                    {job.name}
                  </div>
                  <div className="text-slate-400 font-mono-tabular">
                    {job.selectedModels.videoProvider} ·{' '}
                    {job.selectedModels.videoModel} · {job.progressPercent}% ·{' '}
                    {job.status}
                  </div>
                  {job.errorMessage && (
                    <div className="text-red-400 flex items-center gap-1">
                      <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                      <span className="truncate">{job.errorMessage}</span>
                    </div>
                  )}
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  <button
                    type="button"
                    onClick={() => onOpenProject(job)}
                    className="inline-flex items-center gap-1 rounded border border-white/[0.12] bg-[#171B24] px-2.5 py-1.5 text-xs text-slate-200"
                  >
                    <FolderOpen className="h-3.5 w-3.5" />
                    Open
                  </button>

                  {(job.status === 'queued' ||
                    job.status === 'analyzing' ||
                    job.status === 'processing' ||
                    job.status === 'awaiting_paid_confirmation') && (
                    <button
                      type="button"
                      onClick={() => void handleCancel(job.id)}
                      className="inline-flex items-center gap-1 rounded border border-red-500/30 bg-red-950/30 px-2.5 py-1.5 text-xs text-red-300"
                    >
                      <XCircle className="h-3.5 w-3.5" />
                      Cancel
                    </button>
                  )}

                  {job.status === 'partial_failure' && (
                    <button
                      type="button"
                      onClick={() => void handleRetry(job)}
                      className="inline-flex items-center gap-1 rounded border border-amber-500/30 bg-amber-950/30 px-2.5 py-1.5 text-xs text-amber-300"
                    >
                      <RefreshCw className="h-3.5 w-3.5" />
                      Retry
                    </button>
                  )}

                  {job.status === 'completed' && job.outputVideoUrl && (
                    <a
                      href={`/api/projects/${job.id}/download/video`}
                      download
                      className="inline-flex items-center gap-1 rounded bg-emerald-600 px-2.5 py-1.5 text-xs font-medium text-white"
                    >
                      <Download className="h-3.5 w-3.5" />
                      MP4
                    </a>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Generation & Failure History Ledger */}
      <div className="rounded-xl border border-white/[0.08] bg-[#11141B] overflow-hidden">
        <div className="px-5 py-3.5 border-b border-white/[0.08] text-sm font-semibold text-slate-100">
          Generation &amp; Quota History
        </div>
        {entries.length === 0 ? (
          <div className="p-8 text-center text-sm text-slate-400">
            No generation attempts recorded yet.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-white/[0.08] text-slate-400 bg-[#0B0D11]/50">
                <tr>
                  <th className="px-4 py-3 font-medium">Project</th>
                  <th className="px-4 py-3 font-medium">Provider / Model</th>
                  <th className="px-4 py-3 font-medium">Status</th>
                  <th className="px-4 py-3 font-medium text-right">Segments</th>
                  <th className="px-4 py-3 font-medium text-right">Seconds</th>
                  <th className="px-4 py-3 font-medium text-right">Est. Cost</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/[0.06]">
                {entries.map((entry) => (
                  <tr key={entry.id} className="hover:bg-white/[0.02]">
                    <td className="px-4 py-3 text-slate-200 font-medium">
                      {entry.projectName}
                    </td>
                    <td className="px-4 py-3 text-slate-400 font-mono-tabular">
                      {entry.provider} · {entry.model}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={
                          entry.status === 'failed'
                            ? 'text-red-400'
                            : 'text-emerald-400'
                        }
                      >
                        {entry.status === 'failed' ? 'Failed attempt' : 'Succeeded'}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right font-mono-tabular text-slate-300">
                      {entry.segmentsCount}
                    </td>
                    <td className="px-4 py-3 text-right font-mono-tabular text-slate-300">
                      {entry.secondsGenerated}s
                    </td>
                    <td className="px-4 py-3 text-right font-mono-tabular text-[#E5A93C]">
                      ${entry.estimatedCostUsd.toFixed(2)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
};
