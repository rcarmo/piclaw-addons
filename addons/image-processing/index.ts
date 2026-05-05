import { Type, type Static } from "typebox";
import type {
  AgentToolUpdateCallback,
  ExtensionAPI,
  ExtensionFactory,
} from "@mariozechner/pi-coding-agent";
import { existsSync, statSync } from "node:fs";
import { resolve, basename, extname, dirname, join, relative } from "node:path";

// Inline helper: replaces src/utils/path-safety.ts stripBaseDirForDisplay
function stripBaseDirForDisplay(baseDir: string, absolutePath: string): string {
  if (!absolutePath.startsWith(baseDir)) return absolutePath;
  const rel = relative(baseDir, absolutePath);
  return rel.replace(/\\/g, "/");
}

import { Type, type Static } from "typebox";
import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionFactory,
} from "@mariozechner/pi-coding-agent";
import { existsSync, statSync } from "node:fs";
import { resolve, basename, extname, dirname, join } from "node:path";


const SUPPORTED_OUTPUT_FORMATS = ["png", "jpeg", "webp", "avif", "tiff", "gif"] as const;
type OutputFormat = typeof SUPPORTED_OUTPUT_FORMATS[number];

const FORMAT_MIME: Record<OutputFormat, string> = {
  png: "image/png",
  jpeg: "image/jpeg",
  webp: "image/webp",
  avif: "image/avif",
  tiff: "image/tiff",
  gif: "image/gif",
};

const FORMAT_EXT: Record<OutputFormat, string> = {
  png: ".png",
  jpeg: ".jpg",
  webp: ".webp",
  avif: ".avif",
  tiff: ".tiff",
  gif: ".gif",
};

// Formats that support transparency
const TRANSPARENCY_FORMATS = new Set<OutputFormat>(["png", "webp", "avif", "tiff", "gif"]);

