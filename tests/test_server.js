const WebSocket = require('ws');
const URL = 'ws://localhost:8787';
const open = () => new Promise(r => { const w = new WebSocket(URL); w.inbox = []; w.on('message', d => w.inbox.push(JSON.parse(d))); w.on('open', () => r(w)); });
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const last = (w, t) => [...w.inbox].reverse().find(m => !t || m.t === t);
const sendw = async (w, o) => { w.send(JSON.stringify(o)); await wait(120); };
const ok = (c, msg) => console.log((c ? '  ✅ ' : '  ❌ ') + msg);
(async () => {
  const gm = await open(); await sendw(gm, { t: 'create' });
  const { code, gmToken } = last(gm, 'created'); ok(/^[A-Z2-9]{5}$/.test(code), 'tao phong, ma = ' + code);
  const a = await open(); await sendw(a, { t: 'join', code: code.toLowerCase(), name: '  Minh  ' });
  ok(last(a, 'joined')?.name === 'Minh', 'Minh vao duoc (ma viet thuong, ten co khoang trang)');
  const b = await open(); await sendw(b, { t: 'join', code, name: 'Lan' });
  ok(last(gm, 'roster').players.length === 2, 'quan tro thay 2 nguoi: ' + last(gm, 'roster').players.map(p=>p.name+(p.online?'●':'○')).join(', '));
  const c = await open(); await sendw(c, { t: 'join', code, name: 'minh' }); ok(last(c, 'error')?.code === 'NAME_TAKEN', 'ten trung (khong phan biet hoa thuong) bi tu choi: ' + last(c,'error').msg);
  await sendw(c, { t: 'join', code: 'ZZZZZ', name: 'X' }); ok(last(c, 'error')?.code === 'NO_ROOM', 'sai ma phong: ' + last(c,'error').msg);
  await sendw(c, { t: 'join', code, name: '   ' }); ok(last(c, 'error')?.code === 'BAD_NAME', 'ten rong bi tu choi');
  await sendw(b, { t: 'lock', locked: true }); ok(last(b, 'error')?.code === 'NOT_GM', 'nguoi choi khong khoa phong duoc');
  // mời ra trước khi khoá
  await sendw(c, { t: 'join', code, name: 'Khach' }); const kid = last(c, 'joined').playerId;
  await sendw(gm, { t: 'kick', playerId: kid }); await wait(100);
  ok(c.inbox.some(m => m.t === 'kicked') && last(gm, 'roster').players.length === 2, 'quan tro moi Khach ra');
  // khoá
  await sendw(gm, { t: 'lock', locked: true }); ok(last(a, 'roster').locked === true, 'khoa phong, nguoi choi biet phong da khoa');
  const d = await open(); await sendw(d, { t: 'join', code, name: 'Moi' }); ok(last(d, 'error')?.code === 'LOCKED_KNOCK', 'nguoi MOI vao phong da khoa -> duoc moi xin vao: "' + last(d,'error').msg + '"');
  // người cũ rớt mạng rồi vào lại
  const aTok = last(a, 'joined').token; a.close(); await wait(200);
  ok(last(gm, 'roster').players.find(p => p.name === 'Minh').online === false, 'Minh rot mang -> quan tro thay offline');
  const a2 = await open(); await sendw(a2, { t: 'resume', code, token: aTok });
  ok(last(a2, 'joined')?.resumed && last(gm, 'roster').players.find(p => p.name === 'Minh').online, 'Minh vao lai du phong da khoa');
  await sendw(a2, { t: 'resume', code, token: 'gia-mao' }); ok(last(a2, 'error')?.code === 'NOT_MEMBER', 'token gia mao bi tu choi');
  await sendw(gm, { t: 'kick', playerId: last(gm,'roster').players[0].id }); ok(last(gm, 'error')?.code === 'LOCKED', 'da khoa thi khong moi ra duoc');
  // quản trò tải lại trang
  gm.close(); await wait(150); ok(last(a2, 'roster').gmOnline === false, 'nguoi choi biet quan tro mat ket noi');
  const gm2 = await open(); await sendw(gm2, { t: 'gm_resume', code, gmToken });
  ok(last(gm2, 'gm_state')?.players.length === 2 && last(a2,'roster').gmOnline, 'quan tro vao lai, giu nguyen 2 nguoi');
  await sendw(gm2, { t: 'gm_resume', code, gmToken: 'sai' }); ok(last(gm2, 'error')?.code === 'BAD_TOKEN', 'ma quan tro gia mao bi tu choi');
  // spam thử mã phòng
  const e = await open(); for (let i = 0; i < 22; i++) e.send(JSON.stringify({ t: 'join', code: 'AAAAA', name: 'x' })); await wait(300);
  ok(last(e, 'error')?.code === 'SLOW_DOWN', 'do ma phong lien tuc bi chan sau 20 lan');
  // gói tin quá lớn
  const f = await open(); let closed = false; f.on('close', () => closed = true); f.send('x'.repeat(70000)); await wait(200); ok(closed, 'goi tin qua lon bi ngat');
  console.log('GM_STATE=' + JSON.stringify(last(gm2, 'gm_state')));
  console.log('CODE=' + code + ' GMTOKEN=' + gmToken + ' ATOKEN=' + aTok);
  process.exit(0);
})();
