import fs from 'node:fs/promises';
import path from 'node:path';

export const PROFILE_PHOTO_SIZE = 256;
export const MAX_PROFILE_PHOTO_BYTES = 15 * 1024 * 1024;
export const MAX_PROFILE_PHOTO_DATA_LENGTH = 400000;
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

export function normalizeProfileName(value) {
  if (typeof value !== 'string' || value.length > 80 || /[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/.test(value)) throw new Error('Use a name of 1–80 characters.');
  const name = value.trim().replace(/\s+/g, ' ');
  if (!name) throw new Error('Add your name to make this space yours.');
  return name;
}

/** Saved photos are small, self-contained PNGs. No file paths or remote URLs. */
export function isProfilePhoto(value) {
  if (value === '') return true;
  if (typeof value !== 'string' || value.length > MAX_PROFILE_PHOTO_DATA_LENGTH || !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(value)) return false;
  const encoded = value.slice('data:image/png;base64,'.length), bytes = Buffer.from(encoded, 'base64');
  if (bytes.length < 33 || bytes.toString('base64') !== encoded || !bytes.subarray(0, 8).equals(pngSignature) || bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii', 12, 16) !== 'IHDR') return false;
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
  return width > 0 && height > 0 && width <= PROFILE_PHOTO_SIZE && height <= PROFILE_PHOTO_SIZE;
}

/** Only call with a native file-picker result. The original photo is never changed. */
/** @param {string} filePath @param {typeof import('electron').nativeImage} nativeImage */
export async function readProfilePhoto(filePath, nativeImage) {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath) || !/\.(png|jpe?g)$/i.test(filePath)) throw new Error('Choose a PNG or JPEG photo.');
  const handle = await fs.open(filePath, 'r');
  let bytes;
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error('Choose a photo file.');
    if (stat.size < 1 || stat.size > MAX_PROFILE_PHOTO_BYTES) throw new Error('Choose a photo smaller than 15 MB.');
    // A bounded read also handles a selected file changing while the picker closes.
    const buffer = Buffer.alloc(stat.size + 1);
    let count = 0;
    while (count < buffer.length) {
      const { bytesRead } = await handle.read(buffer, count, buffer.length - count, count);
      if (!bytesRead) break;
      count += bytesRead;
    }
    if (count !== stat.size) throw new Error('This photo changed while opening. Choose it again.');
    bytes = buffer.subarray(0, count);
  } finally { await handle.close(); }
  const isPNG = bytes.subarray(0, 8).equals(pngSignature), isJPEG = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  if (!isPNG && !isJPEG) throw new Error('Choose a PNG or JPEG photo.');
  const original = nativeImage.createFromBuffer(bytes);
  if (original.isEmpty()) throw new Error('This photo could not be opened. Try a different PNG or JPEG.');
  const { width, height } = original.getSize();
  if (width < 1 || height < 1 || width * height > 40000000) throw new Error('Choose a photo with fewer than 40 megapixels.');
  const side = Math.min(width, height), size = Math.min(PROFILE_PHOTO_SIZE, side);
  const photo = original.crop({ x: Math.floor((width - side) / 2), y: Math.floor((height - side) / 2), width: side, height: side }).resize({ width: size, height: size, quality: 'best' });
  const data = `data:image/png;base64,${photo.toPNG().toString('base64')}`;
  if (!isProfilePhoto(data)) throw new Error('This photo could not be prepared. Try a different PNG or JPEG.');
  return data;
}
