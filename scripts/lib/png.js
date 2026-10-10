'use strict';

/**
 * Minimal PNG writer.
 *
 * Enough to produce solid fills and rectangles without pulling in an image
 * dependency — the project has no native modules on purpose, and fixtures and
 * app icons are both simple shapes.
 */

const zlib = require('node:zlib');

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

/** A drawable RGB surface that encodes to PNG. */
function surface(width, height, background = [11, 13, 18]) {
  const px = Buffer.alloc(width * height * 3);
  for (let i = 0; i < width * height; i += 1) {
    px[i * 3] = background[0];
    px[i * 3 + 1] = background[1];
    px[i * 3 + 2] = background[2];
  }

  const self = {
    width,
    height,

    set(x, y, [r, g, b], alpha = 1) {
      x = Math.round(x);
      y = Math.round(y);
      if (x < 0 || y < 0 || x >= width || y >= height) return;
      const i = (y * width + x) * 3;
      if (alpha >= 1) {
        px[i] = r;
        px[i + 1] = g;
        px[i + 3 - 1] = b;
        return;
      }
      px[i] = Math.round(px[i] * (1 - alpha) + r * alpha);
      px[i + 1] = Math.round(px[i + 1] * (1 - alpha) + g * alpha);
      px[i + 2] = Math.round(px[i + 2] * (1 - alpha) + b * alpha);
    },

    /** Rounded rectangle, anti-aliased at the corners. */
    roundRect(x, y, w, h, radius, colour) {
      for (let py = y; py < y + h; py += 1) {
        for (let px_ = x; px_ < x + w; px_ += 1) {
          const dx = Math.max(x + radius - px_, px_ - (x + w - 1 - radius), 0);
          const dy = Math.max(y + radius - py, py - (y + h - 1 - radius), 0);
          const dist = Math.hypot(dx, dy);
          if (dist > radius) continue;
          const alpha = Math.min(1, radius - dist + 0.5);
          self.set(px_, py, colour, alpha);
        }
      }
    },

    rect(x, y, w, h, colour, radius = 0) {
      if (radius > 0) return self.roundRect(x, y, w, h, radius, colour);
      for (let py = y; py < y + h; py += 1) {
        for (let px_ = x; px_ < x + w; px_ += 1) self.set(px_, py, colour);
      }
    },

    toPNG() {
      const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      const ihdr = Buffer.alloc(13);
      ihdr.writeUInt32BE(width, 0);
      ihdr.writeUInt32BE(height, 4);
      ihdr[8] = 8;
      ihdr[9] = 2; // truecolour
      const raw = Buffer.alloc(height * (1 + width * 3));
      for (let y = 0; y < height; y += 1) {
        const rowStart = y * (1 + width * 3);
        raw[rowStart] = 0;
        px.copy(raw, rowStart + 1, y * width * 3, (y + 1) * width * 3);
      }
      return Buffer.concat([
        sig,
        chunk('IHDR', ihdr),
        chunk('IDAT', zlib.deflateSync(raw)),
        chunk('IEND', Buffer.alloc(0)),
      ]);
    },
  };

  return self;
}

module.exports = { surface };