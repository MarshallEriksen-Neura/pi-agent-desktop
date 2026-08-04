import type { UpdateInfo } from "../../update";

export interface UpdaterPort {
  getCurrentVersion(): Promise<string>;
  check(): Promise<UpdateInfo>;
  downloadAndInstall(): Promise<void>;
  relaunch(): Promise<void>;
}