const ImageProcessSchema = Type.Object({
  action: Type.String({
    description: "Operation: resize | crop | convert | optimize | trim | rotate | flip | blur | sharpen | composite | " +
      "greyscale | modulate | contrast | gamma | tint | normalize | negate | clahe | threshold | median | " +
      "extend | extract_channel | remove_alpha | unflatten | text | svg_render | affine | tile | metadata | " +
      "frames | spritesheet_to_gif | info",
  }),
  input: Type.String({ description: "Input file path (relative to workspace or absolute)." }),
  output: Type.Optional(Type.String({ description: "Output file path. Default: auto-generated next to input." })),
  format: Type.Optional(Type.String({ description: "Output format: png, jpeg, webp, avif, tiff, gif. Default: inferred from output path or input format." })),
  quality: Type.Optional(Type.Integer({ description: "Output quality 1-100. Default: 80 for lossy formats, ignored for PNG.", minimum: 1, maximum: 100 })),
  width: Type.Optional(Type.Integer({ description: "Target width in pixels (for resize/crop).", minimum: 1, maximum: 16384 })),
  height: Type.Optional(Type.Integer({ description: "Target height in pixels (for resize/crop).", minimum: 1, maximum: 16384 })),
  fit: Type.Optional(Type.String({ description: "Resize fit: cover | contain | fill | inside | outside. Default: inside." })),
  left: Type.Optional(Type.Integer({ description: "Crop left offset in pixels.", minimum: 0 })),
  top: Type.Optional(Type.Integer({ description: "Crop top offset in pixels.", minimum: 0 })),
  angle: Type.Optional(Type.Integer({ description: "Rotation angle in degrees (for rotate). Multiples of 90 for lossless." })),
  sigma: Type.Optional(Type.Number({ description: "Blur sigma (for blur) or sharpen sigma (for sharpen). Default: 3 for blur, 1 for sharpen." })),
  overlay: Type.Optional(Type.String({ description: "Overlay image path (for composite)." })),
  gravity: Type.Optional(Type.String({ description: "Overlay gravity: center | north | south | east | west | northeast | northwest | southeast | southwest. Default: southeast." })),
  preserve_transparency: Type.Optional(Type.Boolean({ description: "Preserve transparency. Default: true. Set false to flatten to white background." })),
  overwrite: Type.Optional(Type.Boolean({ description: "Allow overwriting the input file. Default: false. When false, output auto-generates a suffixed filename next to the input." })),
  animated: Type.Optional(Type.Boolean({ description: "Preserve animation frames when processing animated GIFs/WebPs. Default: true for animated inputs." })),
  delay: Type.Optional(Type.Union([Type.Integer({ minimum: 10 }), Type.Array(Type.Integer({ minimum: 10 }))], { description: "Frame delay in ms for GIF output. Single value or per-frame array. Default: 100." })),
  loop: Type.Optional(Type.Integer({ description: "GIF loop count. 0 = infinite. Default: 0.", minimum: 0 })),
  frame_count: Type.Optional(Type.Integer({ description: "Number of frames to split from a spritesheet (for spritesheet_to_gif). Default: auto from width." , minimum: 1 })),
  direction: Type.Optional(Type.String({ description: "Spritesheet direction: horizontal (default) or vertical." })),
  brightness: Type.Optional(Type.Number({ description: "Brightness multiplier for modulate (1.0 = unchanged). Default: 1.0.", minimum: 0 })),
  saturation: Type.Optional(Type.Number({ description: "Saturation multiplier for modulate (1.0 = unchanged, 0 = greyscale). Default: 1.0.", minimum: 0 })),
  hue: Type.Optional(Type.Integer({ description: "Hue rotation in degrees for modulate." })),
  gamma: Type.Optional(Type.Number({ description: "Gamma correction value for gamma action. Default: 2.2.", minimum: 0.1, maximum: 10 })),
  contrast: Type.Optional(Type.Number({ description: "Linear contrast multiplier for contrast action (1.0 = unchanged). Default: 1.5.", minimum: 0 })),
  tint_color: Type.Optional(Type.String({ description: "Tint color as hex (#RRGGBB) for tint action." })),
  clahe_width: Type.Optional(Type.Integer({ description: "CLAHE tile width for auto-level. Default: 3.", minimum: 1 })),
  clahe_height: Type.Optional(Type.Integer({ description: "CLAHE tile height for auto-level. Default: 3.", minimum: 1 })),
  threshold_value: Type.Optional(Type.Integer({ description: "Threshold value 0-255 for threshold action. Default: 128.", minimum: 0, maximum: 255 })),
  median_size: Type.Optional(Type.Integer({ description: "Median filter kernel size (odd number). Default: 3.", minimum: 1 })),
  extend_top: Type.Optional(Type.Integer({ description: "Padding pixels to add at top (for extend). Default: 0.", minimum: 0 })),
  extend_bottom: Type.Optional(Type.Integer({ description: "Padding pixels to add at bottom (for extend). Default: 0.", minimum: 0 })),
  extend_left: Type.Optional(Type.Integer({ description: "Padding pixels to add at left (for extend). Default: 0.", minimum: 0 })),
  extend_right: Type.Optional(Type.Integer({ description: "Padding pixels to add at right (for extend). Default: 0.", minimum: 0 })),
  extend_background: Type.Optional(Type.String({ description: "Padding color as hex (#RRGGBB or #RRGGBBAA). Default: transparent." })),
  channel: Type.Optional(Type.Integer({ description: "Channel index to extract (0=red, 1=green, 2=blue, 3=alpha) for extract_channel.", minimum: 0, maximum: 3 })),
  text: Type.Optional(Type.String({ description: "Text content for text overlay (rendered via SVG)." })),
  text_color: Type.Optional(Type.String({ description: "Text color as hex. Default: #FFFFFF." })),
  text_size: Type.Optional(Type.Integer({ description: "Text font size in pixels. Default: 24.", minimum: 8, maximum: 200 })),
  density: Type.Optional(Type.Integer({ description: "DPI for SVG rasterization (svg_render). Default: 72.", minimum: 1, maximum: 1200 })),
  tile_size: Type.Optional(Type.Integer({ description: "Tile size for tile output. Default: 256.", minimum: 64, maximum: 2048 })),
  affine_matrix: Type.Optional(Type.Array(Type.Number(), { description: "Affine transform matrix [a,b,c,d] for affine action.", minItems: 4, maxItems: 4 })),
  strip_metadata: Type.Optional(Type.Boolean({ description: "Strip all metadata (EXIF/ICC/XMP) from output. Default: false." })),
});

type ImageProcessParams = Static<typeof ImageProcessSchema>;

