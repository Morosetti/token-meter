#!/usr/bin/env node
'use strict';
/**
 * Generates assets/icon.png (512x512) with no image dependencies.
 *
 * electron-builder derives the .ico and .icns from this single PNG, so this is
 * the only icon source in the repo. Run it again after changing the palette:
 *   node assets/make-icon.js
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const S = 512;
const SS = 3; // supersampling factor per axis, for cheap anti-aliasing

// --- geometry ------------------------------------------------------------ //
const CORNER = S * 0.225;
const CX = S / 2, CY = S / 2;
const RING_R = S * 0.29;
const RING_W = S * 0.105;
const DOT_R = S * 0.062;
const FILLED = 0.68; // how much of the ring is "used", purely decorative

function insideRoundedRect(x, y) {
  if (x < 0 || y < 0 || x > S || y > S) return false;
  const dx = Math.min(x, S - x), dy = Math.min(y, S - y);
  if (dx >= CORNER || dy >= CORNER) return true;
  const ox = CORNER - dx, oy = CORNER - dy;
  return ox * ox + oy * oy <= CORNER * CORNER;
}

/** 0 = not on the ring, 1 = on it. `frac` is the angular position, 0..1 from 12 o'clock. */
function ringAt(x, y) {
  const dx = x - CX, dy = y - CY;
  const d = Math.hypot(dx, dy);
  if (Math.abs(d - RING_R) > RING_W / 2) return null;
  let a = Math.atan2(dy, dx) + Math.PI / 2;      // rotate so 0 is straight up
  if (a < 0) a += Math.PI * 2;
  return a / (Math.PI * 2);
}

function lerp(a, b, t) { return a + (b - a) * t; }

// --- rasterise ----------------------------------------------------------- //
const raw = Buffer.alloc(S * (S * 4 + 1));
let p = 0;

for (let y = 0; y < S; y++) {
  raw[p++] = 0; // PNG filter type 0 (None) for this scanline
  for (let x = 0; x < S; x++) {
    let r = 0, g = 0, b = 0, a = 0;

    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const px = x + (sx + 0.5) / SS;
        const py = y + (sy + 0.5) / SS;
        if (!insideRoundedRect(px, py)) continue;

        // Coral gradient, top-left to bottom-right.
        const t = (px + py) / (S * 2);
        let cr = lerp(224, 194, t), cg = lerp(138, 98, t), cb = lerp(107, 63, t);

        const dot = Math.hypot(px - CX, py - CY) <= DOT_R;
        const ring = ringAt(px, py);
        if (dot) {
          cr = cg = cb = 255;
        } else if (ring !== null) {
          // Filled part is solid white; the remainder is a faint track.
          const alpha = ring <= FILLED ? 1 : 0.28;
          cr = lerp(cr, 255, alpha);
          cg = lerp(cg, 255, alpha);
          cb = lerp(cb, 255, alpha);
        }
        r += cr; g += cg; b += cb; a += 255;
      }
    }

    const n = SS * SS;
    const cov = a / (255 * n);
    if (cov > 0) {
      // Un-premultiply so edge pixels keep the right hue.
      raw[p++] = Math.round(r / (n * cov));
      raw[p++] = Math.round(g / (n * cov));
      raw[p++] = Math.round(b / (n * cov));
      raw[p++] = Math.round(cov * 255);
    } else {
      raw[p++] = 0; raw[p++] = 0; raw[p++] = 0; raw[p++] = 0;
    }
  }
}

// --- encode PNG ---------------------------------------------------------- //
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(S, 0);
ihdr.writeUInt32BE(S, 4);
ihdr[8] = 8;   // bit depth
ihdr[9] = 6;   // colour type: RGBA
ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

const out = path.join(__dirname, 'icon.png');
fs.writeFileSync(out, png);
console.log('wrote ' + out + ' (' + S + 'x' + S + ', ' + (png.length / 1024).toFixed(1) + ' KB)');
