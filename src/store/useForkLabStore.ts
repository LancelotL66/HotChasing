import { create } from 'zustand';
import { forkLabApi } from '../services/forkLabApi';

interface ForkLabState {
  forkedRepoIds: Set<number>;
  loaded: boolean;
  loading: boolean;
  load: (force?: boolean) => Promise<void>;
  markAdded: (repoId: number) => void;
  markRemoved: (repoId: number) => void;
}

export const useForkLabStore = create<ForkLabState>((set, get) => ({
  forkedRepoIds: new Set<number>(),
  loaded: false,
  loading: false,
  load: async (force = false) => {
    if (get().loaded && !force) return;
    if (get().loading) return;
    set({ loading: true });
    try {
      const { projects } = await forkLabApi.listProjects();
      set({ forkedRepoIds: new Set(projects.map((p) => p.repo_id)), loaded: true });
    } catch {
      // 后端未就绪时静默，保留已有状态
    } finally {
      set({ loading: false });
    }
  },
  markAdded: (repoId) => set((state) => ({ forkedRepoIds: new Set([...state.forkedRepoIds, repoId]) })),
  markRemoved: (repoId) => set((state) => {
    const next = new Set(state.forkedRepoIds);
    next.delete(repoId);
    return { forkedRepoIds: next };
  }),
}));
