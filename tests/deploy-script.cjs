/*
 * Прогон tools/deploy-telegram.sh против поддельного supabase CLI.
 *
 * Этот скрипт владелец запускает на рабочем проекте: он меняет схему базы и публикует
 * функцию. Поэтому проверяется не вывод, а поступки — что именно вызвано и в каком порядке,
 * и чего скрипт НЕ делает, когда что-то пошло не так.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');

const root = path.resolve(__dirname, '..');

// Поддельный npx: пишет полученные аргументы в журнал и возвращает код, заданный окружением.
// Так видно и состав вызовов, и их порядок — а значит, и то, что миграции идут раньше деплоя.
function makeFakeCli(dir, logFile) {
  const npx = path.join(dir, 'npx');
  fs.writeFileSync(npx, `#!/usr/bin/env bash
args="$*"
echo "$args" >> ${JSON.stringify(logFile)}
case "$args" in
  *"migration list"*)  echo "   Local          | Remote | Time"; exit "\${MIGRATION_LIST_EXIT:-0}";;
  *"db push"*)         exit "\${DB_PUSH_EXIT:-0}";;
  *"functions deploy"*) exit "\${DEPLOY_EXIT:-0}";;
  *"secrets list"*)    echo "TELEGRAM_BOT_TOKEN"; echo "TELEGRAM_WEBHOOK_SECRET"; echo "TELEGRAM_WEB_APP_URL"; exit 0;;
esac
exit 0
`);
  fs.chmodSync(npx, 0o755);
  return npx;
}

function run(env) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-test-'));
  const logFile = path.join(dir, 'calls.log');
  makeFakeCli(dir, logFile);
  return new Promise(resolve => {
    execFile('bash', [path.join(root, 'tools/deploy-telegram.sh')], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, SUPABASE_PROJECT_REF: 'testref', ...env }
    }, (error, stdout, stderr) => {
      const calls = fs.existsSync(logFile)
        ? fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean)
        : [];
      resolve({ code: error ? error.code ?? 1 : 0, stdout, stderr, calls });
    });
  });
}

const indexOfCall = (calls, needle) => calls.findIndex(line => line.includes(needle));

let failures = 0;
async function check(name, body) {
  try { await body(); console.log('  ok  ' + name); }
  catch (error) { failures++; console.log('  FAIL ' + name); console.log('       ' + (error.message || error)); }
}

(async () => {
  await check('без подтверждения база не меняется и функция не публикуется', async () => {
    // Терминала у теста нет, значит подтвердить невозможно — скрипт обязан отказаться,
    // а не счесть молчание согласием.
    const r = await run({});
    assert.equal(r.code, 3, 'ожидался отказ с кодом 3');
    assert.equal(indexOfCall(r.calls, 'db push'), -1, 'база изменена без подтверждения');
    assert.equal(indexOfCall(r.calls, 'functions deploy'), -1, 'функция опубликована без подтверждения');
  });

  await check('миграции применяются раньше публикации функции', async () => {
    const r = await run({ ASSUME_YES: '1' });
    const push = indexOfCall(r.calls, 'db push');
    const deploy = indexOfCall(r.calls, 'functions deploy');
    assert.ok(push >= 0, 'миграции не применялись');
    assert.ok(deploy >= 0, 'функция не публиковалась');
    assert.ok(push < deploy, 'функция опубликована раньше миграций: код обратится к отсутствующим таблицам');
  });

  await check('упавшие миграции останавливают выкат', async () => {
    const r = await run({ ASSUME_YES: '1', DB_PUSH_EXIT: '1' });
    assert.notEqual(r.code, 0, 'сбой миграций обязан быть ошибкой');
    assert.equal(indexOfCall(r.calls, 'functions deploy'), -1,
      'функция опубликована при несостоявшихся миграциях: схема и код разошлись бы');
  });

  await check('недоступный CLI не выглядит как успешный выкат', async () => {
    const r = await run({ ASSUME_YES: '1', MIGRATION_LIST_EXIT: '1' });
    assert.notEqual(r.code, 0, 'ошибка получения списка миграций обязана останавливать скрипт');
    assert.equal(indexOfCall(r.calls, 'db push'), -1, 'база изменена вслепую');
    assert.equal(indexOfCall(r.calls, 'functions deploy'), -1, 'функция опубликована вслепую');
  });

  await check('без ref проекта скрипт ничего не вызывает', async () => {
    const r = await run({ SUPABASE_PROJECT_REF: '', ASSUME_YES: '1' });
    assert.equal(r.code, 2);
    assert.equal(r.calls.length, 0, 'при отсутствии ref не должно быть ни одного вызова');
  });

  if (failures) {
    console.error(`DEPLOY SCRIPT FAILURE ${failures} проверок провалено`);
    process.exit(1);
  }
  console.log('PASS выкат: подтверждение, порядок шагов и остановка при сбое');
})();
