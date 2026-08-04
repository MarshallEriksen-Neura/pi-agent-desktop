import type { RuntimeConfig } from "../../pi/runtime";
import type {
  RuntimeConfigPort,
  WslValidationInput,
  WslValidationResult,
} from "../ports/runtime-config";

const DEFAULT_CONFIG: RuntimeConfig = { mode: "native", distro: "" };

export class MockRuntimeConfigPort implements RuntimeConfigPort {
  private config: RuntimeConfig = DEFAULT_CONFIG;

  async read(): Promise<RuntimeConfig> {
    return this.config;
  }

  async write(config: RuntimeConfig): Promise<void> {
    this.config = config;
  }

  async listWslDistros(): Promise<string[]> {
    return [];
  }

  async validateWsl(input: WslValidationInput): Promise<WslValidationResult> {
    return input.config.mode === "wsl"
      ? { ok: false, error: `WSL is unavailable in browser preview: ${input.config.distro}` }
      : { ok: true };
  }

  async getWslBridgePath(): Promise<string> {
    return "";
  }
}

export function createMockRuntimeConfigPort(): RuntimeConfigPort {
  return new MockRuntimeConfigPort();
}
