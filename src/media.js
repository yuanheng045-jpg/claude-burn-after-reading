// Read just enough of a base64 image to learn its pixel size, and estimate what it costs Claude in input tokens.

/** @param {string} b64 @param {number} bytes */
function head(b64, bytes) {
  const chars = Math.ceil(bytes / 3) * 4
  return Buffer.from(b64.slice(0, chars), 'base64')
}

/**
 * Width and height of a PNG, GIF, WebP or JPEG given as base64, or null if it can't be told.
 * @param {string} b64
 * @returns {{ width: number, height: number } | null}
 */
export function imageSize(b64) {
  if (typeof b64 !== 'string' || b64.length < 16) return null
  try {
    let b = head(b64, 64)
    if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {           // PNG: IHDR
      return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) }
    }
    if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) {                              // GIF
      return { width: b.readUInt16LE(6), height: b.readUInt16LE(8) }
    }
    if (b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') {  // WebP
      const kind = b.toString('ascii', 12, 16)
      if (kind === 'VP8 ') return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff }
      if (kind === 'VP8L') {
        const v = b.readUInt32LE(21)
        return { width: (v & 0x3fff) + 1, height: ((v >> 14) & 0x3fff) + 1 }
      }
      if (kind === 'VP8X') return { width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) }
      return null
    }
    if (b[0] === 0xff && b[1] === 0xd8) {                                                // JPEG: walk to the first SOF marker
      b = head(b64, 256 * 1024)
      let i = 2
      while (i + 9 < b.length) {
        if (b[i] !== 0xff) { i++; continue }
        const m = b[i + 1]
        if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue }
        const len = b.readUInt16BE(i + 2)
        if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
          return { width: b.readUInt16BE(i + 7), height: b.readUInt16BE(i + 5) }
        }
        i += 2 + len
      }
    }
  } catch { /* truncated or not an image */ }
  return null
}

/**
 * Rough input-token cost of one image (Anthropic's rule of thumb: width × height / 750, after the image is scaled
 * down to fit about 1568 px on the long edge and about 1.15 megapixels). Newer models may allow larger images, so
 * treat this as an estimate. Returns null when the size is unknown.
 * @param {{ width: number, height: number } | null} size
 */
export function imageTokens(size) {
  if (!size || !(size.width > 0) || !(size.height > 0)) return null
  let w = size.width, h = size.height
  const long = Math.max(w, h)
  if (long > 1568) { const s = 1568 / long; w *= s; h *= s }
  const px = w * h, max = 1_150_000
  if (px > max) { const s = Math.sqrt(max / px); w *= s; h *= s }
  return Math.max(1, Math.ceil((w * h) / 750))
}
