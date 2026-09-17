#!/usr/bin/env node
/**
 * Draw the home-screen icons from the same mark as `public/favicon.svg`.
 *
 * WHY A SCRIPT AND NOT A RASTERISER. The favicon is an SVG whose `z` is a TEXT
 * node — `system-ui, sans-serif` at weight 700 — so rasterising it would bake in
 * whichever font the machine that ran the rasteriser happened to have, and the
 * icon would change the next time somebody regenerated it on a different box.
 * The same three strokes drawn as a polygon are stable, sharp at 192px, and need
 * no image dependency in a repository that has none. The colour, the rounding
 * ratio (`rx="8"` on a 32 viewBox → a quarter of the side) and the letter are
 * the favicon's; only the glyph's outline is reconstructed.
 *
 * Run it after changing the mark:  node scripts/generate-pwa-icons.mjs
 * It writes the four files under `public/icons/` and prints what it wrote. The
 * PNGs are committed — nothing at build time regenerates them.
 *
 * THE MASKABLE ONE IS A DIFFERENT DRAWING, not the same one re-exported. A
 * maskable icon is cropped by the platform to whatever shape it likes (Android
 * circles it, squircles it, or squares it), so it is drawn FULL BLEED with no
 * rounded corners of its own — rounded corners inside a circular mask read as a
 * shrunken sticker — and with a smaller glyph, comfortably inside the 80% safe
 * circle every mask is guaranteed to keep. `apple-touch-icon` is full bleed for
 * the same reason: iOS rounds it itself.
 */
import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ICON_DIR = join(HERE, '..', 'public', 'icons')

/** The favicon's fill: Tailwind emerald-500, which is also the manifest's theme colour. */
const BRAND = [0x10, 0xb9, 0x81]
const INK = [0xff, 0xff, 0xff]

/**
 * The `z`, as a closed polygon in a unit box (y grows downward). Two horizontal
 * bars of thickness `T` joined by a diagonal that lands exactly on the top-right
 * and bottom-left corners, which is what keeps the counters open and the corners
 * square. `0.40`/`0.60` are mirror images of each other — that symmetry is what
 * makes the two diagonal edges parallel, and a change to one without the other
 * gives a wedge rather than a stroke.
 */
const T = 0.22
const Z = [
  [0, 0], [1, 0], [0.40, 1 - T], [1, 1 - T],
  [1, 1], [0, 1], [0.60, T], [0, T]
]

/** Even-odd point-in-polygon. The outline is simple, so the rule does not matter. */
function inZ(x, y) {
  let inside = false
  for (let i = 0, j = Z.length - 1; i < Z.length; j = i++) {
    const [xi, yi] = Z[i]
    const [xj, yj] = Z[j]
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

/** Is (x, y) inside a `size`-square with corner radius `r`? `r === 0` is the plain square. */
function inRoundedSquare(x, y, size, r) {
  if (x < 0 || y < 0 || x > size || y > size) return false
  if (r <= 0) return true
  const cx = Math.min(Math.max(x, r), size - r)
  const cy = Math.min(Math.max(y, r), size - r)
  const dx = x - cx
  const dy = y - cy
  return dx * dx + dy * dy <= r * r
}

/**
 * Render one icon. Coverage is sampled on a 4×4 grid per pixel and the two
 * colours are mixed by it — the whole of the anti-aliasing, and the reason the
 * diagonal does not read as a staircase at 192px.
 */
function render({ size, radius, glyph }) {
  const SUB = 4
  const gh = size * glyph
  const gw = gh * 0.92
  const gx = (size - gw) / 2
  const gy = (size - gh) / 2
  const px = Buffer.alloc(size * size * 3)

  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      let bg = 0
      let ink = 0
      for (let sy = 0; sy < SUB; sy++) {
        for (let sx = 0; sx < SUB; sx++) {
          const x = col + (sx + 0.5) / SUB
          const y = row + (sy + 0.5) / SUB
          if (!inRoundedSquare(x, y, size, radius)) continue
          bg++
          if (inZ((x - gx) / gw, (y - gy) / gh)) ink++
        }
      }
      const samples = SUB * SUB
      // Outside the rounded square the icon is opaque white, not transparent:
      // every surface that shows these composites them on an unknown colour, and
      // a transparent corner on an `any` icon is what makes it look chipped.
      const o = (row * size + col) * 3
      for (let c = 0; c < 3; c++) {
        const inside = bg === 0 ? 255 : (BRAND[c] * (bg - ink) + INK[c] * ink) / bg
        px[o + c] = Math.round((inside * bg + 255 * (samples - bg)) / samples)
      }
    }
  }
  return { size, px }
}

/** Minimal 8-bit truecolour PNG. One IDAT, filter 0 on every row. */
function png({ size, px }) {
  const raw = Buffer.alloc(size * (size * 3 + 1))
  for (let row = 0; row < size; row++) {
    raw[row * (size * 3 + 1)] = 0
    px.copy(raw, row * (size * 3 + 1) + 1, row * size * 3, (row + 1) * size * 3)
  }

  const chunk = (type, data) => {
    const out = Buffer.alloc(data.length + 12)
    out.writeUInt32BE(data.length, 0)
    out.write(type, 4, 'ascii')
    data.copy(out, 8)
    out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length)
    return out
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
function crc32(buf) {
  let c = 0xffffffff
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

const ICONS = [
  // `any` icons keep the favicon's rounded square: a quarter of the side, which
  // is `rx="8"` on its 32-unit viewBox.
  { file: 'icon-192.png', size: 192, radius: 192 / 4, glyph: 0.44 },
  { file: 'icon-512.png', size: 512, radius: 512 / 4, glyph: 0.44 },
  // Full bleed, smaller glyph: the platform supplies the shape.
  { file: 'icon-maskable-512.png', size: 512, radius: 0, glyph: 0.38 },
  { file: 'apple-touch-icon-180.png', size: 180, radius: 0, glyph: 0.44 }
]

mkdirSync(ICON_DIR, { recursive: true })
for (const icon of ICONS) {
  const bytes = png(render(icon))
  writeFileSync(join(ICON_DIR, icon.file), bytes)
  console.log(`  ${icon.file}  ${icon.size}×${icon.size}  ${bytes.length} bytes`)
}
