import { describe, expect, it } from "vitest";
import type { RemoteModelDto } from "@pi/remote-control-contracts";
import { selectableModels } from "@/stores/models-store";

function model(overrides: Partial<RemoteModelDto>): RemoteModelDto {
  return {
    ref: "openai/gpt-4.1",
    provider: "openai",
    modelId: "gpt-4.1",
    reasoning: false,
    inputKinds: ["text"],
    available: true,
    remoteAllowed: true,
    isDefault: false,
    ...overrides,
  };
}

describe("selectableModels", () => {
  it("keeps only available and remote-allowed models", () => {
    const models = [
      model({ ref: "a/m1" }),
      model({ ref: "a/m2", available: false }),
      model({ ref: "a/m3", remoteAllowed: false }),
      model({ ref: "a/m4", available: false, remoteAllowed: false }),
    ];
    expect(selectableModels(models).map((m) => m.ref)).toEqual(["a/m1"]);
  });

  it("returns an empty list when nothing is selectable", () => {
    expect(selectableModels([])).toEqual([]);
    expect(
      selectableModels([model({ remoteAllowed: false }), model({ available: false })]),
    ).toEqual([]);
  });
});
