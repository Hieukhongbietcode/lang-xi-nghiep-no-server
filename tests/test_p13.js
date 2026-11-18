// Server: phiên bản, /health, chặn nguồn lạ, kết nối chết, giới hạn, lưu lần cuối khi tắt
const WebSocket = require('ws'); const { spawn } = require('child_process'); const path = require('path'); const http = require('http');
const ROOT = path.join(__dirname, '..'), PORT = 8799, URL = 'ws://localhost:' + PORT;
const wait = ms => new Promise(r => setTimeout(r, ms)); const ok = (c, m) => console.log((c ? '  ✅ ' : '  ❌ ') + m);
const open = (o, url) => new Promise((res) => { const w = new WebSocket(url || URL, o || {}); w.inbox = []; w.closeCode = null; w.on('message', d => w.inbox.push(JSON.parse(d))); w.on('close', c => w.closeCode = c);
    w.on('open', () => res(w)); w.on('error', () => res(w)); w.on('unexpected-response', (q, r) => { w.rejected = r.statusCode; res(w); }); });
const last = (w, t) => [...w.inbox].reverse().find(m => m.t === t);
const S = async (w, o) => { w.send(JSON.stringify(o)); await wait(120); };
const getJSON = u => new Promise((res, rej) => http.get(u, r => { let b = ''; r.on('data', d => b += d); r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } }); }).on('error', rej));
const statsMock = () => new Promise(res => { const q = http.request({ host: 'localhost', port: 8790, path: '/stats', method: 'POST', headers: { authorization: 'Bearer test-token' } }, r => { let b = ''; r.on('data', d => b += d); r.on('end', () => res(JSON.parse(b))); }); q.end(); });
(async () => {
  const mock = spawn('node', [path.join(__dirname, 'mock_upstash.js')], { cwd: ROOT }); await wait(700);
  let log = ''; const srv = spawn('node', ['server.js'], { cwd: ROOT, env: Object.assign({}, process.env, { PORT: String(PORT), PING_MS: '800', UPSTASH_REDIS_REST_URL: 'http://localhost:8790', UPSTASH_REDIS_REST_TOKEN: 'test-token' }) });
  srv.stdout.on('data', d => log += d); srv.stderr.on('data', d => log += d); await wait(1300);
  // 1. phiên bản
  const a = await open(); await wait(200);
  ok(/^\d{4}-\d\d-\d\d/.test((last(a, 'hello') || {}).v || ''), '1. vua ket noi -> server gui phien ban: ' + (last(a, 'hello') || {}).v);
  // 4. /health
  const h = await getJSON('http://localhost:' + PORT + '/health');
  ok(h.ok && h.version && 'rooms' in h && 'connections' in h && 'memory_mb' in h && h.persist === true, `4. /health: ${JSON.stringify(h).slice(0, 140)}`);
  // 5. nguồn kết nối
  const evil = await open({ origin: 'https://trang-la.example.com' }); await wait(200);
  ok(evil.rejected === 401 && /CHAN-NGUON/.test(log), '5. trang la -> bi tu choi (401), co ghi nhat ky');
  const gh = await open({ origin: 'https://hieukhongbietcode.github.io' }); await wait(200);
  const lo = await open({ origin: 'http://localhost:5500' }); await wait(200);
  ok(!!last(gh, 'hello') && !!last(lo, 'hello') && !!last(a, 'hello'), '5. trang cua minh / may cuc bo / khong phai trinh duyet -> vao duoc');
  // 3. kết nối chết (đã có sẵn): máy không trả lời ping bị đóng
  const dead = await open({ autoPong: false }); await wait(2800);
  ok(dead.closeCode !== null && a.readyState === 1, `3. may khong tra loi ping bi dong (ma ${dead.closeCode}); may binh thuong van ket noi`);
  // 6. giới hạn
  let lastErr = null;   // kẻ dò mã mở kết nối mới cho mỗi lần thử -> giới hạn theo ĐỊA CHỈ MẠNG
  for (let i = 0; i < 31; i++) { const g = await open(); await S(g, { t: 'join', code: 'ZZZZ' + (i % 9), name: 'X' }); lastErr = last(g, 'error'); g.close(); }
  ok(lastErr && lastErr.code === 'RATE_LIMIT', '6. sai ma phong 31 lan (moi lan 1 ket noi moi) -> bi chan theo dia chi mang: "' + (lastErr || {}).msg + '"');
  const c = await open(); let codes = [];
  for (let i = 0; i < 11; i++) { c.inbox = []; await S(c, { t: 'create' }); codes.push(last(c, 'created') ? 'ok' : (last(c, 'error') || {}).code); }
  ok(codes.slice(0, 10).every(x => x === 'ok') && codes[10] === 'RATE_LIMIT', '6. tao 10 phong duoc, phong thu 11 bi tu choi: ' + codes.slice(8).join(','));
  srv.kill('SIGKILL'); await wait(300);
  // 2. server riêng: tắt 1 giây sau tin cuối -> vẫn lưu được (mốc lưu định kỳ là 5 giây)
  let log2 = ''; const srv2 = spawn('node', ['server.js'], { cwd: ROOT, env: Object.assign({}, process.env, { PORT: '8798', UPSTASH_REDIS_REST_URL: 'http://localhost:8790', UPSTASH_REDIS_REST_TOKEN: 'test-token' }) });
  srv2.stdout.on('data', d => log2 += d); await wait(1300); const U2 = 'ws://localhost:8798';
  const gm = await open({}, U2); await S(gm, { t: 'create' }); const { code } = last(gm, 'created') || {};
  const p = await open({}, U2); await S(p, { t: 'join', code, name: 'An' }); await S(gm, { t: 'chat', ch: 'public', text: 'tin cuoi truoc khi tat' }); await wait(500);
  srv2.kill('SIGTERM'); await wait(1500);
  const st = await statsMock();
  ok(code && st.keys.includes('lxn:room:' + code) && /da luu \d+ muc/.test(log2), `2. tat server 1 giay sau tin cuoi -> phong ${code} DA LUU len Upstash`);
  ok(p.closeCode === 1012, `2. may nguoi choi nhan ma 1012 (server khoi dong lai -> tu noi lai): ${p.closeCode}`);
  mock.kill(); process.exit(0);
})();
