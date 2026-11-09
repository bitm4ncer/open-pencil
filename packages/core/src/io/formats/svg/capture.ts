/**
 * An SVG a web capture kept beside its raster fallback: the source markup, the box the page drew
 * it in, in page pixels, and a name for the layer it becomes.
 */
export interface CapturedSVG {
  svg: string
  x: number
  y: number
  width: number
  height: number
  name?: string
}
