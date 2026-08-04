import { convertFileSrc } from "@tauri-apps/api/core";
import type { AssetUrlPort } from "../ports/asset-url";

export const desktopAssetUrlPort = {
  convertFileSrc,
} satisfies AssetUrlPort;
