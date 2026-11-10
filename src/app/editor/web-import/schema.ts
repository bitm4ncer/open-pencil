import * as v from 'valibot'

/** An SVG a remote capture kept beside its raster fallback. */
export const capturedSVGSchema = v.object({
  svg: v.string(),
  x: v.number(),
  y: v.number(),
  width: v.pipe(v.number(), v.minValue(0)),
  height: v.pipe(v.number(), v.minValue(0)),
  name: v.optional(v.string())
})
