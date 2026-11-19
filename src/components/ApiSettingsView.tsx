import React, { useState } from 'react';
import {
  CheckCircle2,
  Cpu,
  ExternalLink,
  KeyRound,
  Loader2,
  Plus,
  Power,
  RefreshCw,
  ShieldCheck,
  Trash2,
  XCircle,
} from 'lucide-react';
import {
  addCustomProvider,
  deleteCustomProvider,
  testProviderConnection,
  updateProviderConfig,
} from '../api';
import type { ProviderConfigRecord, ProviderId } from '../types';

interface ApiSettingsViewProps {
  providers: ProviderConfigRecord[];
  onRefresh: () => void;
}

export const ApiSettingsView: React.FC<ApiSettingsViewProps> = ({
  providers,
  onRefresh,
}) => {
  const [testingId, setTestingId] = useState<string | null>(null);
  const [editingQuotaId, setEditingQuotaId] = useState<string | null>(null);
  const [dailyInput, setDailyInput] = useState<string>('');
  const [monthlyInput, setMonthlyInput] = useState<string>('');
  const [secondsInput, setSecondsInput] = useState<string>('');
  const [resetInput, setResetInput] = useState<string>('');

  const [showAddForm, setShowAddForm] = useState(false);
  const [newProviderType, setNewProviderType] =
    useState<ProviderId>('huggingface');
  const [newDisplayName, setNewDisplayName] = useState('');
  const [newEnvVarName, setNewEnvVarName] = useState('HF_TOKEN');
  const [newMonthlyEst, setNewMonthlyEst] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [workerUrlInput, setWorkerUrlInput] = useState<string>('');
  const [workerUrlInitialized, setWorkerUrlInitialized] = useState(false);
  const [savingWorkerUrl, setSavingWorkerUrl] = useState(false);

  const localWorker = providers.find((p) => p.providerType === 'local_gpu_worker');
  React.useEffect(() => {
    if (!workerUrlInitialized && localWorker) {
      setWorkerUrlInput(localWorker.endpointUrl ?? '');
      setWorkerUrlInitialized(true);
    }
  }, [localWorker, workerUrlInitialized]);

  const handleSaveWorkerUrl = async (providerId: string) => {
    setSavingWorkerUrl(true);
    setError(null);
    try {
      await updateProviderConfig(providerId, {
        endpointUrl: workerUrlInput.trim() || null,
      });
      await testProviderConnection(providerId);
      onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingWorkerUrl(false);
    }
  };

  const handleTest = async (id: string) => {
    setTestingId(id);
    setError(null);
    try {
      await testProviderConnection(id);
      onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setTestingId(null);
    }
  };

  const handleToggleEnabled = async (p: ProviderConfigRecord) => {
    await updateProviderConfig(p.id, { enabled: !p.enabled });
    onRefresh();
  };

  const handleRemove = async (id: string) => {
    await deleteCustomProvider(id);
    onRefresh();
  };

  const startEditQuota = (p: ProviderConfigRecord) => {
    setEditingQuotaId(p.id);
    setDailyInput(
      p.manualEstimate.dailyCreditsRemaining !== null
        ? String(p.manualEstimate.dailyCreditsRemaining)
        : ''
    );
    setMonthlyInput(
      p.manualEstimate.monthlyCreditsRemaining !== null
        ? String(p.manualEstimate.monthlyCreditsRemaining)
        : ''
    );
    setSecondsInput(
      p.manualEstimate.estimatedSecondsRemaining !== null
        ? String(p.manualEstimate.estimatedSecondsRemaining)
        : ''
    );
    setResetInput(p.manualEstimate.nextResetAt ?? '');
  };

  const saveQuotaEstimate = async (id: string) => {
    await updateProviderConfig(id, {
      manualEstimate: {
        dailyCreditsRemaining: dailyInput ? Number(dailyInput) : null,
        monthlyCreditsRemaining: monthlyInput ? Number(monthlyInput) : null,
        estimatedSecondsRemaining: secondsInput ? Number(secondsInput) : null,
        nextResetAt: resetInput.trim() || null,
      },
    });
    setEditingQuotaId(null);
    onRefresh();
  };

  const handleAddProvider = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newDisplayName.trim()) {
      setError('Enter a provider display name.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await addCustomProvider({
        providerType: newProviderType,
        displayName: newDisplayName.trim(),
        envVarName: newEnvVarName.trim() || undefined,
        monthlyCreditsRemaining: newMonthlyEst ? Number(newMonthlyEst) : null,
      });
      setShowAddForm(false);
      setNewDisplayName('');
      setNewMonthlyEst('');
      onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 border-b border-white/[0.08] pb-5">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-slate-100">
            Provider Connections &amp; API Settings
          </h1>
          <p className="text-sm text-slate-400 mt-1">
            Inspect connected AI video providers, test live API health, check official quotas, and manage server-side secrets securely without exposing credentials in browser code.
          </p>
        </div>

        <button
          type="button"
          onClick={() => setShowAddForm((v) => !v)}
          className="inline-flex items-center gap-1.5 rounded-lg bg-[#E5A93C] px-4 py-2 text-xs font-semibold text-[#0B0D11] hover:bg-[#F0B84D] whitespace-nowrap shrink-0"
        >
          <Plus className="h-3.5 w-3.5" />
          Add Provider Adapter
        </button>
      </div>

      {error && (
        <div className="rounded-lg border border-red-500/30 bg-red-950/30 px-4 py-3 text-xs text-red-200">
          {error}
        </div>
      )}

      {/* Server-Side Secret Security Notice */}
      <div className="rounded-xl border border-white/[0.08] bg-[#11141B] p-4 flex items-start gap-3 text-xs text-slate-300">
        <ShieldCheck className="h-4 w-4 text-emerald-400 shrink-0 mt-0.5" />
        <p className="leading-relaxed">
          All provider tokens (<code className="font-mono text-slate-200">GEMINI_API_KEY</code>,{' '}
          <code className="font-mono text-slate-200">HF_TOKEN</code>,{' '}
          <code className="font-mono text-slate-200">FAL_KEY</code>,{' '}
          <code className="font-mono text-slate-200">REPLICATE_API_TOKEN</code>,{' '}
          <code className="font-mono text-slate-200">RUNWAYML_API_SECRET</code>,{' '}
          <code className="font-mono text-slate-200">LUMA_API_KEY</code>) are read strictly from server environment secrets (**Settings &gt; Secrets**) and are never entered in or exposed to frontend JavaScript.
        </p>
      </div>

      {/* Add Custom Provider Adapter Form */}
      {showAddForm && (
        <form
          onSubmit={(e) => void handleAddProvider(e)}
          className="rounded-xl border border-[#E5A93C]/40 bg-[#11141B] p-5 space-y-4"
        >
          <h2 className="text-sm font-semibold text-slate-100">
            Register Additional Provider Adapter Profile
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <div>
              <label className="block text-xs text-slate-400 mb-1">
                Official Adapter
              </label>
              <select
                value={newProviderType}
                onChange={(e) => {
                  const pt = e.target.value as ProviderId;
                  setNewProviderType(pt);
                  if (pt === 'huggingface') setNewEnvVarName('HF_TOKEN');
                  else if (pt === 'fal_ai') setNewEnvVarName('FAL_KEY');
                  else if (pt === 'replicate')
                    setNewEnvVarName('REPLICATE_API_TOKEN');
                  else if (pt === 'runway')
                    setNewEnvVarName('RUNWAYML_API_SECRET');
                  else if (pt === 'luma') setNewEnvVarName('LUMA_API_KEY');
                  else setNewEnvVarName('GEMINI_API_KEY');
                }}
                className="w-full rounded-lg border border-white/[0.1] bg-[#0B0D11] px-3 py-2 text-xs text-slate-100"
              >
                <option value="huggingface">Hugging Face Inference Providers</option>
                <option value="fal_ai">fal.ai Platform API</option>
                <option value="replicate">Replicate API</option>
                <option value="runway">Runway API</option>
                <option value="luma">Luma Dream Machine API</option>
              </select>
            </div>
            <div>
              <label className="block text-xs text-slate-400 mb-1">
                Display Label
              </label>
              <input
                type="text"
                value={newDisplayName}
                onChange={(e) => setNewDisplayName(e.target.value)}
                placeholder="e.g., HF Secondary Account"
                className="w-full rounded-lg border border-white/[0.1] bg-[#0B0D11] px-3 py-2 text-xs text-slate-100"
              />
            </div>
            <div>
              <label className="block text-xs text-slate-400 mb-1">
                Server Secret Env Var Name
              </label>
              <input
                type="text"
                value={newEnvVarName}
                onChange={(e) => setNewEnvVarName(e.target.value)}
                className="w-full rounded-lg border border-white/[0.1] bg-[#0B0D11] px-3 py-2 text-xs font-mono text-slate-100"
              />
            </div>
            <div>
              <label className="block text-xs text-slate-400 mb-1">
                Manual Monthly Credit Estimate (Opt.)
              </label>
              <input
                type="number"
                value={newMonthlyEst}
                onChange={(e) => setNewMonthlyEst(e.target.value)}
                placeholder="e.g., 10"
                className="w-full rounded-lg border border-white/[0.1] bg-[#0B0D11] px-3 py-2 text-xs text-slate-100"
              />
            </div>
          </div>

          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setShowAddForm(false)}
              className="rounded-lg border border-white/[0.12] px-3.5 py-2 text-xs text-slate-300"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              className="rounded-lg bg-[#E5A93C] px-4 py-2 text-xs font-semibold text-[#0B0D11]"
            >
              {saving ? 'Adding...' : 'Add Provider'}
            </button>
          </div>
        </form>
      )}

      {/* Provider Cards */}
      <div className="space-y-4">
        {providers.map((p) => (
          <article
            key={p.id}
            className="rounded-xl border border-white/[0.08] bg-[#11141B] p-5 space-y-4"
          >
            <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
              <div className="flex items-start gap-3">
                <div className="h-10 w-10 rounded-lg bg-[#171B24] border border-white/[0.08] flex items-center justify-center text-[#E5A93C] shrink-0">
                  <KeyRound className="h-5 w-5" />
                </div>
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="text-base font-semibold text-slate-100">
                      {p.displayName}
                    </h2>
                    <span className="text-xs text-slate-400 font-mono-tabular">
                      {p.providerType === 'local_gpu_worker'
                        ? '· Self-Hosted Worker ($0 API Fees)'
                        : `· Secret: ${p.envVarName}`}
                    </span>
                  </div>
                  <div className="flex flex-wrap items-center gap-2 text-xs mt-1">
                    {p.connectionStatus === 'connected' ? (
                      <span className="inline-flex items-center gap-1 text-emerald-400">
                        <CheckCircle2 className="h-3.5 w-3.5" />
                        Connected
                      </span>
                    ) : p.connectionStatus === 'disabled' ? (
                      <span className="text-slate-500">Disabled</span>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-amber-300">
                        <XCircle className="h-3.5 w-3.5" />
                        {p.connectionStatus === 'error'
                          ? 'Connection Error'
                          : p.providerType === 'local_gpu_worker'
                            ? 'Worker URL Not Configured'
                            : 'Secret Not Configured'}
                      </span>
                    )}
                    <span aria-hidden="true" className="text-slate-600">
                      ·
                    </span>
                    <span
                      className={
                        p.freeVideoEligible ? 'text-emerald-300' : 'text-slate-400'
                      }
                    >
                      {p.providerType === 'local_gpu_worker'
                        ? '$0 API Fees · Own GPU / Free Colab'
                        : p.freeVideoEligible
                          ? 'Free Tier Eligible'
                          : p.providerType === 'google_gemini'
                            ? 'Free Stages 2–3 · Paid Stage 4 / V2V'
                            : 'Paid API Credits Required'}
                    </span>
                  </div>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  disabled={testingId === p.id}
                  onClick={() => void handleTest(p.id)}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-[#E5A93C] px-3.5 py-2 text-xs font-semibold text-[#0B0D11] hover:bg-[#F0B84D] disabled:opacity-50 whitespace-nowrap"
                >
                  {testingId === p.id ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <RefreshCw className="h-3.5 w-3.5" />
                  )}
                  Test &amp; Check Quota
                </button>

                <button
                  type="button"
                  onClick={() => void handleToggleEnabled(p)}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-white/[0.12] bg-[#171B24] px-3 py-2 text-xs font-medium text-slate-200 hover:border-white/[0.25] whitespace-nowrap"
                >
                  <Power className="h-3.5 w-3.5" />
                  {p.enabled ? 'Disable' : 'Enable'}
                </button>

                {p.providerType !== 'local_gpu_worker' && (
                  <a
                    href={p.officialPortalUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 rounded-lg border border-white/[0.12] bg-[#171B24] px-3 py-2 text-xs font-medium text-slate-200 hover:border-white/[0.25] whitespace-nowrap"
                  >
                    Key Portal
                    <ExternalLink className="h-3 w-3 text-[#E5A93C]" />
                  </a>
                )}

                {!p.isBuiltin && (
                  <button
                    type="button"
                    onClick={() => void handleRemove(p.id)}
                    className="rounded-lg border border-white/[0.12] p-2 text-slate-400 hover:text-red-400"
                    title="Remove provider"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            </div>

            {p.providerType === 'local_gpu_worker' && (
              <div className="rounded-lg border border-white/[0.08] bg-[#0B0D11]/80 p-3.5 space-y-2.5 text-xs">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-semibold text-slate-200">
                    Self-Hosted GPU Worker HTTP Endpoint (No API Key Needed)
                  </span>
                  <span className="text-[11px] text-slate-400">
                    {p.hardwareRequirement}
                  </span>
                </div>
                <div className="flex flex-col sm:flex-row gap-2">
                  <input
                    type="url"
                    value={workerUrlInput}
                    onChange={(e) => setWorkerUrlInput(e.target.value)}
                    placeholder="http://127.0.0.1:8000 or https://your-colab-tunnel.trycloudflare.com"
                    className="flex-1 rounded-lg border border-white/[0.12] bg-[#171B24] px-3 py-2 text-xs font-mono text-slate-100 placeholder:text-slate-500"
                  />
                  <button
                    type="button"
                    disabled={savingWorkerUrl}
                    onClick={() => void handleSaveWorkerUrl(p.id)}
                    className="rounded-lg bg-[#E5A93C] px-4 py-2 text-xs font-semibold text-[#0B0D11] hover:bg-[#F0B84D] disabled:opacity-50 whitespace-nowrap"
                  >
                    {savingWorkerUrl ? 'Connecting...' : 'Save & Test Worker'}
                  </button>
                </div>
                <div className="text-[11px] text-slate-400 font-mono">
                  Run locally or on Google Colab: <span className="text-slate-300">cd worker &amp;&amp; pip install -r requirements.txt &amp;&amp; uvicorn gpu_worker:app --host 0.0.0.0 --port 8000</span>
                </div>
              </div>
            )}

            {p.lastError && (
              <div className="rounded-lg border border-amber-500/30 bg-amber-950/25 px-3.5 py-2 text-xs text-amber-200">
                {p.lastError}
              </div>
            )}

            {/* Quota Details: Confirmed vs Manual Estimate */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 border-t border-white/[0.06] pt-4 text-xs">
              <div className="rounded-lg border border-white/[0.06] bg-[#0B0D11]/60 p-3 space-y-1">
                <div className="font-semibold text-slate-300">
                  Confirmed Provider Quota
                </div>
                {p.confirmedQuota.exposedByApi &&
                p.confirmedQuota.confirmedCreditsRemaining !== null ? (
                  <div className="text-emerald-300 font-mono-tabular">
                    {p.confirmedQuota.confirmedCreditsRemaining}{' '}
                    {p.confirmedQuota.unitLabel} remaining
                  </div>
                ) : (
                  <div className="text-slate-400">
                    Quota information unavailable via API
                  </div>
                )}
                <p className="text-[11px] text-slate-500 leading-relaxed">
                  {p.confirmedQuota.note}
                </p>
              </div>

              <div className="rounded-lg border border-white/[0.06] bg-[#0B0D11]/60 p-3 space-y-1.5">
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-slate-300">
                    Manual Quota Estimate (User-Entered)
                  </span>
                  <button
                    type="button"
                    onClick={() =>
                      editingQuotaId === p.id
                        ? setEditingQuotaId(null)
                        : startEditQuota(p)
                    }
                    className="text-[11px] text-[#E5A93C] hover:underline"
                  >
                    {editingQuotaId === p.id ? 'Cancel' : 'Edit Estimate'}
                  </button>
                </div>

                {editingQuotaId === p.id ? (
                  <div className="grid grid-cols-2 gap-2 pt-1">
                    <input
                      type="number"
                      placeholder="Daily credits"
                      value={dailyInput}
                      onChange={(e) => setDailyInput(e.target.value)}
                      className="rounded border border-white/[0.12] bg-[#171B24] px-2 py-1 text-xs text-slate-100"
                    />
                    <input
                      type="number"
                      placeholder="Monthly credits"
                      value={monthlyInput}
                      onChange={(e) => setMonthlyInput(e.target.value)}
                      className="rounded border border-white/[0.12] bg-[#171B24] px-2 py-1 text-xs text-slate-100"
                    />
                    <input
                      type="number"
                      placeholder="Est. video seconds"
                      value={secondsInput}
                      onChange={(e) => setSecondsInput(e.target.value)}
                      className="rounded border border-white/[0.12] bg-[#171B24] px-2 py-1 text-xs text-slate-100"
                    />
                    <input
                      type="text"
                      placeholder="Next reset (e.g. Dec 1)"
                      value={resetInput}
                      onChange={(e) => setResetInput(e.target.value)}
                      className="rounded border border-white/[0.12] bg-[#171B24] px-2 py-1 text-xs text-slate-100"
                    />
                    <button
                      type="button"
                      onClick={() => void saveQuotaEstimate(p.id)}
                      className="col-span-2 rounded bg-[#E5A93C] py-1.5 text-xs font-semibold text-[#0B0D11]"
                    >
                      Save Manual Estimate
                    </button>
                  </div>
                ) : (
                  <div className="text-slate-400 font-mono-tabular space-y-0.5">
                    <div>
                      Daily:{' '}
                      {p.manualEstimate.dailyCreditsRemaining ?? 'Not set'} ·
                      Monthly:{' '}
                      {p.manualEstimate.monthlyCreditsRemaining ?? 'Not set'}
                    </div>
                    <div>
                      Est. Seconds:{' '}
                      {p.manualEstimate.estimatedSecondsRemaining ?? 'Not set'} ·
                      Reset: {p.manualEstimate.nextResetAt ?? 'Unknown'}
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* Supported Models Matrix */}
            <div className="border-t border-white/[0.06] pt-3">
              <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-400 mb-2 flex items-center gap-1.5">
                <Cpu className="h-3.5 w-3.5" />
                <span>Available Models &amp; Capabilities</span>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="text-slate-500 border-b border-white/[0.06]">
                    <tr>
                      <th className="py-1.5 pr-3 font-medium">Model</th>
                      <th className="py-1.5 pr-3 font-medium">Tier</th>
                      <th className="py-1.5 pr-3 font-medium">Max Duration</th>
                      <th className="py-1.5 pr-3 font-medium">Resolutions</th>
                      <th className="py-1.5 pr-3 font-medium">I2V / V2V / Char Ref</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/[0.04]">
                    {p.models.map((m) => (
                      <tr key={m.id}>
                        <td className="py-2 pr-3 text-slate-200 font-mono-tabular">
                          {m.id}
                        </td>
                        <td className="py-2 pr-3">
                          <span
                            className={
                              m.freeTierEligible
                                ? 'text-emerald-400'
                                : 'text-[#E5A93C]'
                            }
                          >
                            {m.freeTierEligible ? 'Free-tier eligible' : 'Paid'}
                          </span>
                        </td>
                        <td className="py-2 pr-3 font-mono-tabular text-slate-300">
                          {m.maxDurationSec}s
                        </td>
                        <td className="py-2 pr-3 font-mono-tabular text-slate-300">
                          {m.supportedResolutions.join(', ')}
                        </td>
                        <td className="py-2 pr-3 text-slate-400">
                          {m.supportsImageToVideo ? 'I2V' : '—'} /{' '}
                          {m.supportsVideoToVideo ? 'V2V' : '—'} /{' '}
                          {m.supportsCharacterReference ? 'CharRef' : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </article>
        ))}
      </div>
    </div>
  );
};
