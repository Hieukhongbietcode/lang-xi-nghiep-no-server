// Chạy toàn bộ test server. Có bất kỳ mục ❌ nào -> thoát mã lỗi (GitHub báo đỏ).
const { spawn } = require('child_process'); const path = require('path');
const ROOT = path.join(__dirname, '..'), wait = ms => new Promise(r => setTimeout(r, ms));
const TESTS = ['test_server', 'test_p2', 'test_p3', 'test_p3c', 'test_p12', 'test_voice', 'test_p10', 'test_p13'];
function run(file) {
  return new Promise(res => { let out = ''; const p = spawn('node', [file], { cwd: ROOT });
    p.stdout.on('data', d => out += d); p.stderr.on('data', d => out += d); p.on('close', code => res({ out, code })); });
}
const count = (s, ch) => (s.match(new RegExp(ch, 'g')) || []).length;
(async () => {
  let bad = 0;
  for (const t of TESTS) {
    // server sạch cho mỗi bộ test, không dùng Upstash
    const LOG = path.join(require('os').tmpdir(), 'lxn-srv.log'), fs = require('fs'); fs.writeFileSync(LOG, '');
    const srv = spawn('node', ['server.js'], { cwd: ROOT, env: Object.assign({}, process.env, { PORT: '8787', UPSTASH_REDIS_REST_URL: '', UPSTASH_REDIS_REST_TOKEN: '' }) });
    srv.stdout.on('data', d => fs.appendFileSync(LOG, d)); srv.stderr.on('data', d => fs.appendFileSync(LOG, d));
    await wait(1200); process.env.LXN_SRV_LOG = LOG;
    const r = await run(path.join('tests', t + '.js'));
    srv.kill(); await wait(400);
    const ok = count(r.out, '✅'), ko = count(r.out, '❌');
    console.log(`${ko || r.code ? '❌' : '✅'} ${t}: ${ok} đúng, ${ko} sai`);
    if (ko || r.code || !ok) { bad++; console.log(r.out); }
  }
  // lưu phòng (Upstash giả chạy trên máy test)
  const mock = spawn('node', [path.join('tests', 'mock_upstash.js')], { cwd: ROOT }); await wait(800);
  const r = await run(path.join('tests', 'test_persist.js')); mock.kill();
  const ok = count(r.out, '✅'), ko = count(r.out, '❌');
  console.log(`${ko || !ok ? '❌' : '✅'} test_persist: ${ok} đúng, ${ko} sai`); if (ko || !ok) { bad++; console.log(r.out); }
  console.log(bad ? `\n${bad} bộ test hỏng` : '\nTất cả test server đều đạt');
  process.exit(bad ? 1 : 0);
})();
