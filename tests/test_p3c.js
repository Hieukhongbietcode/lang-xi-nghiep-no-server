const WebSocket = require('ws');
const open = () => new Promise(r => { const w = new WebSocket('ws://localhost:8787'); w.inbox = []; w.on('message', d => w.inbox.push(JSON.parse(d))); w.on('open', () => r(w)); });
const wait = ms => new Promise(r => setTimeout(r, ms)); const last = (w, t) => [...w.inbox].reverse().find(m => m.t === t);
const S = async (w, o) => { w.send(JSON.stringify(o)); await wait(110); }; const ok = (c, m) => console.log((c ? '  ✅ ' : '  ❌ ') + m);
const saw = (w, text) => w.inbox.some(m => m.t === 'chat' && m.m.text === text);
(async () => {
  const gm = await open(); await S(gm, { t: 'create' }); const { code } = last(gm, 'created');
  const P = {}; for (const n of ['A', 'B', 'Cam', 'Chet', 'Soi1', 'Soi2']) { const w = await open(); await S(w, { t: 'join', code, name: n }); w.me = last(w, 'joined'); P[n] = w; }
  const id = n => P[n].me.playerId; await S(gm, { t: 'lock', locked: true });
  await S(gm, { t: 'perm', perm: { public: [id('A'), id('B'), id('Soi1'), id('Soi2')], muted: [id('Cam')], dead: [id('Chet')] } });
  await S(P.Cam, { t: 'chat', ch: 'public', text: 'cam noi' }); ok(last(P.Cam, 'error')?.code === 'CHAT_LOCKED', 'nguoi bi cam noi -> khong noi duoc kenh Lang');
  await S(P.Cam, { t: 'chat', ch: 'muted', text: 'toi bi oan' });
  ok(saw(gm, 'toi bi oan') && saw(P.Chet, 'toi bi oan') && saw(P.Cam, 'toi bi oan') && !['A','B','Soi1'].some(n => saw(P[n], 'toi bi oan')), 'kenh 🤐: chi quan tro + nguoi chet (+ chinh minh) thay');
  await S(gm, { t: 'slow', sec: 5 }); ok(last(P.A, 'chat_perm').slow === 5, 'quan tro bat che do cham 5 giay -> nguoi choi biet');
  await S(P.A, { t: 'chat', ch: 'public', text: 'tin 1' }); await S(P.A, { t: 'chat', ch: 'public', text: 'tin 2' });
  ok(saw(P.B, 'tin 1') && !saw(P.B, 'tin 2') && /Chế độ chậm/.test(last(P.A, 'error').msg), 'che do cham: tin thu 2 lien tiep bi chan: "' + last(P.A, 'error').msg + '"');
  await S(gm, { t: 'slow', sec: 0 });
  const mid = last(P.B, 'chat').m.id;
  await S(P.B, { t: 'react', id: mid, emo: '👍' }); await S(P.Soi1, { t: 'react', id: mid, emo: '👍' });
  ok(last(P.A, 'react')?.r['👍'].length === 2 && last(gm, 'react')?.r['👍'].length === 2, 'tha 👍: moi nguoi thay 2 luot');
  await S(P.B, { t: 'react', id: mid, emo: '👍' }); ok(last(P.A, 'react').r['👍'].length === 1, 'bam lai -> bo bieu cam (con 1)');
  await S(P.Cam, { t: 'react', id: mid, emo: '😂' }); ok(last(P.Cam, 'error')?.code === 'CHAT_LOCKED', 'nguoi bi cam noi khong tha bieu cam duoc');
  await S(gm, { t: 'perm', perm: { wolves: [id('Soi1'), id('Soi2')], dm: [id('A')] } });
  await S(P.Soi1, { t: 'typing', ch: 'wolves' }); await S(P.A, { t: 'typing', ch: 'dm' });
  ok(last(gm, 'typing') && P.Soi2.inbox.some(m => m.t === 'typing' && m.name === 'Soi1') && !P.B.inbox.some(m => m.t === 'typing'), '"dang go": Soi2 + quan tro thay Soi1 dang go; nguoi khac khong');
  ok(gm.inbox.some(m => m.t === 'typing' && m.name === 'A' && m.ch === 'dm') && !P.Soi1.inbox.some(m => m.t === 'typing' && m.name === 'A'), '"dang go" kenh rieng: chi quan tro thay');
  await S(P.B, { t: 'typing', ch: 'wolves' }); ok(!P.Soi1.inbox.some(m => m.t === 'typing' && m.name === 'B'), 'nguoi khong co quyen gui "dang go" -> bi bo qua');
  process.exit(0);
})();
