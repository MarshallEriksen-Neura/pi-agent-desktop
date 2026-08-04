import type { ProjectCatalogPort, WorkspaceFsPort } from "../backend/ports";
import type { FsEntry } from "../workspace";
import { useSessions, flushActiveSession, peekLatestSessionPath } from "../pi/sessions";
import { restartPiForProjectSwitch } from "./session-lifecycle";

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
  restartPi(root: string, resumePath?: string): Promise<boolean>;
  switchSessionProject(root: string): Promise<void>;
}

const defaultServices: ProjectSwitchServices = {
  flushOutgoingSession: flushActiveSession,
  latestSessionPath: peekLatestSessionPath,
  restartPi: restartPiForProjectSwitch,
  switchSessionProject: (root) =>
    useSessions.getState().switchProject(root, { processAlreadyResumed: true }),
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
