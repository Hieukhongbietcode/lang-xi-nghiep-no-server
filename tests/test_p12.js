const WebSocket = require('ws');
const open = () => new Promise(r => { const w = new WebSocket('ws://localhost:8787'); w.inbox = []; w.on('message', d => w.inbox.push(JSON.parse(d))); w.on('open', () => r(w)); });
const wait = ms => new Promise(r => setTimeout(r, ms)); const last = (w, t) => [...w.inbox].reverse().find(m => m.t === t);
const S = async (w, o) => { w.send(JSON.stringify(o)); await wait(120); }; const ok = (c, m) => console.log((c ? '  ✅ ' : '  ❌ ') + m);
const saw = (w, text) => w.inbox.some(m => (m.t === 'chat' && m.m.text === text) || (m.t === 'chat_hist' && m.list.some(x => x.text === text)));
(async () => {
  const gm = await open(); await S(gm, { t: 'create' }); const { code } = last(gm, 'created');
  const a = await open(); await S(a, { t: 'join', code, name: 'An' });
  const b = await open(); await S(b, { t: 'join', code, name: 'Bình' });
  ok(last(a, 'chat_perm')?.can.public === true, 'sanh cho (chua khoa): duoc chat');
  await S(a, { t: 'chat', ch: 'public', text: 'chao ca nha' }); ok(saw(b, 'chao ca nha') && saw(gm, 'chao ca nha'), 'chat sanh cho: Binh + quan tro thay');
  await S(gm, { t: 'lock', locked: true }); ok(last(a, 'chat_perm')?.can.public === false, 'khoa phong -> chat Lang theo luot quan tro (dang dong)');
  // xin vào phòng đã khoá
  const c = await open(); await S(c, { t: 'join', code, name: 'Cường' }); ok(last(c, 'error')?.code === 'LOCKED_KNOCK', 'nguoi moi -> duoc moi "xin vao choi"');
  await S(c, { t: 'join', code, name: 'Cường', knock: true }); ok(last(c, 'knock_wait') && last(gm, 'knock')?.name === 'Cường', 'Cuong xin vao -> quan tro nhan yeu cau');
  await S(gm, { t: 'admit', reqId: last(gm, 'knock').reqId, ok: true }); ok(last(c, 'joined')?.name === 'Cường' && last(gm, 'gm_state').players.length === 3, 'quan tro dong y -> Cuong vao choi (3 nguoi)');
  const d = await open(); await S(d, { t: 'join', code, name: 'Dũng', knock: true }); await S(gm, { t: 'admit', reqId: last(gm, 'knock').reqId, ok: false });
  ok(last(d, 'error')?.code === 'KNOCK_DENIED', 'quan tro tu choi -> Dung bi bao "chua cho vao"');
  // đã chia bài -> khoá hẳn
  await S(gm, { t: 'final', on: true });
  const e = await open(); await S(e, { t: 'join', code, name: 'Én', knock: true }); ok(last(e, 'error')?.code === 'LOCKED_FINAL', 'da chia bai -> khong ai xin vao choi duoc nua: "' + last(e, 'error').msg + '"');
  // khán giả
  await S(e, { t: 'join', code, name: 'Én', spectate: true }); ok(last(e, 'joined')?.spec === true, 'van vao XEM duoc (khan gia)');
  ok(last(gm, 'roster').spec.some(x => x.name === 'Én'), 'quan tro thay danh sach khan gia');
  await S(gm, { t: 'to', to: last(a, 'joined').playerId, keep: 'card', data: { kind: 'card', role: { name: 'Tiên Tri' } } });
  ok(!JSON.stringify(e.inbox).includes('Tiên Tri'), 'khan gia KHONG nhan duoc la bai cua ai');
  await S(gm, { t: 'perm', perm: { public: [last(a, 'joined').playerId] } }); await S(a, { t: 'chat', ch: 'public', text: 'ban ngay' });
  ok(saw(e, 'ban ngay'), 'khan gia doc duoc kenh Lang');
  await S(e, { t: 'chat', ch: 'public', text: 'khan gia noi' }); ok(!saw(a, 'khan gia noi'), 'khan gia KHONG noi duoc');
  const e2 = await open(); e.close(); await wait(100); await S(e2, { t: 'resume', code, token: last(e, 'joined').token });
  ok(last(e2, 'joined')?.spec && last(e2, 'chat_hist').list.some(m => m.text === 'ban ngay'), 'khan gia tai lai trang -> vao lai, con lich su kenh Lang');
  // chất lượng mạng
  await wait(15500); ok(last(gm, 'net')?.list.length === 3, 'quan tro nhan bao cao mang: ' + JSON.stringify(last(gm, 'net').list.map(x => x.rtt)));
  b.close(); await wait(200); ok(last(gm, 'roster').players.find(x => x.name === 'Bình').off > 0, 'Binh mat ket noi -> quan tro biet thoi diem offline');
  process.exit(0);
})();
