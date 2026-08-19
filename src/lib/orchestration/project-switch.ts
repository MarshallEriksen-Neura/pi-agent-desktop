import type { ProjectCatalogPort, WorkspaceFsPort } from "../backend/ports";
import type { FsEntry } from "../workspace";
import { useSessions, flushActiveSession, peekLatestSessionPath } from "../pi/sessions";
import { disposeAllPiClients } from "../pi/client";

export interface ProjectSwitchInput {
  path: string;
  currentRoot: string | null;
  projectCatalog: ProjectCatalogPort;
  workspaceFs: WorkspaceFsPort;
  setActiveFile: (path: string) => void;
  loadRecents: () => Promise<void>;
  applyProjectRoot: (root: string, topEntries: FsEntry[]) => void;
}

export interface ProjectSwitchServices {
  flushOutgoingSession(): Promise<void>;
  latestSessionPath(root: string): Promise<string>;
  /** Tear down every old-project pi process before the scope swaps. */
  restartPi(root: string, resumePath?: string): Promise<boolean>;
  switchSessionProject(root: string): Promise<void>;
}

const defaultServices: ProjectSwitchServices = {
  flushOutgoingSession: flushActiveSession,
  latestSessionPath: peekLatestSessionPath,
  // Every process belongs to the outgoing project's cwd — stop them all.
  // switchProject() then spawns the new project's active session fresh.
  restartPi: async () => {
    disposeAllPiClients();
    return true;
  },
  switchSessionProject: (root) => useSessions.getState().switchProject(root),
};

export async function switchWorkspaceProject(
  input: ProjectSwitchInput,
  services: ProjectSwitchServices = defaultServices,
): Promise<void> {
  await services.flushOutgoingSession();
  const root = await input.projectCatalog.resolve(input.path);
  if (root === input.currentRoot) return;

  const top = await input.workspaceFs.listDir(root);
  const previousResumePath = input.currentRoot
    ? await services.latestSessionPath(input.currentRoot)
    : "";
  const resumePath = await services.latestSessionPath(root);
  const restarted = await services.restartPi(root, resumePath || undefined);
  if (!restarted) {
    await restorePreviousProject(input.currentRoot, previousResumePath, services);
    return;
  }

  try {
    await services.switchSessionProject(root);
    await input.projectCatalog.commit(root);
  } catch (error) {
    await restorePreviousProject(input.currentRoot, previousResumePath, services);
    throw error;
  }

  // React state is the final commit after Pi, session scope, and durable
  // desktop metadata all agree on the new project.
  input.applyProjectRoot(root, top);
  input.setActiveFile("");
  await input.loadRecents();
}

async function restorePreviousProject(
  root: string | null,
  resumePath: string,
  services: ProjectSwitchServices,
): Promise<void> {
  if (!root) return;
  const restored = await services.restartPi(root, resumePath || undefined);
  if (restored) await services.switchSessionProject(root);
}
