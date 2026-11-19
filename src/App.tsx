import React, { useCallback, useEffect, useState } from 'react';
import {
  Activity,
  BarChart3,
  Cpu,
  Film,
  FolderKanban,
  HelpCircle,
  Image as ImageIcon,
  KeyRound,
  Menu,
  Plus,
  Users,
  X,
} from 'lucide-react';
import {
  fetchCharacters,
  fetchEnvironments,
  fetchModels,
  fetchProjects,
  fetchProviders,
  fetchQueueOverview,
  fetchQuotaDashboard,
} from './api';
import { ApiSettingsView } from './components/ApiSettingsView';
import { CharactersView } from './components/CharactersView';
import { CreateStudioView } from './components/CreateStudioView';
import { DiagnosticsView } from './components/DiagnosticsView';
import { EnvironmentsView } from './components/EnvironmentsView';
import { HelpSupportView } from './components/HelpSupportView';
import { ModelsView } from './components/ModelsView';
import { ProjectsView } from './components/ProjectsView';
import { UsageCostView } from './components/UsageCostView';
import { type AppLocale, STRINGS } from './i18n';
import type {
  CharacterAsset,
  EnvironmentAsset,
  ModelCatalogItem,
  NavSection,
  ProjectRecord,
  ProviderConfigRecord,
  QueueOverview,
  QuotaDashboardResponse,
} from './types';

const ACTIVE_PROJECT_STORAGE_KEY = 'cinematic_active_project_id';

