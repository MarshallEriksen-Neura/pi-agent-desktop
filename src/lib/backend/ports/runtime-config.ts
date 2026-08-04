import type { RuntimeConfig } from "../../pi/runtime";

export interface WslValidationInput {
  config: RuntimeConfig;
  cwd?: string | null;
}

export interface WslValidationResult {
  ok: boolean;
  error?: string;
}

export interface RuntimeConfigPort {
  read(): Promise<RuntimeConfig>;
  write(config: RuntimeConfig): Promise<void>;
  listWslDistros(): Promise<string[]>;
  validateWsl(input: WslValidationInput): Promise<WslValidationResult>;
  getWslBridgePath(): Promise<string>;
}
