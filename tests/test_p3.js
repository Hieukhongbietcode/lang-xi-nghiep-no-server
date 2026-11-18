const WebSocket = require('ws');
const open = () => new Promise(r => { const w = new WebSocket('ws://localhost:8787'); w.inbox = []; w.on('message', d => w.inbox.push(JSON.parse(d))); w.on('open', () => r(w)); });
const wait = ms => new Promise(r => setTimeout(r, ms)); const last = (w, t) => [...w.inbox].reverse().find(m => m.t === t);
const S = async (w, o) => { w.send(JSON.stringify(o)); await wait(110); }; const ok = (c, m) => console.log((c ? '  ✅ ' : '  ❌ ') + m);
const saw = (w, text) => w.inbox.some(m => (m.t === 'chat' && m.m.text === text) || (m.t === 'chat_hist' && m.list.some(x => x.text === text)));
(async () => {
  const gm = await open(); await S(gm, { t: 'create' }); const { code } = last(gm, 'created');
  const P = {}; for (const n of ['Soi1', 'Soi2', 'Dan', 'TienTri', 'Chet']) { const w = await open(); await S(w, { t: 'join', code, name: n }); w.me = last(w, 'joined'); P[n] = w; }
  const id = n => P[n].me.playerId;
  await S(gm, { t: 'lock', locked: true });
  // ĐÊM: bước Đàn Sói. Sói chat; Tiên Tri không; người chết chat kênh chết
  await S(gm, { t: 'perm', label: '🌙 Đêm 1', perm: { wolves: [id('Soi1'), id('Soi2')], dead: [id('Chet')] } });
  ok(last(P.Soi1, 'chat_perm').can.wolves && !last(P.Dan, 'chat_perm').can.wolves, 'Soi1 duoc chat kenh Soi, Dan thi khong');
  await S(P.Soi1, { t: 'chat', ch: 'wolves', text: 'can Dan di' });
  ok(saw(P.Soi2, 'can Dan di') && saw(gm, 'can Dan di'), 'Soi2 va quan tro doc duoc tin Soi');
  ok(!saw(P.Dan, 'can Dan di') && !saw(P.TienTri, 'can Dan di') && !saw(P.Chet, 'can Dan di'), 'Dan, Tien Tri, nguoi chet KHONG doc duoc tin Soi');
  await S(P.Dan, { t: 'chat', ch: 'wolves', text: 'gia lam soi' });
  ok(last(P.Dan, 'error')?.code === 'CHAT_LOCKED' && !saw(P.Soi1, 'gia lam soi'), 'Dan co gui vao kenh Soi -> bi chan');
  await S(P.Dan, { t: 'chat', ch: 'public', text: 'noi dem' });
  ok(last(P.Dan, 'error')?.code === 'CHAT_LOCKED', 'ban dem Dan noi kenh Lang -> bi chan');
  await S(P.Chet, { t: 'chat', ch: 'dead', text: 'toi bi can' });
  ok(saw(gm, 'toi bi can') && !['Soi1','Soi2','Dan','TienTri'].some(n => saw(P[n], 'toi bi can')), 'nguoi chet chat -> chi quan tro thay (khong ai con song thay)');
  // ĐÊM: bước Tiên Tri -> hỏi quản trò
  await S(gm, { t: 'perm', perm: { dm: [id('TienTri')], dead: [id('Chet')] } });
  await S(P.TienTri, { t: 'chat', ch: 'dm', text: 'soi Soi1' });
  ok(saw(gm, 'soi Soi1') && !['Soi1','Soi2','Dan','Chet'].some(n => saw(P[n], 'soi Soi1')), 'Tien Tri hoi rieng quan tro -> khong ai khac thay');
  await S(gm, { t: 'chat', ch: 'dm', to: id('TienTri'), text: 'Soi1 la SOI' });
  ok(saw(P.TienTri, 'Soi1 la SOI') && !['Soi1','Soi2','Dan','Chet'].some(n => saw(P[n], 'Soi1 la SOI')), 'quan tro tra loi rieng Tien Tri -> chi Tien Tri thay');
  await S(P.Soi1, { t: 'chat', ch: 'wolves', text: 'het luot' });
  ok(last(P.Soi1, 'error')?.code === 'CHAT_LOCKED', 'het buoc Dan Soi -> Soi khong chat duoc nua');
  // NGÀY: thảo luận
  await S(gm, { t: 'perm', label: '☀️ Thảo luận', perm: { public: ['Soi1','Soi2','Dan','TienTri'].map(id), dead: [id('Chet')] } });
  await S(P.Dan, { t: 'chat', ch: 'public', text: 'Soi1 dang nghi' });
  ok(['Soi1','Soi2','TienTri','Chet'].every(n => saw(P[n], 'Soi1 dang nghi')) && saw(gm, 'Soi1 dang nghi'), 'thao luan: ca lang (ke ca nguoi chet) doc duoc');
  await S(P.Chet, { t: 'chat', ch: 'public', text: 'nguoi chet noi' });
  ok(last(P.Chet, 'error')?.code === 'CHAT_LOCKED', 'nguoi chet KHONG noi duoc o kenh Lang');
  // spam + độ dài
  for (let i = 0; i < 7; i++) P.Soi2.send(JSON.stringify({ t: 'chat', ch: 'public', text: 'spam' + i })); await wait(300);
  ok(last(P.Soi2, 'error')?.code === 'CHAT_SLOW', 'nhan qua nhanh (7 tin/10 giay) -> bi chan');
  await S(P.Dan, { t: 'chat', ch: 'public', text: 'x'.repeat(500) });
  ok(last(P.Dan, 'chat').m.text.length === 300, 'tin qua dai bi cat con 300 ky tu');
  // vào lại: chỉ thấy lại đúng tin của mình
  P.Dan.close(); await wait(100); const d2 = await open(); await S(d2, { t: 'resume', code, token: P.Dan.me.token });
  const h = last(d2, 'chat_hist').list.map(m => m.text);
  ok(h.includes('Soi1 dang nghi') && !h.includes('can Dan di') && !h.includes('soi Soi1') && !h.includes('toi bi can'), 'Dan vao lai: lich su chi co tin Dan duoc xem (khong co tin Soi / rieng / nguoi chet)');
  const s2 = await open(); P.Soi2.close(); await wait(100); await S(s2, { t: 'resume', code, token: P.Soi2.me.token });
  ok(last(s2, 'chat_hist').list.some(m => m.text === 'can Dan di'), 'Soi2 vao lai: van thay lai tin cua bay Soi');
  const g2 = await open(); await S(g2, { t: 'gm_resume', code, gmToken: last(gm, 'created').gmToken });
  ok(['can Dan di', 'toi bi can', 'soi Soi1', 'Soi1 la SOI', 'Soi1 dang nghi'].every(t => last(g2, 'chat_hist').list.some(m => m.text === t)), 'quan tro vao lai: thay lai TOAN BO lich su');
  process.exit(0);
})();
