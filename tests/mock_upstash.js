// Upstash REST giả (chỉ để test): POST /pipeline, cần đúng Bearer token
const http = require('http'); const store = new Map(); let calls = 0;
http.createServer((req, res) => {
  let body = ''; req.on('data', d => body += d); req.on('end', () => {
    if (req.headers.authorization !== 'Bearer test-token') { res.writeHead(401); return res.end('{"error":"unauthorized"}'); }
    if (req.url === '/stats') { res.end(JSON.stringify({ keys: [...store.keys()], calls })); return; }
    const cmds = JSON.parse(body || '[]'); calls += cmds.length;
    const out = cmds.map(([c, ...a]) => { c = c.toUpperCase();
      if (c === 'SET') { store.set(a[0], a[1]); return { result: 'OK' }; }
      if (c === 'GET') return { result: store.get(a[0]) ?? null };
      if (c === 'MGET') return { result: a.map(k => store.get(k) ?? null) };
      if (c === 'DEL') { store.delete(a[0]); return { result: 1 }; }
      if (c === 'KEYS') { const re = new RegExp('^' + a[0].replace(/\*/g, '.*') + '$'); return { result: [...store.keys()].filter(k => re.test(k)) }; }
      return { error: 'unknown ' + c }; });
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(out));
  });
}).listen(8790, () => console.log('mock upstash 8790'));
