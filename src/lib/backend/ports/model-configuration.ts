import type { ExecutionBinding } from "./execution-target";
import type { PiConfigurationPort } from "./pi-configuration";
import type { CustomModelDef, CustomProvider, ModelsJson } from "../../pi/models";
import type { SettingsScope } from "../../pi/settings";

export type EditableModel = Pick<CustomModelDef,
  "id" | "name" | "reasoning" | "thinkingLevelMap" | "input" | "contextWindow" | "maxTokens">;
export type ModelFields = { [K in Exclude<keyof EditableModel, "id">]?: EditableModel[K] | null };
export type ModelConfigurationChange =
  | { kind: "provider.remove"; providerId: string }
  | { kind: "provider.edit"; providerId: string; baseUrl: string | null; api: string | null }
  | { kind: "model.remove"; providerId: string; modelId: string }
  | { kind: "model.edit"; providerId: string; modelId: string; fields: ModelFields }
  | { kind: "model.capabilities"; providerId: string; modelId: string;
      fields: Pick<ModelFields, "reasoning" | "thinkingLevelMap"> };

/** Never includes apiKey, OAuth, headers, commands, environment or raw config. */
export interface RemoteModelSnapshot {
  scope: SettingsScope;
  stateToken: string;
  data: { providers: Record<string, Pick<CustomProvider, "baseUrl" | "api" | "models" | "modelOverrides"> & {
    /** Keeps hidden remote fields alive when the last visible model is removed. */
    remoteManaged: true;
  }> };
  enabledModels: { global: string[] | null; project: string[] | null };
}
export interface RemoteModelConfigurationPort {
  read(scope: SettingsScope): Promise<RemoteModelSnapshot>;
  mutate(scope: SettingsScope, expectedState: string, changes: ModelConfigurationChange[]): Promise<RemoteModelSnapshot>;
  setEnabled(scope: SettingsScope, expectedState: string, enabledModels: string[] | null): Promise<RemoteModelSnapshot>;
  fetchModels(scope: SettingsScope, providerId: string): Promise<string[]>;
}
export type ModelConfigurationTarget =
  | { kind: "local"; port: PiConfigurationPort }
  | { kind: "ssh"; port: RemoteModelConfigurationPort };
export type ModelConfigurationPortFactory = (binding: ExecutionBinding) => ModelConfigurationTarget;

const MODEL_FIELDS = ["name", "reasoning", "thinkingLevelMap", "input", "contextWindow", "maxTokens"] as const;
function modelFields(model: Partial<EditableModel>): ModelFields {
  return Object.fromEntries(MODEL_FIELDS.map((key) => [key, model[key] ?? null])) as ModelFields;
}

/** Diff only editable fields; the remote host merges these into its own config. */
export function remoteModelChanges(before: ModelsJson, after: ModelsJson): ModelConfigurationChange[] {
  const changes: ModelConfigurationChange[] = [];
  for (const id of Object.keys(before.providers)) {
    if (!Object.hasOwn(after.providers, id)) changes.push({ kind: "provider.remove", providerId: id });
  }
  for (const [providerId, provider] of Object.entries(after.providers)) {
    const old = before.providers[providerId];
    if (!old || old.baseUrl !== provider.baseUrl || old.api !== provider.api) {
      changes.push({ kind: "provider.edit", providerId, baseUrl: provider.baseUrl || null, api: provider.api || null });
    }
    const oldModels = new Map((old?.models ?? []).map((model) => [model.id, model]));
    const nextModels = new Map((provider.models ?? []).map((model) => [model.id, model]));
    for (const modelId of oldModels.keys()) {
      if (!nextModels.has(modelId)) changes.push({ kind: "model.remove", providerId, modelId });
    }
    for (const [modelId, model] of nextModels) {
      const fields = modelFields(model);
      if (!oldModels.has(modelId) || JSON.stringify(fields) !== JSON.stringify(modelFields(oldModels.get(modelId)!))) {
        changes.push({ kind: "model.edit", providerId, modelId, fields });
      }
    }
    const overrides = provider.modelOverrides ?? {};
    const oldOverrides = old?.modelOverrides ?? {};
    for (const modelId of new Set([...Object.keys(overrides), ...Object.keys(oldOverrides)])) {
      const fields = { reasoning: overrides[modelId]?.reasoning ?? null,
        thinkingLevelMap: overrides[modelId]?.thinkingLevelMap ?? null };
      if (JSON.stringify(fields) !== JSON.stringify({ reasoning: oldOverrides[modelId]?.reasoning ?? null,
        thinkingLevelMap: oldOverrides[modelId]?.thinkingLevelMap ?? null })) {
        changes.push({ kind: "model.capabilities", providerId, modelId, fields });
      }
    }
  }
  return changes;
}
