/*
 * Проверка аватара под круглой обрезкой Telegram.
 *
 *   node tools/avatar-crop-check.cjs assets/branding/avatar-telegram.jpg
 *
 * Telegram показывает аватар кругом, вписанным в квадрат. Всё, что выходит за этот круг,
 * срезается. Скрипт открывает файл в браузере, считает, какая доля значимого изображения
 * попадает в углы за пределами круга, и сохраняет рядом превью с наложенной маской.
 *
 * Ничего не изменяет и не перезаписывает исходный файл.
 */
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const file = process.argv[2];
if (!file) {
  console.error('Укажите файл: node tools/avatar-crop-check.cjs <путь к аватару>');
  process.exit(2);
}
const target = path.resolve(file);
if (!fs.existsSync(target)) {
  console.error(`Файл не найден: ${target}`);
  process.exit(2);
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 512, height: 512 } });
  const dataUrl = `data:${{
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp'
  }[path.extname(target).toLowerCase()] || 'application/octet-stream'};base64,${fs.readFileSync(target).toString('base64')}`;

  const report = await page.evaluate(async src => {
    const image = new Image();
    await new Promise((resolve, reject) => { image.onload = resolve; image.onerror = reject; image.src = src; });
    const size = 512;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.drawImage(image, 0, 0, size, size);
    const { data } = context.getImageData(0, 0, size, size);

    // The dominant edge colour is treated as background; anything clearly different is content.
    const corner = index => [data[index], data[index + 1], data[index + 2]];
    const background = corner(0);
    const differs = (r, g, b) =>
      Math.abs(r - background[0]) + Math.abs(g - background[1]) + Math.abs(b - background[2]) > 48;

    const radius = size / 2;
    let content = 0;
    let clipped = 0;
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const i = (y * size + x) * 4;
        if (data[i + 3] < 16) continue;
        if (!differs(data[i], data[i + 1], data[i + 2])) continue;
        content += 1;
        const dx = x - radius + 0.5;
        const dy = y - radius + 0.5;
        if (Math.sqrt(dx * dx + dy * dy) > radius) clipped += 1;
      }
    }
    return {
      naturalWidth: image.naturalWidth,
      naturalHeight: image.naturalHeight,
      contentPixels: content,
      clippedPixels: clipped,
      clippedPercent: content ? (clipped / content) * 100 : 0
    };
  }, dataUrl);

  // Preview: the real circular crop next to the square original.
  await page.setContent(`<body style="margin:0;display:flex;gap:16px;padding:16px;background:#111">
    <img src="${dataUrl}" style="width:220px;height:220px;object-fit:cover">
    <img src="${dataUrl}" style="width:220px;height:220px;object-fit:cover;border-radius:50%">
  </body>`);
  const preview = `${target.replace(/\.[^.]+$/, '')}-crop-preview.png`;
  await page.screenshot({ path: preview });
  await browser.close();

  const square = report.naturalWidth === report.naturalHeight;
  console.log(`файл:            ${path.relative(process.cwd(), target)}`);
  console.log(`размер:          ${report.naturalWidth}x${report.naturalHeight} ${square ? '(квадрат)' : '(НЕ КВАДРАТ — Telegram обрежет по центру)'}`);
  console.log(`срезается кругом: ${report.clippedPercent.toFixed(2)}% значимого изображения`);
  console.log(`превью:          ${path.relative(process.cwd(), preview)}`);

  const problems = [];
  if (!square) problems.push('изображение не квадратное');
  if (report.clippedPercent > 2) problems.push(`круглая обрезка срезает ${report.clippedPercent.toFixed(1)}% логотипа`);
  if (problems.length) {
    console.log(`\nНУЖНО ПОПРАВИТЬ: ${problems.join('; ')}.`);
    console.log('Добавьте поля по краям, не меняя саму композицию логотипа.');
    process.exitCode = 1;
  } else {
    console.log('\nОК: логотип полностью помещается в круг Telegram.');
  }
})().catch(error => {
  console.error('AVATAR CROP CHECK FAILURE', error);
  process.exitCode = 1;
});
