# Image Processing

The `image_process` tool performs workspace image operations with Sharp. Requires Piclaw `>=1.8.0`.

## Install

Open **Settings → Add-Ons** and install **image-processing** from the catalog. Sharp is bundled as the add-on's runtime dependency.

## Tool

`image_process` accepts an `action`, input path, and action-specific options. Supported operations include:

- geometry: resize, crop, rotate, flip, trim, extend, affine, tile
- formats: `convert`, `optimize`, `svg_render`, `frames`, `spritesheet_to_gif`
- colour: `greyscale`, `modulate`, `contrast`, `gamma`, `tint`, `normalize`, `negate`, `threshold`, `clahe`
- filters: `blur`, `sharpen`, `median`
- channels and composition: `extract_channel`, `remove_alpha`, `unflatten`, `composite`, `text`
- inspection: `metadata` and `info`

Relative paths are resolved against the workspace; absolute paths are also accepted. Set `preserve_transparency=false` to flatten transparent pixels onto white. The tool refuses to overwrite its input unless `overwrite` is true and otherwise derives a suffixed output path.

## Formats

Output formats: PNG, JPEG, WebP, AVIF, TIFF, and GIF. Animated GIF/WebP processing preserves frames by default. GIF delay accepts one value or a per-frame array.

## Result

The tool returns a text summary and structured output details.
