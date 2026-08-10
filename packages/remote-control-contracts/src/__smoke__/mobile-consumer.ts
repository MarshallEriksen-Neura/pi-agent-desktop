import type {
  RemoteProjectSummary,
  RemoteTaskCreateRequest,
  RemoteTaskSnapshot,
} from "../index";

export function buildMobileTask(project: RemoteProjectSummary): RemoteTaskCreateRequest {
  return {
    requestId: "mobile-request",
    projectId: project.projectId,
    prompt: "Inspect the selected project.",
    contextFiles: [],
  };
}

export function acceptMobileSnapshot(snapshot: RemoteTaskSnapshot): string {
  return `${snapshot.taskId}:${snapshot.state}`;
}
