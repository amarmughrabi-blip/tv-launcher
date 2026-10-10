'use strict';

/**
 * Custom icon store.
 *
 * User-supplied images are read, scaled down to at most ICON_SIZE on their
 * longest edge, re-encoded as PNG, and addressed by a hash of the source path
 * so re-importing the same file is a no-op rather than a duplicate.
 *
 * The decode/scale/encode step needs an image codec. It is injected rather than
 * imported so the naming, sizing and path logic can be exercised under plain
 * node in tests; `electronCodec()` supplies the real one at runtime.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { paths } = require('./paths');

const ICON_SIZE = 256;
const HASH_LEN = 12;
const ICON_NAME_RE = /^[a-f0-9]{12}\.png$/;

/**
 * Stable, filesystem-safe name for an icon sourced from `sourcePath`.
 * Hashed on the *source path*, not the bytes: re-picking the same file should
 * replace the existing entry rather than pile up near-identical PNGs.
 */
function iconName(sourcePath) {
  const digest = crypto.createHash('sha256').update(String(sourcePath), 'utf8').digest('hex');
  return `${digest.slice(0, HASH_LEN)}.png`;
}

/** Content-addressed name, for icons that arrive as bytes. */
function iconNameFromBytes(buf) {
  const digest = crypto.createHash('sha256').update(toBuffer(buf)).digest('hex');
  return `${digest.slice(0, HASH_LEN)}.png`;
}

function iconPath(name) {
  return path.join(paths.iconsDir(), name);
}

/**
 * Normalise an arbitrary image file into the store.
 *
 * @param {string} sourcePath file to read
 * @param {{decode: (buf: Buffer) => {width: number, height: number, toPng: (max: number) => Buffer}}} codec
 * @returns {string|null} stored icon name, or null if the file is not a usable image
 */
function storeIcon(sourcePath, codec) {
  if (typeof sourcePath !== 'string' || !sourcePath) return null;

  let buf;
  try {
    buf = fs.readFileSync(sourcePath);
  } catch {
    return null;
  }

  // Named by source path, so re-picking the same file replaces its entry rather
  // than adding a near-duplicate.
  return writeNormalised(buf, codec, iconName(sourcePath));
}

/**
 * Normalise image bytes into the store.
 *
 * Used by the picker's own file, which has no reliable filesystem path once it
 * crosses the context isolation boundary. Naming is by content hash, so the same
 * image picked twice is stored once.
 *
 * @returns {string|null} stored icon name, or null if the bytes are not an image
 */
function storeIconBytes(bytes, codec) {
  const buf = toBuffer(bytes);
  if (!buf || !buf.length) return null;
  return writeNormalised(buf, codec, iconNameFromBytes(buf));
}

function toBuffer(bytes) {
  if (Buffer.isBuffer(bytes)) return bytes;
  if (bytes instanceof ArrayBuffer) return Buffer.from(new Uint8Array(bytes));
  if (ArrayBuffer.isView(bytes)) return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return null;
}

/** Decode, downscale and write. Returns the name, or null if it is not an image. */
function writeNormalised(buf, codec, name) {
  let normalised;
  try {
    const decoded = codec.decode(buf);
    if (!decoded || !decoded.width || !decoded.height) return null;
    normalised = decoded.toPng(ICON_SIZE);
  } catch {
    return null;
  }
  if (!normalised || !normalised.length) return null;

  try {
    fs.mkdirSync(paths.iconsDir(), { recursive: true });
    fs.writeFileSync(iconPath(name), normalised);
  } catch {
    return null;
  }
  return name;
}

/** Absolute path of a stored icon, or null when it is absent or the name is unsafe. */
function resolveIcon(name) {
  if (typeof name !== 'string' || !ICON_NAME_RE.test(name)) return null;
  const file = iconPath(name);
  try {
    fs.accessSync(file, fs.constants.R_OK);
    return file;
  } catch {
    return null;
  }
}

function deleteIcon(name) {
  if (typeof name !== 'string' || !ICON_NAME_RE.test(name)) return false;
  try {
    fs.rmSync(iconPath(name), { force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Codec backed by Electron's nativeImage. Loaded lazily so this module stays
 * importable from plain node.
 */
function electronCodec() {
  const { nativeImage } = require('electron');
  return {
    decode(buf) {
      const img = nativeImage.createFromBuffer(buf);
      if (img.isEmpty()) return null;
      return {
        width: img.getSize().width,
        height: img.getSize().height,
        toPng(max) {
          const { width, height } = img.getSize();
          if (width <= max && height <= max) return img.toPNG();
          const ratio = Math.min(max / width, max / height);
          const target = {
            width: Math.max(1, Math.round(width * ratio)),
            height: Math.max(1, Math.round(height * ratio)),
          };
          return img.resize({ width: target.width, height: target.height, quality: 'best' }).toPNG();
        },
      };
    },
  };
}

module.exports = {
  ICON_SIZE,
  HASH_LEN,
  iconName,
  iconNameFromBytes,
  iconPath,
  storeIcon,
  storeIconBytes,
  resolveIcon,
  deleteIcon,
  electronCodec,
  ICON_NAME_RE,
};