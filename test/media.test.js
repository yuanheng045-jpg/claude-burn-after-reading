import { test } from 'node:test'
import assert from 'node:assert/strict'
import { imageSize, imageTokens } from '../src/media.js'
import { pngBase64 } from './helpers.js'

test('reads the size of PNG, GIF, JPEG and WebP', () => {
  assert.deepEqual(imageSize(pngBase64(640, 360)), { width: 640, height: 360 })
  const gif = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x20, 0x03, 0x58, 0x02, 0, 0, 0, 0, 0, 0])
  assert.deepEqual(imageSize(gif.toString('base64')), { width: 800, height: 600 })
  // JPEG: SOI, an APP0 segment, then SOF0 with height 480 and width 1280
  const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0xe0, 0x05, 0x00, 0x03, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])
  assert.deepEqual(imageSize(jpg.toString('base64')), { width: 1280, height: 480 })
  const webp = Buffer.alloc(30); webp.write('RIFF', 0); webp.write('WEBPVP8X', 8); webp.writeUIntLE(1919, 24, 3); webp.writeUIntLE(1079, 27, 3)
  assert.deepEqual(imageSize(webp.toString('base64')), { width: 1920, height: 1080 })
  assert.equal(imageSize('not an image at all'), null)
})

test('token estimate follows width × height / 750 after scaling down', () => {
  assert.equal(imageTokens({ width: 750, height: 1 }), 1)
  assert.equal(imageTokens({ width: 1000, height: 1000 }), 1334)
  assert.ok(imageTokens({ width: 4000, height: 3000 }) <= 1534)   // scaled to fit 1568 px / 1.15 MP
  assert.equal(imageTokens(null), null)
})
