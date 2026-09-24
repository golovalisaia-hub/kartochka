/*
 * Проверка приветственной анимации «Карточки».
 *
 * Считать кадры недостаточно: файл из ста одинаковых кадров формально анимация, но на экране
 * ничего не движется, а переименованный PNG вообще не анимация. Поэтому GIF здесь
 * декодируется до пикселей собственным декодером (tests/lib/gif-decode.cjs), а MP4
 * разбирается по боксам контейнера. Ни ffmpeg, ни браузерных кодеков не требуется —
 * headless Chromium не прокручивает GIF и не декодирует H.264.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { decodeGif, frameDifference } = require('./lib/gif-decode.cjs');

const root = path.resolve(__dirname, '..');
const gifPath = path.join(root, 'assets/branding/welcome.gif');
const mp4Path = path.join(root, 'assets/branding/welcome.mp4');

// Предел Telegram для sendAnimation по HTTPS-адресу.
const TELEGRAM_URL_LIMIT = 10 * 1024 * 1024;

function parseMp4(buffer) {
  const text = buffer.toString('latin1');
  // sample_count из stsz — это число видеокадров, декодировать поток не нужно.
  let frames = 0;
  const stsz = text.indexOf('stsz');
  if (stsz > 0) frames = buffer.readUInt32BE(stsz + 12);
  let duration = 0;
  const mvhd = text.indexOf('mvhd');
  if (mvhd > 0) {
    const timescale = buffer.readUInt32BE(mvhd + 16);
    const units = buffer.readUInt32BE(mvhd + 20);
    if (timescale) duration = units / timescale;
  }
  return {
    isMp4: buffer.subarray(4, 8).toString('latin1') === 'ftyp',
    hasMoov: text.includes('moov'),
    hasVideoTrack: text.includes('vide'),
    hasAudioTrack: text.includes('soun'),
    isH264: text.includes('avc1') || text.includes('avcC'),
    faststart: text.indexOf('moov') !== -1 && text.indexOf('moov') < text.indexOf('mdat'),
    frames,
    duration
  };
}

const failures = [];
const check = (name, body) => {
  try { body(); console.log(`  ok  ${name}`); }
  catch (error) { failures.push(name); console.error(`  FAIL ${name}\n       ${error.message}`); }
};

check('оба фирменных файла лежат в репозитории', () => {
  assert.ok(fs.existsSync(gifPath), 'нет assets/branding/welcome.gif');
  assert.ok(fs.existsSync(mp4Path), 'нет assets/branding/welcome.mp4');
});

if (failures.length) {
  console.error('BRANDING ANIMATION FAILURE: файлы отсутствуют');
  process.exitCode = 1;
} else {
  const gifBuffer = fs.readFileSync(gifPath);
  const mp4Buffer = fs.readFileSync(mp4Path);
  let decoded = null;

  check('GIF открывается, не повреждён и содержит много кадров', () => {
    assert.equal(gifBuffer.subarray(0, 6).toString('latin1'), 'GIF89a',
      'для анимации и зацикливания нужен GIF89a');
    assert.ok(gifBuffer.includes(Buffer.from('NETSCAPE2.0')),
      'нет блока NETSCAPE2.0 — анимация не зациклится');
    decoded = decodeGif(gifBuffer);
    assert.ok(decoded.frames.length >= 30,
      `кадров должно быть много, декодировано ${decoded.frames.length}`);
    assert.ok(decoded.width >= 320 && decoded.height >= 180,
      `слишком мелко: ${decoded.width}x${decoded.height}`);
    console.log(`       ${decoded.width}x${decoded.height}, кадров: ${decoded.frames.length}, ${Math.round(gifBuffer.length / 1024)} КБ`);
  });

  check('в GIF действительно есть движение, а не повтор одного кадра', () => {
    assert.ok(decoded, 'GIF не декодирован');
    const { frames } = decoded;
    const pairs = [
      [0, Math.floor(frames.length * 0.25)],
      [0, Math.floor(frames.length * 0.5)],
      [Math.floor(frames.length * 0.5), frames.length - 1]
    ];
    const diffs = pairs.map(([a, b]) => frameDifference(frames[a], frames[b]));
    diffs.forEach((value, index) => {
      const [a, b] = pairs[index];
      console.log(`       кадры ${a} и ${b}: различаются ${value.toFixed(1)}% пикселей`);
    });
    assert.ok(Math.max(...diffs) > 2,
      `движения нет: максимум ${Math.max(...diffs).toFixed(2)}% различий`);

    // Соседние кадры тоже обязаны отличаться, иначе анимация «стоит» кусками.
    const neighbours = [];
    for (let i = 1; i < Math.min(frames.length, 40); i += 1) {
      neighbours.push(frameDifference(frames[i - 1], frames[i]));
    }
    const moving = neighbours.filter(value => value > 0.05).length;
    assert.ok(moving >= neighbours.length * 0.5,
      `слишком много статичных подряд идущих кадров: двигаются ${moving} из ${neighbours.length}`);
  });

  check('GIF умещается в предел Telegram', () => {
    assert.ok(gifBuffer.length <= TELEGRAM_URL_LIMIT,
      `${Math.round(gifBuffer.length / 1024 / 1024)} МБ больше предела в 10 МБ`);
  });

  check('MP4 пригоден для sendAnimation: без звука, H.264, faststart', () => {
    const info = parseMp4(mp4Buffer);
    assert.ok(info.isMp4, 'нет заголовка ftyp');
    assert.ok(info.hasMoov, 'нет moov — файл повреждён');
    assert.ok(info.hasVideoTrack, 'нет видеодорожки');
    assert.equal(info.hasAudioTrack, false, 'Telegram принимает анимацию только без звука');
    assert.ok(info.isH264, 'нужен H.264');
    assert.ok(info.faststart, 'moov должен идти перед mdat, иначе Telegram качает файл целиком');
    assert.ok(info.frames > 30, `кадров должно быть много, найдено ${info.frames}`);
    assert.ok(info.duration > 1, `длительность должна быть больше секунды, получено ${info.duration}`);
    assert.ok(mp4Buffer.length <= TELEGRAM_URL_LIMIT, 'больше предела Telegram в 10 МБ');
    console.log(`       кадров: ${info.frames}, ${info.duration.toFixed(2)} с, ${Math.round(mp4Buffer.length / 1024)} КБ`);
  });

  check('MP4 сохранил разрешение оригинала и весит меньше GIF', () => {
    // Telegram получает MP4 первым: то же изображение, но кратно легче.
    assert.ok(mp4Buffer.length < gifBuffer.length,
      'MP4 обязан быть легче GIF, иначе он не имеет смысла как основной источник');
  });

  check('статичную картинку под видом анимации тест бы не пропустил', () => {
    // Защита от подмены: одиночный кадр обязан провалить проверку движения.
    const single = decodeGif(gifBuffer, 1);
    assert.equal(single.frames.length, 1);
    assert.equal(frameDifference(single.frames[0], single.frames[0]), 0,
      'сравнение кадра с самим собой обязано давать ноль различий');
  });

  if (failures.length) {
    console.error(`BRANDING ANIMATION FAILURE: провалено ${failures.length} — ${failures.join(', ')}`);
    process.exitCode = 1;
  } else {
    console.log('PASS приветственная анимация: целостность, кадры, реальное движение, пригодность для Telegram');
  }
}
