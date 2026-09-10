declare module "gifenc" {
  export type RgbaFormat = "rgba4444" | "rgb565";
  export type Palette = number[][];

  export interface GifFrameOptions {
    palette: Palette;
    delay?: number;
    repeat?: number;
    transparent?: boolean;
    transparentIndex?: number;
    dispose?: number;
  }

  export interface GifEncoder {
    writeFrame(index: Uint8Array, width: number, height: number, options: GifFrameOptions): void;
    finish(): void;
    bytes(): Uint8Array;
  }

  export function GIFEncoder(options?: { initialCapacity?: number; auto?: boolean }): GifEncoder;
  export function quantize(rgba: Uint8Array, maxColors: number, options?: { format?: RgbaFormat }): Palette;
  export function applyPalette(rgba: Uint8Array, palette: Palette, format?: RgbaFormat): Uint8Array;
}
