/*
 * Минимальный декодер GIF: ровно столько, чтобы получить пиксели кадров и доказать, что
 * анимация действительно движется. Без внешних зависимостей — тест должен работать в CI,
 * где нет ни ffmpeg, ни проприетарных кодеков в браузере.
 *
 * Поддерживает то, что порождает ffmpeg: GIF89a, глобальная и локальная палитры,
 * прозрачность, методы утилизации кадра 0-3.
 */
'use strict';

function readSubBlocks(buffer, offset) {
  const parts = [];
  while (buffer[offset] !== 0x00) {
    const size = buffer[offset];
    parts.push(buffer.subarray(offset + 1, offset + 1 + size));
    offset += size + 1;
  }
  return { data: Buffer.concat(parts), offset: offset + 1 };
}

function lzwDecode(minCodeSize, data, pixelCount) {
  const clearCode = 1 << minCodeSize;
  const endCode = clearCode + 1;
  const output = new Uint8Array(pixelCount);
  let dictionary = [];
  const resetDictionary = () => {
    dictionary = new Array(clearCode + 2);
    for (let i = 0; i < clearCode; i += 1) dictionary[i] = [i];
  };
  resetDictionary();

  let codeSize = minCodeSize + 1;
  let bitBuffer = 0;
  let bitCount = 0;
  let previous = null;
  let written = 0;

  for (let i = 0; i < data.length && written < pixelCount; i += 1) {
    bitBuffer |= data[i] << bitCount;
    bitCount += 8;
    while (bitCount >= codeSize && written < pixelCount) {
      const code = bitBuffer & ((1 << codeSize) - 1);
      bitBuffer >>= codeSize;
      bitCount -= codeSize;

      if (code === clearCode) {
        resetDictionary();
        codeSize = minCodeSize + 1;
        previous = null;
        continue;
      }
      if (code === endCode) return output;

      let entry;
      if (dictionary[code]) entry = dictionary[code];
      else if (previous) entry = previous.concat(previous[0]);
      else throw new Error('повреждённый поток LZW');

      for (const value of entry) {
        if (written < pixelCount) output[written++] = value;
      }
      if (previous) {
        dictionary.push(previous.concat(entry[0]));
        if (dictionary.length === (1 << codeSize) && codeSize < 12) codeSize += 1;
      }
      previous = entry;
    }
  }
  return output;
}

function decodeGif(buffer, maxFrames = Infinity) {
  if (buffer.subarray(0, 3).toString('latin1') !== 'GIF') throw new Error('не GIF');
  const width = buffer.readUInt16LE(6);
  const height = buffer.readUInt16LE(8);
  const packed = buffer[10];
  let offset = 13;

  let globalPalette = null;
  if (packed & 0x80) {
    const size = 2 << (packed & 0x07);
    globalPalette = buffer.subarray(offset, offset + size * 3);
    offset += size * 3;
  }

  // Холст, на который кадры накладываются так же, как их увидит зритель.
  const canvas = new Uint8Array(width * height * 3);
  const frames = [];
  let transparentIndex = -1;
  let disposal = 0;

  while (offset < buffer.length && frames.length < maxFrames) {
    const marker = buffer[offset];
    if (marker === 0x3b) break;

    if (marker === 0x21) {
      const label = buffer[offset + 1];
      if (label === 0xf9) {
        const flags = buffer[offset + 3];
        disposal = (flags >> 2) & 0x07;
        transparentIndex = flags & 0x01 ? buffer[offset + 6] : -1;
        offset += 8;
      } else {
        offset += 2;
        offset = readSubBlocks(buffer, offset).offset;
      }
      continue;
    }

    if (marker !== 0x2c) { offset += 1; continue; }

    const left = buffer.readUInt16LE(offset + 1);
    const top = buffer.readUInt16LE(offset + 3);
    const frameWidth = buffer.readUInt16LE(offset + 5);
    const frameHeight = buffer.readUInt16LE(offset + 7);
    const framePacked = buffer[offset + 9];
    offset += 10;

    let palette = globalPalette;
    if (framePacked & 0x80) {
      const size = 2 << (framePacked & 0x07);
      palette = buffer.subarray(offset, offset + size * 3);
      offset += size * 3;
    }
    if (framePacked & 0x40) throw new Error('чересстрочные GIF не поддерживаются');

    const minCodeSize = buffer[offset];
    const blocks = readSubBlocks(buffer, offset + 1);
    offset = blocks.offset;

    const indices = lzwDecode(minCodeSize, blocks.data, frameWidth * frameHeight);
    const previous = disposal === 3 ? Uint8Array.from(canvas) : null;

    for (let y = 0; y < frameHeight; y += 1) {
      for (let x = 0; x < frameWidth; x += 1) {
        const index = indices[y * frameWidth + x];
        if (index === transparentIndex) continue;
        const target = ((top + y) * width + (left + x)) * 3;
        if (target < 0 || target + 2 >= canvas.length) continue;
        canvas[target] = palette[index * 3];
        canvas[target + 1] = palette[index * 3 + 1];
        canvas[target + 2] = palette[index * 3 + 2];
      }
    }

    frames.push(Uint8Array.from(canvas));

    if (disposal === 2) {
      for (let y = 0; y < frameHeight; y += 1) {
        for (let x = 0; x < frameWidth; x += 1) {
          const target = ((top + y) * width + (left + x)) * 3;
          if (target >= 0 && target + 2 < canvas.length) {
            canvas[target] = canvas[target + 1] = canvas[target + 2] = 0;
          }
        }
      }
    } else if (disposal === 3 && previous) {
      canvas.set(previous);
    }
  }

  return { width, height, frames };
}

/** Доля пикселей, отличающихся между двумя кадрами, в процентах. */
function frameDifference(a, b) {
  let changed = 0;
  const pixels = a.length / 3;
  for (let i = 0; i < a.length; i += 3) {
    if (Math.abs(a[i] - b[i]) > 6 || Math.abs(a[i + 1] - b[i + 1]) > 6 || Math.abs(a[i + 2] - b[i + 2]) > 6) {
      changed += 1;
    }
  }
  return (changed / pixels) * 100;
}

module.exports = { decodeGif, frameDifference };
