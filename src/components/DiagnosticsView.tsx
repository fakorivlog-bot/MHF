import React, { useState } from 'react';
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Loader2,
  Play,
  Terminal,
  XCircle,
} from 'lucide-react';
import { runSelfTestSuite } from '../api';
import type { SelfTestItem, SelfTestReport } from '../types';

export const DiagnosticsView: React.FC = () => {
  const [report, setReport] = useState<SelfTestReport | null>(null);
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [expandedIds, setExpandedIds] = useState<Record<string, boolean>>({});

  const handleRunTests = async () => {
    setRunning(true);
    setRunError(null);
    try {
      const res = await runSelfTestSuite();
      setReport(res);
      const autoExpand: Record<string, boolean> = {};
      for (const item of res.tests) {
        if (item.status === 'FAIL') {
          autoExpand[item.id] = true;
        }
      }
      setExpandedIds(autoExpand);
    } catch (err) {
      setRunError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  };

  const toggleDetail = (id: string) => {
    setExpandedIds((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  const renderStatusLabel = (status: SelfTestItem['status']) => {
    if (status === 'PASS') {
      return (
        <span className="inline-flex items-center gap-1.5 text-xs font-semibold font-mono-tabular text-emerald-400">
          <CheckCircle2 className="h-3.5 w-3.5" />
          PASS
        </span>
      );
    }
    return (
      <span className="inline-flex items-center gap-1.5 text-xs font-semibold font-mono-tabular text-red-400">
        <XCircle className="h-3.5 w-3.5" />
        FAIL
      </span>
    );
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 border-b border-white/[0.08] pb-5">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-slate-100">
            Self-Test &amp; Pipeline Diagnostics
          </h1>
          <p className="text-sm text-slate-400 mt-1 max-w-2xl">
            Executes 10 live end-to-end checks across backend connectivity, API authentication,
            provider discovery, MP4 chunked/multipart upload, FFmpeg file validation, generation
            submission, job polling, output integrity verification, and verified MP4 download.
          </p>
        </div>

        <button
          type="button"
          disabled={running}
          onClick={() => void handleRunTests()}
          className="inline-flex items-center gap-2 rounded-lg bg-[#E5A93C] px-4 py-2.5 text-xs font-semibold text-[#0B0D11] hover:bg-[#F0B84D] disabled:opacity-50 transition-colors whitespace-nowrap shrink-0"
        >
          {running ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Play className="h-4 w-4 fill-current" />
          )}
          {running ? 'Running 10 Live Checks...' : 'Run All 10 Self-Tests'}
        </button>
      </div>

      {runError && (
        <div
          role="alert"
          className="flex items-start gap-3 rounded-lg border border-red-500/30 bg-red-950/30 px-4 py-3 text-sm text-red-200"
        >
          <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0 text-red-400" />
          <div className="flex-1 break-words">{runError}</div>
        </div>
      )}

      {!report && !running && (
        <div className="rounded-xl border border-white/[0.08] bg-[#11141B] p-10 text-center space-y-3">
          <Activity className="h-9 w-9 text-[#E5A93C] mx-auto" />
          <h2 className="text-base font-medium text-slate-100">
            Ready to Verify Complete Video Pipeline
          </h2>
          <p className="text-sm text-slate-400 max-w-lg mx-auto">
            Each check executes against the live Express server, local storage, FFmpeg/FFprobe,
            and configured provider tokens. Unconfigured providers or failed stages strictly report{' '}
            <span className="font-mono text-slate-200">FAIL</span> without synthetic pass results.
          </p>
        </div>
      )}

      {report && (
        <div className="space-y-5">
          {/* Summary Strip */}
          <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
            <div className="rounded-xl border border-white/[0.08] bg-[#11141B] p-4">
              <div className="text-xs text-slate-400">Overall Suite Status</div>
              <div
                className={`mt-1 text-lg font-semibold font-mono-tabular ${
                  report.overallStatus === 'PASS'
                    ? 'text-emerald-400'
                    : report.overallStatus === 'PARTIAL_FAIL'
                      ? 'text-amber-300'
                      : 'text-red-400'
                }`}
              >
                {report.overallStatus}
              </div>
            </div>
            <div className="rounded-xl border border-white/[0.08] bg-[#11141B] p-4">
              <div className="text-xs text-slate-400">Passed Checks</div>
              <div className="mt-1 text-lg font-semibold font-mono-tabular text-emerald-400">
                {report.passedCount} / {report.tests.length}
              </div>
            </div>
            <div className="rounded-xl border border-white/[0.08] bg-[#11141B] p-4">
              <div className="text-xs text-slate-400">Failed Checks</div>
              <div
                className={`mt-1 text-lg font-semibold font-mono-tabular ${
                  report.failedCount > 0 ? 'text-red-400' : 'text-slate-300'
                }`}
              >
                {report.failedCount}
              </div>
            </div>
            <div className="rounded-xl border border-white/[0.08] bg-[#11141B] p-4">
              <div className="text-xs text-slate-400">Executed At</div>
              <div className="mt-1 text-sm font-mono-tabular text-slate-200">
                {new Date(report.ranAt).toLocaleTimeString()}
              </div>
            </div>
          </div>

          {/* 10 Test Results */}
          <div className="rounded-xl border border-white/[0.08] bg-[#11141B] overflow-hidden divide-y divide-white/[0.06]">
            {report.tests.map((test, index) => {
              const isOpen = Boolean(expandedIds[test.id]);
              return (
                <div key={test.id} className="p-4 space-y-2.5">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="flex items-center gap-3 min-w-0">
                      <span className="text-xs font-mono-tabular text-slate-500 w-5 shrink-0">
                        {String(index + 1).padStart(2, '0')}
                      </span>
                      <div className="min-w-0">
                        <div className="text-sm font-medium text-slate-100">
                          {test.name}
                        </div>
                        <div className="text-xs text-slate-400 mt-0.5 break-words">
                          {test.summary}
                        </div>
                      </div>
                    </div>

                    <div className="flex items-center gap-4 shrink-0">
                      {typeof test.httpStatus === 'number' && (
                        <span className="text-xs font-mono-tabular text-slate-400">
                          HTTP {test.httpStatus}
                        </span>
                      )}
                      <span className="text-xs font-mono-tabular text-slate-400">
                        {test.durationMs}ms
                      </span>
                      {renderStatusLabel(test.status)}
                      <button
                        type="button"
                        onClick={() => toggleDetail(test.id)}
                        className="inline-flex items-center gap-1 rounded border border-white/[0.1] bg-[#0B0D11] px-2.5 py-1 text-xs text-slate-300 hover:border-white/[0.25]"
                      >
                        <Terminal className="h-3 w-3" />
                        Detail
                        {isOpen ? (
                          <ChevronUp className="h-3 w-3" />
                        ) : (
                          <ChevronDown className="h-3 w-3" />
                        )}
                      </button>
                    </div>
                  </div>

                  {isOpen && (
                    <div className="rounded-lg border border-white/[0.06] bg-[#0B0D11] p-3 text-xs font-mono text-slate-300 break-words whitespace-pre-wrap">
                      {test.detail}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
};
