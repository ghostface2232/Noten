export const HOVER_SAFE_ZONE_PX = 16;

export function isPointInExpandedRect(
  x: number,
  y: number,
  rect: DOMRect,
  expandBy: number,
): boolean {
  return (
    x >= rect.left - expandBy
    && x <= rect.right + expandBy
    && y >= rect.top - expandBy
    && y <= rect.bottom + expandBy
  );
}