export default function App() {
  const [locale, setLocale] = useState<AppLocale>('en');
  const [activeNav, setActiveNav] = useState<NavSection>('create');
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const [characters, setCharacters] = useState<CharacterAsset[]>([]);
  const [environments, setEnvironments] = useState<EnvironmentAsset[]>([]);
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [models, setModels] = useState<ModelCatalogItem[]>([]);
  const [providers, setProviders] = useState<ProviderConfigRecord[]>([]);
  const [quotaData, setQuotaData] = useState<QuotaDashboardResponse | null>(
    null
  );
  const [queueOverview, setQueueOverview] = useState<QueueOverview | null>(null);

  const [activeProject, setActiveProject] = useState<ProjectRecord | null>(null);
  const [preselectedCharId, setPreselectedCharId] = useState<string | null>(null);
  const [preselectedEnvId, setPreselectedEnvId] = useState<string | null>(null);

  const t = STRINGS[locale];

  const selectActiveProject = useCallback((proj: ProjectRecord | null) => {
    setActiveProject(proj);
    try {
      if (proj?.id) {
        localStorage.setItem(ACTIVE_PROJECT_STORAGE_KEY, proj.id);
      } else {
        localStorage.removeItem(ACTIVE_PROJECT_STORAGE_KEY);
      }
    } catch {
      // ignore storage quota errors
    }
  }, []);

  useEffect(() => {
    document.documentElement.dir = t.dir;
    document.documentElement.lang = locale;
  }, [locale, t.dir]);

  const loadAll = useCallback(async () => {
    try {
      const [chars, envs, projs, mods, provs, quota, queue] = await Promise.all([
        fetchCharacters(),
        fetchEnvironments(),
        fetchProjects(),
        fetchModels(),
        fetchProviders(),
        fetchQuotaDashboard(),
        fetchQueueOverview(),
      ]);
      setCharacters(chars);
      setEnvironments(envs);
      setProjects(projs);
      setModels(mods);
      setProviders(provs);
      setQuotaData(quota);
      setQueueOverview(queue);

      setActiveProject((current) => {
        if (current) {
          const refreshed = projs.find((p) => p.id === current.id);
          return refreshed ?? current;
        }
        try {
          const savedId = localStorage.getItem(ACTIVE_PROJECT_STORAGE_KEY);
          if (savedId) {
            const found = projs.find((p) => p.id === savedId);
            if (found) return found;
          }
        } catch {
          // ignore localStorage access failure
        }
        const liveOrRecent = projs.find(
          (p) =>
            p.status === 'queued' ||
            p.status === 'analyzing' ||
            p.status === 'processing'
        );
        return liveOrRecent ?? null;
      });
    } catch {
      // Keep existing state on transient network hiccup
    }
  }, []);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  const handleSelectNav = (sec: NavSection) => {
    setActiveNav(sec);
    setMobileMenuOpen(false);
    if (sec === 'projects' || sec === 'usage' || sec === 'settings') {
      void loadAll();
    }
  };

  const handleNewVideo = () => {
    selectActiveProject(null);
    setPreselectedCharId(null);
    setPreselectedEnvId(null);
    setActiveNav('create');
    setMobileMenuOpen(false);
  };

  const navItems: Array<{
    id: NavSection;
    label: string;
    icon: React.FC<{ className?: string }>;
  }> = [
    { id: 'create', label: t.nav.create, icon: Film },
    { id: 'projects', label: t.nav.projects, icon: FolderKanban },
    { id: 'characters', label: t.nav.characters, icon: Users },
    { id: 'environments', label: t.nav.environments, icon: ImageIcon },
    { id: 'models', label: t.nav.models, icon: Cpu },
    { id: 'settings', label: t.nav.settings, icon: KeyRound },
    { id: 'usage', label: t.nav.usage, icon: BarChart3 },
    { id: 'diagnostics', label: t.nav.diagnostics, icon: Activity },
    { id: 'help', label: t.nav.help, icon: HelpCircle },
  ];

  return (
    <div className="min-h-screen bg-[#0B0D11] text-[#F1F5F9] flex flex-col">
      {/* 3-ZONE TOP BAR */}
      <header className="sticky top-0 z-30 h-16 border-b border-white/[0.08] bg-[#0B0D11]/95 backdrop-blur px-4 lg:px-6 flex items-center justify-between gap-8">
        {/* Zone 1: Brand Wordmark (+ mobile drawer trigger) */}
        <div className="flex items-center gap-3 shrink-0">
          <button
            type="button"
            onClick={() => setMobileMenuOpen((v) => !v)}
            className="lg:hidden rounded-lg p-2 text-slate-300 hover:bg-white/[0.06]"
            aria-label="Toggle menu"
          >
            {mobileMenuOpen ? (
              <X className="h-5 w-5" />
            ) : (
              <Menu className="h-5 w-5" />
            )}
          </button>
          <button
            type="button"
            onClick={() => handleSelectNav('create')}
            className="font-display text-lg font-bold tracking-tight text-slate-100 whitespace-nowrap shrink-0"
          >
            {t.brand}
          </button>
        </div>

        {/* Zone 2: 4 concise single-line nav links */}
        <nav className="hidden md:flex items-center gap-6 text-sm font-medium text-slate-400">
          <button
            type="button"
            onClick={() => handleSelectNav('create')}
            className={`hover:text-slate-100 transition-colors whitespace-nowrap shrink-0 ${
              activeNav === 'create'
                ? 'text-slate-100 underline underline-offset-8 decoration-[#E5A93C]'
                : ''
            }`}
          >
            Studio
          </button>
          <button
            type="button"
            onClick={() => handleSelectNav('projects')}
            className={`hover:text-slate-100 transition-colors whitespace-nowrap shrink-0 ${
              activeNav === 'projects'
                ? 'text-slate-100 underline underline-offset-8 decoration-[#E5A93C]'
                : ''
            }`}
          >
            Projects
          </button>
          <button
            type="button"
            onClick={() => handleSelectNav('settings')}
            className={`hover:text-slate-100 transition-colors whitespace-nowrap shrink-0 ${
              activeNav === 'settings'
                ? 'text-slate-100 underline underline-offset-8 decoration-[#E5A93C]'
                : ''
            }`}
          >
            Providers
          </button>
          <button
            type="button"
            onClick={() => handleSelectNav('usage')}
            className={`hover:text-slate-100 transition-colors whitespace-nowrap shrink-0 ${
              activeNav === 'usage'
                ? 'text-slate-100 underline underline-offset-8 decoration-[#E5A93C]'
                : ''
            }`}
          >
            Quotas &amp; Queue
          </button>
        </nav>

        {/* Zone 3: Language Selector + 1 Primary Action */}
        <div className="flex items-center gap-3 shrink-0">
          <select
            aria-label="Interface language"
            value={locale}
            onChange={(e) => setLocale(e.target.value as AppLocale)}
            className="rounded-lg border border-white/[0.12] bg-[#11141B] px-2.5 py-1.5 text-xs font-medium text-slate-200 focus:border-[#E5A93C] focus:outline-none"
          >
            <option value="en">EN</option>
            <option value="fa">FA (فارسی)</option>
          </select>

          <button
            type="button"
            onClick={handleNewVideo}
            className="inline-flex items-center gap-1.5 rounded-lg bg-[#E5A93C] px-4 py-2 text-xs font-semibold text-[#0B0D11] hover:bg-[#F0B84D] transition-colors whitespace-nowrap shrink-0"
          >
            <Plus className="h-3.5 w-3.5" />
            {t.actions.newVideo}
          </button>
        </div>
      </header>

      <div className="flex flex-1 min-h-0">
        {/* LEFT SIDEBAR */}
        <aside
          className={`${
            mobileMenuOpen ? 'fixed inset-y-16 left-0 z-40 block' : 'hidden'
          } lg:static lg:block w-64 shrink-0 border-r border-white/[0.08] bg-[#11141B] p-4`}
        >
          <nav className="space-y-1" aria-label="Studio sections">
            {navItems.map((item) => {
              const Icon = item.icon;
              const isActive = activeNav === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => handleSelectNav(item.id)}
                  className={`w-full flex items-center gap-3 rounded-lg px-3.5 py-2.5 text-sm font-medium transition-colors whitespace-nowrap ${
                    isActive
                      ? 'bg-[#171B24] text-slate-100 border border-white/[0.08]'
                      : 'text-slate-400 hover:text-slate-100 hover:bg-white/[0.04]'
                  }`}
                >
                  <Icon
                    className={`h-4 w-4 shrink-0 ${
                      isActive ? 'text-[#E5A93C]' : 'text-slate-500'
                    }`}
                  />
                  <span className="truncate">{item.label}</span>
                </button>
              );
            })}
          </nav>
        </aside>

        {/* MAIN STUDIO CONTENT VIEWPORT */}
        <main className="flex-1 min-w-0 p-5 lg:p-8 max-w-[1440px]">
          {activeNav === 'create' && (
            <CreateStudioView
              locale={locale}
              characters={characters}
              environments={environments}
              activeProject={activeProject}
              preselectedCharacterId={preselectedCharId}
              preselectedEnvironmentId={preselectedEnvId}
              onRefreshAssets={() => void loadAll()}
              onProjectChange={(proj) => {
                selectActiveProject(proj);
                if (
                  proj &&
                  (proj.status === 'completed' ||
                    proj.status === 'draft' ||
                    proj.status === 'failed' ||
                    proj.status === 'partial_failure' ||
                    proj.status === 'cancelled')
                ) {
                  void loadAll();
                }
              }}
            />
          )}

          {activeNav === 'projects' && (
            <ProjectsView
              projects={projects}
              onRefresh={() => void loadAll()}
              onOpenProject={(proj) => {
                selectActiveProject(proj);
                setActiveNav('create');
              }}
              onCreateNew={handleNewVideo}
            />
          )}

          {activeNav === 'characters' && (
            <CharactersView
              characters={characters}
              onRefresh={() => void loadAll()}
              onUseCharacter={(id) => {
                setPreselectedCharId(id);
                setActiveNav('create');
              }}
            />
          )}

          {activeNav === 'environments' && (
            <EnvironmentsView
              environments={environments}
              onRefresh={() => void loadAll()}
              onUseEnvironment={(id) => {
                setPreselectedEnvId(id);
                setActiveNav('create');
              }}
            />
          )}

          {activeNav === 'models' && <ModelsView models={models} />}

          {activeNav === 'settings' && (
            <ApiSettingsView
              providers={providers}
              onRefresh={() => void loadAll()}
            />
          )}

          {activeNav === 'usage' && (
            <UsageCostView
              quotaData={quotaData}
              queue={queueOverview}
              onRefresh={() => void loadAll()}
              onOpenProject={(proj) => {
                selectActiveProject(proj);
                setActiveNav('create');
              }}
            />
          )}

          {activeNav === 'diagnostics' && <DiagnosticsView />}

          {activeNav === 'help' && <HelpSupportView />}
        </main>
      </div>
    </div>
  );
}
