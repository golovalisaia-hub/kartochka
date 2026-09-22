/*
 * Прогон tools/telegram-apply.sh против поддельного Bot API.
 *
 * Скрипт запускают с боевым токеном, поэтому его поведение проверяется целиком: какие методы
 * вызываются, с какой полезной нагрузкой, и отказывается ли он ставить кнопку меню, когда по
 * адресу приложения отвечает страница входа хостинга.
 */
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { execFile } = require('node:child_process');

// Скрипт обязательно запускается АСИНХРОННО: мок Bot API живёт в этом же процессе, и
// синхронный запуск заблокировал бы event loop — сервер не смог бы ответить.
function runScript(env, cwd = root) {
  return new Promise(resolve => {
    execFile('bash', [path.join(root, 'tools/telegram-apply.sh')], {
      cwd, encoding: 'utf8', env: { ...process.env, ...env }
    }, (error, stdout, stderr) => resolve({ code: error ? error.code ?? 1 : 0, stdout, stderr }));
  });
}

const root = path.resolve(__dirname, '..');

function startApi() {
  const calls = [];
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      const method = request.url.split('/').pop();
      calls.push({ method, payload: body ? JSON.parse(body) : null });
      response.setHeader('Content-Type', 'application/json');
      if (method === 'getMe') {
        response.end(JSON.stringify({ ok: true, result: { username: 'KartochkaWalletBot' } }));
        return;
      }
      response.end(JSON.stringify({ ok: true, result: true }));
    });
  });
  return { server, calls };
}

function startSite(html) {
  const server = http.createServer((request, response) => {
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end(html);
  });
  return server;
}



(async () => {
  const { server: api, calls } = startApi();
  await new Promise(resolve => api.listen(0, '127.0.0.1', resolve));
  const apiBase = `http://127.0.0.1:${api.address().port}`;

  const realSite = startSite('<html><head><title>Карточка</title></head><body><script src="telegram-mini-app.js"></script></body></html>');
  await new Promise(resolve => realSite.listen(0, '127.0.0.1', resolve));
  const realUrl = `http://127.0.0.1:${realSite.address().port}/`;

  const wall = startSite('<html><head><title>Login</title></head><body>Log in to Vercel</body></html>');
  await new Promise(resolve => wall.listen(0, '127.0.0.1', resolve));
  const wallUrl = `http://127.0.0.1:${wall.address().port}/`;

  const failures = [];
  const check = async (name, body) => {
    try { await body(); console.log(`  ok  ${name}`); }
    catch (error) { failures.push(name); console.error(`  FAIL ${name}\n       ${error.message}`); }
  };

  try {
    await check('без токена скрипт останавливается и ничего не вызывает', async () => {
      calls.length = 0;
      const result = await runScript({ TELEGRAM_BOT_TOKEN: '', TELEGRAM_API_BASE: apiBase });
      assert.notEqual(result.code, 0, 'скрипт обязан завершиться с ошибкой');
      assert.match(result.stderr, /TELEGRAM_BOT_TOKEN/);
      assert.equal(calls.length, 0, 'без токена не должно быть ни одного запроса');
    });

    await check('оформление применяется полностью и с верными текстами', async () => {
      calls.length = 0;
      const { stdout: output, code } = await runScript({ TELEGRAM_BOT_TOKEN: 'test-token', TELEGRAM_API_BASE: apiBase, TELEGRAM_WEB_APP_URL: realUrl });
      assert.equal(code, 0, 'при исправном адресе скрипт обязан завершиться успешно');
      const byMethod = Object.fromEntries(calls.map(item => [item.method, item.payload]));
      for (const method of ['getMe', 'setMyName', 'setMyShortDescription', 'setMyDescription', 'setMyCommands', 'setChatMenuButton']) {
        assert.ok(method in byMethod, `не вызван ${method}`);
      }
      assert.equal(byMethod.setMyName.name, 'Карточка');
      assert.match(byMethod.setMyShortDescription.short_description, /Все скидочные карты в одном месте/);
      assert.match(byMethod.setMyDescription.description, /цифровой кошелёк/);
      assert.ok(byMethod.setMyDescription.description.length <= 512);
      assert.ok(byMethod.setMyShortDescription.short_description.length <= 120);
      assert.deepEqual(byMethod.setMyCommands.commands.map(item => item.command),
        ['start', 'menu', 'quick', 'plans', 'support']);
      assert.equal(byMethod.setChatMenuButton.menu_button.web_app.url, realUrl);
      assert.match(output, /Edit Botpic/, 'скрипт обязан сказать, что аватар ставится вручную');
      assert.doesNotMatch(output, /test-token/, 'токен не должен попадать в вывод');
    });

    await check('кнопка меню не ставится, если адрес отдаёт страницу входа хостинга', async () => {
      calls.length = 0;
      // Ненулевой код здесь ожидаем: один шаг сознательно не выполнен.
      const { stdout: output } = await runScript({ TELEGRAM_BOT_TOKEN: 'test-token', TELEGRAM_API_BASE: apiBase, TELEGRAM_WEB_APP_URL: wallUrl });
      assert.equal(calls.some(item => item.method === 'setChatMenuButton'), false,
        'кнопка не должна вести на форму входа Vercel');
      assert.match(output, /Deployment Protection|страница входа Vercel/);
      // Остальное оформление при этом всё равно применяется.
      assert.ok(calls.some(item => item.method === 'setMyDescription'));
    });

    await check('без адреса приложения кнопка меню просто пропускается', async () => {
      calls.length = 0;
      const { stdout: output } = await runScript({ TELEGRAM_BOT_TOKEN: 'test-token', TELEGRAM_API_BASE: apiBase, TELEGRAM_WEB_APP_URL: '' });
      assert.equal(calls.some(item => item.method === 'setChatMenuButton'), false);
      assert.match(output, /пропущена/);
      assert.ok(calls.some(item => item.method === 'setMyName'), 'остальное оформление применяется');
    });

    await check('скрипт работает из любого каталога, а не только из корня', async () => {
      calls.length = 0;
      // Тексты лежат в репозитории, поэтому скрипт обязан находить их по своему пути,
      // а не по текущему каталогу пользователя.
      const { stdout, code } = await runScript(
        { TELEGRAM_BOT_TOKEN: 'test-token', TELEGRAM_API_BASE: apiBase, TELEGRAM_WEB_APP_URL: '' },
        require('node:os').tmpdir()
      );
      assert.equal(code, 0, `запуск из другого каталога должен проходить: ${stdout}`);
      assert.doesNotMatch(stdout, /ERR_MODULE_NOT_FOUND/);
      assert.ok(calls.some(item => item.method === 'setMyDescription'), 'оформление всё равно применяется');
    });

    if (failures.length) throw new Error(`${failures.length} проверок скрипта провалено: ${failures.join(', ')}`);
    console.log('PASS tools/telegram-apply.sh: методы, тексты, защита от страницы входа и отсутствие утечки токена');
  } finally {
    await new Promise(resolve => api.close(resolve));
    await new Promise(resolve => realSite.close(resolve));
    await new Promise(resolve => wall.close(resolve));
  }
})().catch(error => {
  console.error('TELEGRAM APPLY SCRIPT FAILURE', error);
  process.exitCode = 1;
});
