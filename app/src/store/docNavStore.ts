import { create } from 'zustand';

export interface DocCrumb {
  label: string;
  href?: string;
}

interface DocNavStore {
  crumbs: DocCrumb[];
  setCrumbs: (crumbs: DocCrumb[]) => void;
  // Registered by DocumentationPage so sidebar crumbs can drive iframe navigation
  navigate: ((href: string) => void) | null;
  setNavigate: (fn: ((href: string) => void) | null) => void;
}

export const useDocNav = create<DocNavStore>((set) => ({
  crumbs: [],
  setCrumbs: (crumbs) => set({ crumbs }),
  navigate: null,
  setNavigate: (fn) => set({ navigate: fn }),
}));
