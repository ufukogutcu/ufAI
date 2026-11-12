export function canRefractGlass(userAgent: string, reducedTransparency: boolean, increasedContrast: boolean) {
  return /(?:Chrome|Chromium|Edg)\//.test(userAgent) && !reducedTransparency && !increasedContrast;
}

/** Nonvisual RG channels encode displacement vectors, not theme colors. */
export function createGlassMap(width: number, height: number, radius: number) {
  const w = Math.max(1, Number.isFinite(width) ? width : 1);
  const h = Math.max(1, Number.isFinite(height) ? height : 1);
  const ratio = Math.min(1, 512 / Math.max(w, h));
  const mapWidth = Math.max(1, Math.round(w * ratio));
  const mapHeight = Math.max(1, Math.round(h * ratio));
  const r = Math.max(0, Math.min(Number.isFinite(radius) ? radius : 0, w / 2, h / 2));
  const band = Math.min(14, Math.min(w, h) / 3);
  const data = new Uint8ClampedArray(mapWidth * mapHeight * 4);
  for (let y = 0; y < mapHeight; y += 1) {
    for (let x = 0; x < mapWidth; x += 1) {
      const px = ((x + 0.5) / mapWidth - 0.5) * w;
      const py = ((y + 0.5) / mapHeight - 0.5) * h;
      const qx = Math.abs(px) - (w / 2 - r);
      const qy = Math.abs(py) - (h / 2 - r);
      const dx = Math.max(qx, 0);
      const dy = Math.max(qy, 0);
      const length = Math.hypot(dx, dy);
      const distance = length + Math.min(Math.max(qx, qy), 0) - r;
      const bend = distance < 0 && distance > -band
        ? Math.sin((-distance / band) * Math.PI)
        : 0;
      const nx = length > 0 ? dx / length : qx > qy ? 1 : 0;
      const ny = length > 0 ? dy / length : qx > qy ? 0 : 1;
      const offset = (y * mapWidth + x) * 4;
      data[offset] = 128 - Math.sign(px) * nx * bend * 112;
      data[offset + 1] = 128 - Math.sign(py) * ny * bend * 112;
      data[offset + 2] = 128;
      data[offset + 3] = 255;
    }
  }
  return { width: mapWidth, height: mapHeight, data };
}
