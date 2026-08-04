import type { AssetUrlPort } from "../ports/asset-url";

export const mockAssetUrlPort = {
  convertFileSrc: (path) => path,
} satisfies AssetUrlPort;
