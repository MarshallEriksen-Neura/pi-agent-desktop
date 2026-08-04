import type {
  RuntimeConfigPort,
  WslValidationInput,
  WslValidationResult,
} from "../ports/runtime-config";
import { desktopInvoke } from "./invoke";
import type { RuntimeConfig } from "../../pi/runtime";

export class DesktopRuntimeConfigPort implements RuntimeConfigPort {
  read(): Promise<RuntimeConfig> {
    return desktopInvoke<RuntimeConfig>("runtime_config_read");
  }

  write(config: RuntimeConfig): Promise<void> {
    return desktopInvoke("runtime_config_write", { config });
  }

  listWslDistros(): Promise<string[]> {
    return desktopInvoke<string[]>("wsl_list_distros");
  }

  async validateWsl(input: WslValidationInput): Promise<WslValidationResult> {
    try {
      await desktopInvoke("wsl_runtime_validate", {
        config: input.config,
        cwd: input.cwd ?? null,
      });
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  getWslBridgePath(): Promise<string> {
    return desktopInvoke<string>("wsl_shell_bridge_path");
  }
}

export function createDesktopRuntimeConfigPort(): RuntimeConfigPort {
  return new DesktopRuntimeConfigPort();
}
