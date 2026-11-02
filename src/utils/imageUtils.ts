export function bytesToDataUrl(bytes: Uint8Array, mimeType: string): string {
  const chunkSize = 8192;
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i += chunkSize) {
    parts.push(String.fromCharCode(...bytes.subarray(i, i + chunkSize)));
  }
  return `data:${mimeType};base64,${btoa(parts.join(""))}`;
}

export function dataUrlToUint8Array(dataUrl: string): Uint8Array<ArrayBuffer> {
  const base64 = dataUrl.split(",")[1];
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function mimeFromExt(ext: string): string {
  const map: Record<string, string> = {
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
    gif: "image/gif", webp: "image/webp", svg: "image/svg+xml",
  };
  return map[ext.toLowerCase()] ?? "image/png";
}

export function mimeToExt(dataUrl: string): string {
  const match = dataUrl.match(/^data:image\/(\w+)/);
  const mime = match?.[1] ?? "png";
  return mime === "jpeg" ? "jpg" : mime;
}

export function mimeFromDataUrl(dataUrl: string): string {
  return dataUrl.split(",")[0].split(":")[1].split(";")[0];
}

export function clampImageDimensions(
  natW: number,
  natH: number,
  maxWidth: number,
): { width: number; height: number } {
  const width = natW > maxWidth ? maxWidth : natW;
  const height = natW > maxWidth ? Math.round(natH * (maxWidth / natW)) : natH;
  return { width, height };
}