function getWorkspaceDir(): string {
  const configured = process.env.PICLAW_WORKSPACE?.trim();
  return resolve(configured || process.cwd());
}

function resolveWorkspacePath(input: string): string {
  const trimmed = (input || "").trim();
  if (!trimmed) throw new Error("Empty file path.");
  return resolve(getWorkspaceDir(), trimmed);
}

function inferFormat(filePath: string): OutputFormat {
  const ext = extname(filePath).toLowerCase().replace(".", "");
  if (ext === "jpg") return "jpeg";
  if (SUPPORTED_OUTPUT_FORMATS.includes(ext as OutputFormat)) return ext as OutputFormat;
  return "png";
}

function buildOutputPath(inputPath: string, format: OutputFormat, suffix = "-processed"): string {
  const dir = dirname(inputPath);
  const base = basename(inputPath, extname(inputPath));
  return join(dir, `${base}${suffix}${FORMAT_EXT[format]}`);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

type ImageProcessUiContext = {
  hasUI?: boolean;
  ui?: {
    setWorkingIndicator: (options?: { frames?: string[]; intervalMs?: number }) => void;
    setWorkingMessage: (message?: string) => void;
  };
};

const IMAGE_PROCESS_WORKING_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function startImageProcessUiProgress(ctx: ImageProcessUiContext | undefined, message: string): void {
  if (!ctx?.hasUI || !ctx.ui) return;
  ctx.ui.setWorkingIndicator({ frames: IMAGE_PROCESS_WORKING_FRAMES, intervalMs: 90 });
  ctx.ui.setWorkingMessage(message);
}

function updateImageProcessUiProgress(ctx: ImageProcessUiContext | undefined, message: string): void {
  if (!ctx?.hasUI || !ctx.ui) return;
  ctx.ui.setWorkingMessage(message);
}

function finishImageProcessUiProgress(ctx: ImageProcessUiContext | undefined): void {
  if (!ctx?.hasUI || !ctx.ui) return;
  ctx.ui.setWorkingMessage(undefined);
  ctx.ui.setWorkingIndicator({ frames: [] });
}

function describeImageProcessAction(action: string, inputPath: string): string {
  const file = basename(inputPath);
  switch (action) {
    case "resize": return `Image: resizing ${file}…`;
    case "crop": return `Image: cropping ${file}…`;
    case "convert": return `Image: converting ${file}…`;
    case "optimize": return `Image: optimizing ${file}…`;
    case "trim": return `Image: trimming transparent edges from ${file}…`;
    case "rotate": return `Image: rotating ${file}…`;
    case "flip": return `Image: flipping ${file}…`;
    case "blur": return `Image: blurring ${file}…`;
    case "sharpen": return `Image: sharpening ${file}…`;
    case "composite": return `Image: compositing ${file}…`;
    case "svg_render": return `Image: rendering SVG ${file}…`;
    case "tile": return `Image: generating deep-zoom tiles for ${file}…`;
    case "frames": return `Image: extracting animation frames from ${file}…`;
    case "spritesheet_to_gif": return `Image: assembling animated GIF from ${file}…`;
    case "metadata": return `Image: inspecting metadata for ${file}…`;
    default: return `Image: processing ${file} (${action})…`;
  }
}

async function executeImageProcess(
  _toolCallId: string,
  params: ImageProcessParams,
  _signal?: AbortSignal,
  _update?: unknown,
  ctx?: ImageProcessUiContext,
): Promise<AgentToolResult<Record<string, unknown>>> {
  const sharp = (await import("sharp")).default;

  const action = (params.action || "").toLowerCase().trim();
  const inputPath = resolveWorkspacePath(params.input);
  const showUiProgress = action !== "info";
  if (showUiProgress) startImageProcessUiProgress(ctx, describeImageProcessAction(action, inputPath));

  try {
    if (!existsSync(inputPath)) {
      return {
        content: [{ type: "text", text: `File not found: ${params.input}` }],
        details: { error: "not_found", input: params.input },
      };
    }
    // Info action: return metadata without processing
    if (action === "info") {
      const meta = await sharp(inputPath).metadata();
      const stat = statSync(inputPath);
      const info = {
        width: meta.width,
        height: meta.height,
        format: meta.format,
        channels: meta.channels,
        hasAlpha: meta.hasAlpha,
        space: meta.space,
        density: meta.density,
        size: stat.size,
        sizeFormatted: formatBytes(stat.size),
      };
      return {
        content: [{ type: "text", text: `Image info for ${params.input}:\n${JSON.stringify(info, null, 2)}` }],
        details: { action: "info", input: params.input, ...info },
      };
    }

  // Determine output format and path
  const requestedFormat = params.format?.toLowerCase().trim();
  const outputFormat: OutputFormat = requestedFormat && SUPPORTED_OUTPUT_FORMATS.includes(requestedFormat as OutputFormat)
    ? requestedFormat as OutputFormat
    : params.output
      ? inferFormat(params.output)
      : inferFormat(inputPath);

  const outputPath = params.output
    ? resolveWorkspacePath(params.output)
    : buildOutputPath(inputPath, outputFormat,
        action === "optimize" ? "-optimized"
          : action === "trim" ? "-trimmed"
            : `-${action}`);

  // Safety: refuse to overwrite the input file unless explicitly allowed
  const overwrite = params.overwrite === true;
  if (resolve(outputPath) === resolve(inputPath) && !overwrite) {
    return {
      content: [{ type: "text", text: `Output path is the same as input. Set overwrite=true to replace the original, or use a different output path.` }],
      details: { error: "overwrite_refused", input: params.input, output: params.output },
    };
  }
  // Also refuse to overwrite any existing file unless overwrite is set or the path was auto-generated
  if (params.output && existsSync(outputPath) && !overwrite) {
    return {
      content: [{ type: "text", text: `Output file already exists: ${params.output}. Set overwrite=true to replace it.` }],
      details: { error: "output_exists", output: params.output },
    };
  }

  const preserveTransparency = params.preserve_transparency !== false;
  const quality = params.quality ?? 80;

  // Detect and preserve animation by default
  const inputMeta = action !== "info" ? await sharp(inputPath).metadata() : null;
  const isAnimated = (inputMeta?.pages ?? 1) > 1;
  const shouldAnimate = params.animated !== false && isAnimated;

  // Start the pipeline
  let pipeline = sharp(inputPath, shouldAnimate ? { animated: true } : undefined);

  // If converting to a format that doesn't support transparency, flatten
  if (!preserveTransparency || !TRANSPARENCY_FORMATS.has(outputFormat)) {
    pipeline = pipeline.flatten({ background: { r: 255, g: 255, b: 255 } });
  }

  switch (action) {
    case "resize": {
      if (!params.width && !params.height) {
        return {
          content: [{ type: "text", text: "Resize requires at least width or height." }],
          details: { error: "missing_dimensions" },
        };
      }
      const fit = (params.fit || "inside") as "cover" | "contain" | "fill" | "inside" | "outside";
      pipeline = pipeline.resize(params.width || null, params.height || null, {
        fit,
        withoutEnlargement: fit === "inside",
      });
      break;
    }

    case "crop": {
      if (!params.width || !params.height) {
        return {
          content: [{ type: "text", text: "Crop requires both width and height." }],
          details: { error: "missing_dimensions" },
        };
      }
      pipeline = pipeline.extract({
        left: params.left ?? 0,
        top: params.top ?? 0,
        width: params.width,
        height: params.height,
      });
      break;
    }

    case "convert":
    case "optimize":
      // Format conversion / optimization — just apply the output format settings below
      break;

    case "trim": {
      pipeline = pipeline.trim();
      break;
    }

    case "rotate": {
      const angle = params.angle ?? 90;
      pipeline = pipeline.rotate(angle);
      break;
    }

    case "flip": {
      pipeline = pipeline.flip().flop();
      break;
    }

    case "blur": {
      const sigma = params.sigma ?? 3;
      pipeline = pipeline.blur(sigma);
      break;
    }

    case "sharpen": {
      const sigma = params.sigma ?? 1;
      pipeline = pipeline.sharpen(sigma);
      break;
    }

    case "composite": {
      if (!params.overlay) {
        return {
          content: [{ type: "text", text: "Composite requires an overlay image path." }],
          details: { error: "missing_overlay" },
        };
      }
      const overlayPath = resolveWorkspacePath(params.overlay);
      if (!existsSync(overlayPath)) {
        return {
          content: [{ type: "text", text: `Overlay file not found: ${params.overlay}` }],
          details: { error: "overlay_not_found", overlay: params.overlay },
        };
      }
      const gravity = (params.gravity || "southeast") as
        "center" | "north" | "south" | "east" | "west" | "northeast" | "northwest" | "southeast" | "southwest";
      pipeline = pipeline.composite([{ input: overlayPath, gravity }]);
      break;
    }

    case "greyscale":
    case "grayscale": {
      pipeline = pipeline.greyscale();
      break;
    }

    case "modulate": {
      pipeline = pipeline.modulate({
        brightness: params.brightness ?? 1.0,
        saturation: params.saturation ?? 1.0,
        hue: params.hue ?? 0,
      });
      break;
    }

    case "contrast": {
      const multiplier = params.contrast ?? 1.5;
      const offset = 128 * (1 - multiplier);
      pipeline = pipeline.linear(multiplier, offset);
      break;
    }

    case "gamma": {
      const gammaValue = params.gamma ?? 2.2;
      pipeline = pipeline.gamma(gammaValue);
      break;
    }

    case "tint": {
      const hex = (params.tint_color || "#FF8800").replace("#", "");
      const r = parseInt(hex.slice(0, 2), 16) || 0;
      const g = parseInt(hex.slice(2, 4), 16) || 0;
      const b = parseInt(hex.slice(4, 6), 16) || 0;
      pipeline = pipeline.tint({ r, g, b });
      break;
    }

    case "normalize":
    case "normalise": {
      pipeline = pipeline.normalise();
      break;
    }

    case "negate": {
      pipeline = pipeline.negate();
      break;
    }

    case "clahe": {
      pipeline = pipeline.clahe({
        width: params.clahe_width ?? 3,
        height: params.clahe_height ?? 3,
      });
      break;
    }

    case "threshold": {
      pipeline = pipeline.threshold(params.threshold_value ?? 128);
      break;
    }

    case "median": {
      pipeline = pipeline.median(params.median_size ?? 3);
      break;
    }

    case "extend": {
      const bg = params.extend_background || "";
      const hexBg = bg.replace("#", "");
      const background = hexBg.length >= 6
        ? { r: parseInt(hexBg.slice(0,2),16), g: parseInt(hexBg.slice(2,4),16), b: parseInt(hexBg.slice(4,6),16), alpha: hexBg.length >= 8 ? parseInt(hexBg.slice(6,8),16)/255 : 1 }
        : { r: 0, g: 0, b: 0, alpha: 0 };
      pipeline = pipeline.extend({
        top: params.extend_top ?? 0,
        bottom: params.extend_bottom ?? 0,
        left: params.extend_left ?? 0,
        right: params.extend_right ?? 0,
        background,
      });
      break;
    }

    case "extract_channel": {
      const channelIndex = (params.channel ?? 0) as 0 | 1 | 2 | 3;
      pipeline = pipeline.extractChannel(channelIndex);
      break;
    }

    case "remove_alpha": {
      pipeline = pipeline.removeAlpha();
      break;
    }

    case "unflatten": {
      pipeline = pipeline.unflatten();
      break;
    }

    case "text": {
      if (!params.text) {
        return {
          content: [{ type: "text", text: "Text overlay requires the text parameter." }],
          details: { error: "missing_text" },
        };
      }
      const textColor = params.text_color || "#FFFFFF";
      const fontSize = params.text_size ?? 24;
      const svgText = `<svg xmlns="http://www.w3.org/2000/svg"><text x="10" y="${fontSize}" font-family="sans-serif" font-size="${fontSize}" fill="${textColor}">${params.text.replace(/&/g,"\&amp;").replace(/</g,"\&lt;").replace(/>/g,"\&gt;")}</text></svg>`;
      const textBuf = await sharp(Buffer.from(svgText)).png().toBuffer();
      pipeline = pipeline.composite([{ input: textBuf, gravity: params.gravity || "southeast" }]);
      break;
    }

    case "svg_render": {
      updateImageProcessUiProgress(ctx, `Image: rasterizing SVG ${basename(inputPath)}…`);
      const density = params.density ?? 72;
      pipeline = sharp(inputPath, { density });
      if (!preserveTransparency || !TRANSPARENCY_FORMATS.has(outputFormat)) {
        pipeline = pipeline.flatten({ background: { r: 255, g: 255, b: 255 } });
      }
      if (params.width || params.height) {
        pipeline = pipeline.resize(params.width || null, params.height || null, { fit: "inside", withoutEnlargement: false });
      }
      break;
    }

    case "affine": {
      if (!params.affine_matrix || params.affine_matrix.length !== 4) {
        return {
          content: [{ type: "text", text: "Affine requires affine_matrix with 4 numbers [a,b,c,d]." }],
          details: { error: "missing_matrix" },
        };
      }
      const [a, b, c, d] = params.affine_matrix;
      pipeline = pipeline.affine([a, b, c, d], { background: { r: 0, g: 0, b: 0, alpha: 0 } });
      break;
    }

    case "tile": {
      updateImageProcessUiProgress(ctx, `Image: generating deep-zoom tiles for ${basename(inputPath)}…`);
      const tileSize = params.tile_size ?? 256;
      const tilePath = params.output
        ? resolveWorkspacePath(params.output)
        : buildOutputPath(inputPath, "png", "-tiles");
      const { mkdirSync: mkFs } = await import("node:fs");
      mkFs(tilePath, { recursive: true });
      await sharp(inputPath).tile({ size: tileSize, layout: "dz" }).toFile(join(tilePath, "output"));
      const workspaceDir = getWorkspaceDir();
      const relTile = stripBaseDirForDisplay(workspaceDir, tilePath);
      return {
        content: [{ type: "text", text: `Deep zoom tiles generated in ${relTile}/ (tile size: ${tileSize}px)` }],
        details: { action: "tile", input: params.input, outputDir: relTile, tileSize },
      };
    }

    case "metadata": {
      updateImageProcessUiProgress(ctx, `Image: reading metadata for ${basename(inputPath)}…`);
      const meta = await sharp(inputPath).metadata();
      const metaInfo = {
        width: meta.width, height: meta.height, format: meta.format,
        channels: meta.channels, hasAlpha: meta.hasAlpha, space: meta.space,
        density: meta.density, chromaSubsampling: meta.chromaSubsampling,
        isProgressive: meta.isProgressive, pages: meta.pages,
        hasProfile: meta.hasProfile, icc: meta.icc ? `ICC profile (${meta.icc.length} bytes)` : null,
        exif: meta.exif ? `EXIF data (${meta.exif.length} bytes)` : null,
        xmp: meta.xmp ? `XMP data (${meta.xmp.length} bytes)` : null,
      };
      return {
        content: [{ type: "text", text: `Metadata for ${params.input}:\n${JSON.stringify(metaInfo, null, 2)}` }],
        details: { action: "metadata", input: params.input, ...metaInfo },
      };
    }

    case "frames": {
      updateImageProcessUiProgress(ctx, `Image: extracting animation frames from ${basename(inputPath)}…`);
      // Extract individual frames from an animated GIF/WebP
      const meta = await sharp(inputPath, { animated: true }).metadata();
      const pageCount = meta.pages ?? 1;
      if (pageCount <= 1) {
        return {
          content: [{ type: "text", text: `${params.input} has only 1 frame — nothing to extract.` }],
          details: { action: "frames", input: params.input, pages: 1 },
        };
      }
      const frameDir = params.output ? resolveWorkspacePath(params.output) : buildOutputPath(inputPath, "png", "-frames");
      const { mkdirSync: mkdirSyncFs } = await import("node:fs");
      mkdirSyncFs(frameDir, { recursive: true });
      const extracted: string[] = [];
      for (let i = 0; i < pageCount; i++) {
        const framePath = join(frameDir, `frame-${String(i).padStart(4, "0")}.png`);
        await sharp(inputPath, { animated: true, page: i }).png().toFile(framePath);
        extracted.push(framePath);
      }
      const workspaceDir = getWorkspaceDir();
      const relDir = stripBaseDirForDisplay(workspaceDir, frameDir);
      return {
        content: [{ type: "text", text: `Extracted ${extracted.length} frames to ${relDir}/` }],
        details: { action: "frames", input: params.input, frameCount: extracted.length, outputDir: relDir },
      };
    }

    case "spritesheet_to_gif": {
      updateImageProcessUiProgress(ctx, `Image: assembling animated GIF from ${basename(inputPath)}…`);
      // Assemble a horizontal/vertical spritesheet into an animated GIF
      const meta = await sharp(inputPath).metadata();
      const imgWidth = meta.width ?? 0;
      const imgHeight = meta.height ?? 0;
      const direction = (params.direction || "horizontal").toLowerCase();

      let frameW: number, frameH: number, frameCount: number;
      if (direction === "vertical") {
        frameW = imgWidth;
        frameCount = params.frame_count ?? (params.height ? Math.floor(imgHeight / params.height) : 1);
        frameH = params.height ?? Math.floor(imgHeight / frameCount);
      } else {
        frameH = imgHeight;
        frameCount = params.frame_count ?? (params.width ? Math.floor(imgWidth / params.width) : 1);
        frameW = params.width ?? Math.floor(imgWidth / frameCount);
      }

      if (frameCount < 2) {
        return {
          content: [{ type: "text", text: `Could not split spritesheet into multiple frames. Provide frame_count or frame width/height.` }],
          details: { error: "insufficient_frames", width: imgWidth, height: imgHeight, direction },
        };
      }

      const delay = typeof params.delay === "number" ? params.delay
        : Array.isArray(params.delay) ? params.delay[0] ?? 100
        : 100;
      const perFrameDelay = Array.isArray(params.delay) ? params.delay : Array(frameCount).fill(delay);
      const loopCount = params.loop ?? 0;

      // Extract frames using sharp, then assemble with gifenc
      const { GIFEncoder, quantize, applyPalette } = await import("gifenc");
      const gif = GIFEncoder();

      for (let i = 0; i < frameCount; i++) {
        const left = direction === "horizontal" ? i * frameW : 0;
        const top = direction === "vertical" ? i * frameH : 0;
        const frameRaw = await sharp(inputPath)
          .extract({ left, top, width: frameW, height: frameH })
          .ensureAlpha()
          .raw()
          .toBuffer();
        const rgba = new Uint8Array(frameRaw);
        const palette = quantize(rgba, 256, { format: "rgba4444" });
        const indexed = applyPalette(rgba, palette, "rgba4444");
        gif.writeFrame(indexed, frameW, frameH, {
          palette,
          delay: perFrameDelay[i] ?? delay,
          repeat: i === 0 ? loopCount : undefined,
        });
      }
      gif.finish();

      const gifOutputPath = params.output
        ? resolveWorkspacePath(params.output)
        : buildOutputPath(inputPath, "gif", "-animated");

      // Overwrite check
      const canOverwrite = params.overwrite === true;
      if (params.output && existsSync(gifOutputPath) && !canOverwrite) {
        return {
          content: [{ type: "text", text: `Output file already exists: ${params.output}. Set overwrite=true to replace it.` }],
          details: { error: "output_exists", output: params.output },
        };
      }

      const { writeFileSync: writeFs } = await import("node:fs");
      writeFs(gifOutputPath, Buffer.from(gif.bytes()));

      const gifStat = statSync(gifOutputPath);
      const workspaceDir = getWorkspaceDir();
      const relOutput = stripBaseDirForDisplay(workspaceDir, gifOutputPath);
      return {
        content: [{ type: "text", text: `Animated GIF created: ${relOutput} (${frameW}x${frameH}, ${frameCount} frames, ${formatBytes(gifStat.size)})` }],
        details: {
          action: "spritesheet_to_gif",
          input: params.input,
          output: relOutput,
          format: "gif",
          width: frameW,
          height: frameH,
          frameCount,
          delay: perFrameDelay.slice(0, frameCount),
          loop: loopCount,
          size: gifStat.size,
          mimeType: "image/gif",
        },
      };
    }

    default:
      return {
        content: [{ type: "text", text: `Unknown action: ${action}. Use: resize, crop, convert, optimize, trim, rotate, flip, blur, sharpen, composite, greyscale, modulate, contrast, gamma, tint, normalize, negate, clahe, threshold, median, extend, extract_channel, remove_alpha, unflatten, text, svg_render, affine, tile, metadata, frames, spritesheet_to_gif, info` }],
        details: { error: "unknown_action", action },
      };
  }

  // Apply output format

  switch (outputFormat) {
    case "jpeg":
      pipeline = pipeline.jpeg({ quality, mozjpeg: true });
      break;
    case "webp":
      pipeline = pipeline.webp({ quality });
      break;
    case "avif":
      pipeline = pipeline.avif({ quality });
      break;
    case "png":
      pipeline = pipeline.png({ compressionLevel: Math.round((100 - quality) / 10) });
      break;
    case "tiff":
      pipeline = pipeline.tiff({ quality });
      break;
    case "gif":
      pipeline = pipeline.gif();
      break;
  }

  await pipeline.toFile(outputPath);

  const outputStat = statSync(outputPath);
  const inputStat = statSync(inputPath);
  const outputMeta = await sharp(outputPath).metadata();
  const savings = inputStat.size - outputStat.size;
  const workspaceDir = getWorkspaceDir();
  const relativeOutput = stripBaseDirForDisplay(workspaceDir, outputPath);

  return {
    content: [{ type: "text", text: `${action} complete: ${relativeOutput} (${outputMeta.width}x${outputMeta.height}, ${formatBytes(outputStat.size)}${savings > 0 ? `, saved ${formatBytes(savings)}` : ""})` }],
    details: {
      action,
      input: params.input,
      output: relativeOutput,
      format: outputFormat,
      width: outputMeta.width,
      height: outputMeta.height,
      size: outputStat.size,
      originalSize: inputStat.size,
      savings: savings > 0 ? savings : 0,
      mimeType: FORMAT_MIME[outputFormat],
    },
  };
  } finally {
    if (showUiProgress) finishImageProcessUiProgress(ctx);
  }
}

const HINT = [
  "## Image Processing",
  "Prefer image_process over bash or ad-hoc scripts when the task is to edit workspace images.",
  "Use image_process for comprehensive image manipulation. 30+ operations including:",
  "- Geometry: resize, crop, rotate, flip, extend/pad, affine transform, trim",
  "- Format: convert (PNG/JPEG/WebP/AVIF/TIFF/GIF), optimize, svg_render, tile (deep zoom)",
  "- Color: greyscale, modulate, contrast, gamma, tint, normalize, negate, threshold, CLAHE",
  "- Filters: blur, sharpen, median denoise",
  "- Channels: extract_channel, remove_alpha, unflatten",
  "- Compose: composite, text overlay",
  "- Animation: frames (extract), spritesheet_to_gif (assemble)",
  "- Inspect: info, metadata",
  "Great for icons, favicons, logos, screenshots, avatars, transparent PNGs, and GIF workflows.",
  "Non-destructive by default. Preserves transparency and animation.",
].join("\n");

/** Extension factory that registers image_process. */
export const imageProcessing: ExtensionFactory = (pi: ExtensionAPI) => {
  pi.on("before_agent_start", async (event) => ({
    systemPrompt: `${event.systemPrompt}\n\n${HINT}`,
  }));

  pi.registerTool({
    name: "image_process",
    label: "image_process",
    description:
      "Process workspace images with sharp. Operations: resize, crop, convert, optimize, trim, rotate, flip, blur, sharpen, " +
      "composite, greyscale, modulate (brightness/saturation/hue), contrast, gamma, tint, normalize, negate, CLAHE, " +
      "threshold, median denoise, extend/pad, extract_channel, remove_alpha, unflatten, text overlay, svg_render, " +
      "affine transform, tile (deep zoom), metadata inspection, extract frames from animated GIFs, spritesheet_to_gif. " +
      "Useful for icons, favicons, logos, screenshots, avatars, transparent PNGs, and GIF workflows. " +
      "Non-destructive by default. Preserves transparency and animation. Quality configurable.",
    promptSnippet: "image_process: edit workspace images/icons/screenshots — resize, crop, rotate, convert, optimize, preserve transparency, inspect metadata, and build GIF/tile assets.",
    promptGuidelines: [
      "Prefer image_process over bash or hand-rolled scripts for image editing tasks such as icons, favicons, logos, screenshots, avatars, transparent PNGs, and GIFs.",
      "Use action='info' or action='metadata' when you need dimensions, alpha/transparency, format, or other image properties before editing.",
    ],
    parameters: ImageProcessSchema,
    execute: executeImageProcess,
  });
};
