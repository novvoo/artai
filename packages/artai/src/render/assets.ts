/**
 * assets.ts — sync registry for decoded image assets.
 *
 * p5.brush can only paint natural media (watercolor, hatch, flow fields);
 * realism has to come from REAL pixels, and the architecture's designated
 * channel is the `photoFragment` op driven through an image-brush-style
 * stamp (architecture §10: "bitmap becomes a stamped tip texture").
 *
 * Decoding is async (Image/ImageBitmap) but the overlay pass is sync and
 * deterministic, so decoded bitmaps are registered here BEFORE renderPoster
 * and looked up by id during the fold. Core never touches this module —
 * the SceneIR only carries the asset id string.
 */
export type DecodedAsset = HTMLImageElement | HTMLCanvasElement | ImageBitmap;

const registry = new Map<string, DecodedAsset>();

export function registerAsset(id: string, asset: DecodedAsset): void {
  registry.set(id, asset);
}

export function getAsset(id: string): DecodedAsset | undefined {
  return registry.get(id);
}

export function hasAsset(id: string): boolean {
  return registry.has(id);
}

export function clearAssets(): void {
  registry.clear();
}

/** source pixel size of a registered asset, [0,0] when unknown */
export function assetSize(asset: DecodedAsset): [number, number] {
  if (typeof HTMLImageElement !== "undefined" && asset instanceof HTMLImageElement)
    return [asset.naturalWidth || asset.width, asset.naturalHeight || asset.height];
  const w = (asset as { width?: number }).width;
  const h = (asset as { height?: number }).height;
  return [w ?? 0, h ?? 0];
}
