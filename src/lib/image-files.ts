/** Image detection for the editor — these open in the ImageViewer, not CodeMirror. */

const IMAGE_EXTS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "bmp",
  "ico",
  "svg",
  "avif",
]);

/* extensions whose MIME type isn't simply `image/<ext>` */
const MIME_OVERRIDES: Record<string, string> = {
  svg: "image/svg+xml",
  ico: "image/x-icon",
  jpg: "image/jpeg",
};

function ext(path: string): string {
  const dot = path.lastIndexOf(".");
  return dot === -1 ? "" : path.slice(dot + 1).toLowerCase();
}

export function isImageFile(path: string): boolean {
  return IMAGE_EXTS.has(ext(path));
}

export function imageMime(path: string): string {
  const e = ext(path);
  return MIME_OVERRIDES[e] ?? `image/${e}`;
}
