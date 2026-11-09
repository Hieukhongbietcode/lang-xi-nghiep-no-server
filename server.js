// =====================================================================
//  Làng Xí Nghiệp Nợ — server phòng chơi online (GĐ1: sảnh chờ · GĐ2: chia bài · GĐ3: chat)
//  - Quản trò tạo phòng, người chơi vào bằng tên + mã phòng
//  - Khoá phòng khi quản trò bắt đầu: người MỚI bị từ chối, người CŨ vẫn vào lại được
//  - Rớt mạng thì tự vào lại bằng mã định danh (token) lưu trên máy
//  - Server KHÔNG giữ dữ liệu ván: máy quản trò giữ hết. Server khởi động lại thì
//    máy quản trò tự dựng lại phòng (restore).
//  - Tin riêng (lá bài...) CHỈ gửi tới đúng người nhận, không bao giờ gửi cả phòng.
//  - Chat: quản trò báo "ai được nói ở kênh nào" theo từng bước; server tự chặn tin sai lượt
//    và chỉ gửi tin tới đúng người được phép đọc.
// =====================================================================
const http = require('http');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8080;
const MAX_PLAYERS = 60;
const MAX_NAME = 20;
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // bỏ chữ dễ nhầm: I, L, O, 0, 1
const CODE_LEN = 5;
const ROOM_IDLE_MS = 30 * 60 * 1000;   // phòng không ai kết nối 30 phút -> xoá
const ROOM_MAX_MS = 12 * 60 * 60 * 1000; // phòng sống tối đa 12 giờ
const JOIN_LIMIT = 20;                 // tối đa 20 lần thử vào phòng / phút / kết nối

const rooms = new Map(); // code -> room

const rnd = (n) => crypto.randomBytes(n).toString('hex');
function newCode() {
    for (let k = 0; k < 1000; k++) {
        let c = '';
        const b = crypto.randomBytes(CODE_LEN);
        for (let i = 0; i < CODE_LEN; i++) c += CODE_CHARS[b[i] % CODE_CHARS.length];
        if (!rooms.has(c)) return c;
    }
    throw new Error('Không tạo được mã phòng');
}
const normCode = (c) => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, CODE_LEN);
const normName = (n) => String(n || '').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME);
const nameKey = (n) => normName(n).toLocaleLowerCase('vi');

function makeRoom(code, gmToken) {
    return { code, gmToken, gm: null, locked: false, players: new Map(), keptAll: {}, perm: emptyPerm(), label: '', log: [], createdAt: Date.now(), lastActive: Date.now() };
}
function send(ws, obj) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); }
function rosterOf(room) {
    return [...room.players.values()].map(p => ({ id: p.id, name: p.name, online: !!(p.ws && p.ws.readyState === 1) }));
}
function broadcastRoster(room) {
    const msg = { t: 'roster', code: room.code, locked: room.locked, gmOnline: !!(room.gm && room.gm.readyState === 1), players: rosterOf(room) };
    send(room.gm, msg);
    for (const p of room.players.values()) send(p.ws, msg);
}
// Thông tin đầy đủ (kèm token) chỉ gửi cho quản trò, để quản trò dựng lại phòng nếu server khởi động lại
function gmRoster(room) {
    return [...room.players.values()].map(p => ({ id: p.id, name: p.name, token: p.token }));
}
function sendGmState(room) {
    send(room.gm, { t: 'gm_state', code: room.code, locked: room.locked, players: gmRoster(room) });
}
function touch(room) { room.lastActive = Date.now(); }

function attachGm(room, ws) {
    if (room.gm && room.gm !== ws && room.gm.readyState === 1) {
        send(room.gm, { t: 'gm_replaced' }); // quản trò mở ở tab/máy khác
        try { room.gm.close(4000, 'replaced'); } catch (e) {}
    }
    room.gm = ws; ws.role = 'gm'; ws.room = room.code;
    touch(room);
}
function attachPlayer(room, p, ws) {
    if (p.ws && p.ws !== ws && p.ws.readyState === 1) {
        send(p.ws, { t: 'replaced' }); // cùng người mở ở tab/máy khác
        try { p.ws.close(4000, 'replaced'); } catch (e) {}
    }
    p.ws = ws; ws.role = 'player'; ws.room = room.code; ws.pid = p.id;
    touch(room);
}
function err(ws, code, msg) { send(ws, { t: 'error', code, msg }); }
// Gửi lại các tin quản trò đã "giữ" (lá bài, trạng thái ván) cho người vừa vào lại
function replayKept(room, p) {
    for (const data of Object.values(room.keptAll || {})) send(p.ws, { t: 'msg', from: 'gm', data });
    for (const data of Object.values(p.kept || {})) send(p.ws, { t: 'msg', from: 'gm', data });
}
const KEEP_RE = /^[a-z_]{1,20}$/;

// ---------------- CHAT (Giai đoạn 3) ----------------
const CHANNELS = ['public', 'wolves', 'couple', 'dead', 'dm'];
const CHAT_MAX = 300, CHAT_RATE = 6, CHAT_WINDOW = 10000, LOG_MAX = 600;
function emptyPerm() { const p = {}; CHANNELS.forEach(c => p[c] = new Set()); return p; }
function permFor(room, pid) {
    const can = {}; CHANNELS.forEach(c => can[c] = room.perm[c].has(pid)); return can;
}
function sendPerm(room, p) { send(p.ws, { t: 'chat_perm', can: permFor(room, p.id), label: room.label || '' }); }
// Ai được nhận tin ở kênh này (người chơi). Quản trò luôn nhận.
function readersOf(room, ch, pid) {
    if (ch === 'public') return [...room.players.keys()];       // cả làng (kể cả người chết) đọc được kênh Làng
    if (ch === 'dm') return pid ? [pid] : [];                   // nhắn riêng: chỉ người đó + quản trò
    return [...room.perm[ch]];                                   // Sói / Cặp đôi / Người chết: chỉ thành viên kênh
}
function deliverChat(room, msg, readers) {
    msg.to = readers;
    room.log.push(msg); if (room.log.length > LOG_MAX) room.log.splice(0, room.log.length - LOG_MAX);
    const out = { t: 'chat', m: publicMsg(msg) };
    send(room.gm, out);
    for (const id of readers) { const p = room.players.get(id); if (p) send(p.ws, out); }
}
function publicMsg(m) { return { id: m.id, ch: m.ch, from: m.from, name: m.name, text: m.text, ts: m.ts, dm: m.dm }; }
function historyFor(room, pid) { return room.log.filter(m => pid === 'gm' || m.to.includes(pid)).map(publicMsg); }
function cleanText(t) { return String(t || '').replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '').replace(/\s+\n/g, '\n').trim().slice(0, CHAT_MAX); }

function handle(ws, m) {
    const room = ws.room ? rooms.get(ws.room) : null;
    switch (m.t) {
        // ---------------- QUẢN TRÒ ----------------
        case 'create': {
            const code = newCode(), gmToken = rnd(16);
            const r = makeRoom(code, gmToken); rooms.set(code, r);
            attachGm(r, ws);
            send(ws, { t: 'created', code, gmToken });
            sendGmState(r); broadcastRoster(r);
            return;
        }
        case 'gm_resume': {
            const r = rooms.get(normCode(m.code));
            if (!r) return err(ws, 'NO_ROOM', 'Phòng không còn trên server');
            if (r.gmToken !== m.gmToken) return err(ws, 'BAD_TOKEN', 'Sai mã quản trò');
            attachGm(r, ws);
            send(ws, { t: 'gm_ok', code: r.code });
            sendGmState(r); broadcastRoster(r);
            send(ws, { t: 'chat_hist', list: historyFor(r, 'gm') });
            return;
        }
        case 'restore': { // server đã khởi động lại: quản trò dựng lại phòng từ dữ liệu trên máy
            const code = normCode(m.code);
            if (!code || typeof m.gmToken !== 'string' || m.gmToken.length < 16) return err(ws, 'BAD_RESTORE', 'Dữ liệu dựng lại phòng không hợp lệ');
            let r = rooms.get(code);
            if (r && r.gmToken !== m.gmToken) return err(ws, 'CODE_TAKEN', 'Mã phòng đã bị dùng');
            if (!r) {
                r = makeRoom(code, m.gmToken); r.locked = !!m.locked;
                (Array.isArray(m.players) ? m.players : []).slice(0, MAX_PLAYERS).forEach(pl => {
                    const name = normName(pl.name);
                    if (!name || typeof pl.id !== 'string' || typeof pl.token !== 'string') return;
                    r.players.set(pl.id, { id: pl.id, name, token: pl.token, ws: null });
                });
                rooms.set(code, r);
            }
            attachGm(r, ws);
            send(ws, { t: 'gm_ok', code: r.code, restored: true });
            sendGmState(r); broadcastRoster(r);
            return;
        }
        case 'lock':
        case 'kick':
        case 'close': {
            if (!room || ws.role !== 'gm' || room.gm !== ws) return err(ws, 'NOT_GM', 'Chỉ quản trò mới làm được');
            touch(room);
            if (m.t === 'lock') { room.locked = !!m.locked; sendGmState(room); broadcastRoster(room); return; }
            if (m.t === 'kick') {
                if (room.locked) return err(ws, 'LOCKED', 'Phòng đã khoá, không mời ra được');
                const p = room.players.get(m.playerId); if (!p) return;
                send(p.ws, { t: 'kicked' });
                if (p.ws) { p.ws.room = null; try { p.ws.close(4001, 'kicked'); } catch (e) {} }
                room.players.delete(p.id);
                sendGmState(room); broadcastRoster(room); return;
            }
            // close
            for (const p of room.players.values()) { send(p.ws, { t: 'room_closed' }); if (p.ws) p.ws.room = null; }
            rooms.delete(room.code); ws.room = null;
            send(ws, { t: 'closed' });
            return;
        }
        // ---------------- NGƯỜI CHƠI ----------------
        case 'join': {
            ws.joinTries = (ws.joinTries || []).filter(t => Date.now() - t < 60000);
            if (ws.joinTries.length >= JOIN_LIMIT) return err(ws, 'SLOW_DOWN', 'Thử quá nhiều lần, đợi 1 phút');
            ws.joinTries.push(Date.now());
            const r = rooms.get(normCode(m.code));
            if (!r) return err(ws, 'NO_ROOM', 'Không tìm thấy phòng. Kiểm tra lại mã phòng.');
            if (r.locked) return err(ws, 'LOCKED', 'Game đã được bắt đầu');
            const name = normName(m.name);
            if (!name) return err(ws, 'BAD_NAME', 'Hãy nhập tên hiển thị');
            if ([...r.players.values()].some(p => nameKey(p.name) === nameKey(name))) return err(ws, 'NAME_TAKEN', `Tên "${name}" đã có người dùng trong phòng`);
            if (r.players.size >= MAX_PLAYERS) return err(ws, 'FULL', 'Phòng đã đủ người');
            const p = { id: 'u' + rnd(6), name, token: rnd(16), ws: null };
            r.players.set(p.id, p); attachPlayer(r, p, ws);
            send(ws, { t: 'joined', code: r.code, playerId: p.id, token: p.token, name: p.name });
            sendGmState(r); broadcastRoster(r);
            return;
        }
        case 'resume': {
            const r = rooms.get(normCode(m.code));
            if (!r) return err(ws, 'NO_ROOM_RESUME', 'Phòng không còn trên server');
            const p = [...r.players.values()].find(x => x.token === m.token);
            if (!p) return err(ws, 'NOT_MEMBER', 'Bạn không còn trong phòng này');
            attachPlayer(r, p, ws); // phòng đã khoá vẫn cho người CŨ vào lại
            send(ws, { t: 'joined', code: r.code, playerId: p.id, token: p.token, name: p.name, resumed: true });
            broadcastRoster(r);
            replayKept(r, p);
            sendPerm(r, p);
            send(ws, { t: 'chat_hist', list: historyFor(r, p.id) });
            return;
        }
        case 'leave': {
            if (!room || ws.role !== 'player') return;
            if (room.locked) { // đã khoá: chỉ ngắt kết nối, vẫn giữ chỗ
                ws.room = null; broadcastRoster(room); return;
            }
            room.players.delete(ws.pid); ws.room = null;
            sendGmState(room); broadcastRoster(room);
            return;
        }
        // ---------------- TIN RIÊNG (Giai đoạn 2) ----------------
        case 'to': {   // quản trò -> 1 người chơi
            if (!room || ws.role !== 'gm' || room.gm !== ws) return err(ws, 'NOT_GM', 'Chỉ quản trò mới gửi được');
            const p = room.players.get(m.to); if (!p || !m.data || typeof m.data !== 'object') return;
            if (typeof m.keep === 'string' && KEEP_RE.test(m.keep)) { p.kept = p.kept || {}; p.kept[m.keep] = m.data; }
            send(p.ws, { t: 'msg', from: 'gm', data: m.data }); touch(room);
            return;
        }
        case 'all': {  // quản trò -> cả phòng (chỉ dùng cho tin công khai)
            if (!room || ws.role !== 'gm' || room.gm !== ws) return err(ws, 'NOT_GM', 'Chỉ quản trò mới gửi được');
            if (!m.data || typeof m.data !== 'object') return;
            if (typeof m.keep === 'string' && KEEP_RE.test(m.keep)) room.keptAll[m.keep] = m.data;
            for (const p of room.players.values()) send(p.ws, { t: 'msg', from: 'gm', data: m.data });
            touch(room); return;
        }
        case 'to_gm': { // người chơi -> quản trò
            if (!room || ws.role !== 'player' || !m.data || typeof m.data !== 'object') return;
            send(room.gm, { t: 'msg', from: ws.pid, data: m.data }); touch(room);
            return;
        }
        case 'perm': {   // quản trò báo ai được nói ở kênh nào (gửi lại mỗi khi đổi bước)
            if (!room || ws.role !== 'gm' || room.gm !== ws) return err(ws, 'NOT_GM', 'Chỉ quản trò mới đặt quyền chat');
            const np = emptyPerm();
            CHANNELS.forEach(c => (Array.isArray(m.perm && m.perm[c]) ? m.perm[c] : []).forEach(id => { if (room.players.has(id)) np[c].add(id); }));
            room.perm = np; room.label = String(m.label || '').slice(0, 80);
            for (const p of room.players.values()) sendPerm(room, p);
            return;
        }
        case 'chat': {
            if (!room) return;
            const ch = CHANNELS.includes(m.ch) ? m.ch : null; if (!ch) return err(ws, 'BAD_CH', 'Kênh không hợp lệ');
            const text = cleanText(m.text); if (!text) return;
            const now = Date.now();
            ws.chatTimes = (ws.chatTimes || []).filter(t => now - t < CHAT_WINDOW);
            if (ws.chatTimes.length >= CHAT_RATE) return err(ws, 'CHAT_SLOW', 'Bạn nhắn nhanh quá, chờ vài giây');
            ws.chatTimes.push(now);
            const id = 'm' + rnd(6);
            if (ws.role === 'gm' && room.gm === ws) {
                if (ch === 'dm' && !room.players.has(m.to)) return err(ws, 'BAD_TO', 'Không tìm thấy người nhận');
                deliverChat(room, { id, ch, from: 'gm', name: 'Quản trò', text, ts: now, dm: ch === 'dm' ? m.to : undefined }, readersOf(room, ch, m.to));
                return;
            }
            if (ws.role !== 'player') return;
            const p = room.players.get(ws.pid); if (!p) return;
            if (!room.perm[ch].has(p.id)) return err(ws, 'CHAT_LOCKED', 'Chưa tới lượt bạn chat ở kênh này');
            deliverChat(room, { id, ch, from: p.id, name: p.name, text, ts: now, dm: ch === 'dm' ? p.id : undefined }, readersOf(room, ch, p.id));
            touch(room); return;
        }
        case 'ping': return send(ws, { t: 'pong' });
        default: return err(ws, 'UNKNOWN', 'Lệnh không hợp lệ');
    }
}

// ---------------- HTTP (để Render kiểm tra sức khoẻ + đánh thức server) ----------------
const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
    res.end(`Lang Xi Nghiep No server OK — ${rooms.size} phòng\n`);
});
const wss = new WebSocketServer({ server, maxPayload: 64 * 1024 }); // đủ cho lá bài kèm biểu tượng

wss.on('connection', (ws) => {
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('message', (data) => {
        let m; try { m = JSON.parse(data); } catch (e) { return err(ws, 'BAD_JSON', 'Dữ liệu không hợp lệ'); }
        if (!m || typeof m.t !== 'string') return;
        try { handle(ws, m); } catch (e) { console.error(e); err(ws, 'SERVER', 'Lỗi server'); }
    });
    ws.on('close', () => {
        const room = ws.room ? rooms.get(ws.room) : null;
        if (!room) return;
        if (ws.role === 'gm' && room.gm === ws) room.gm = null;
        if (ws.role === 'player') { const p = room.players.get(ws.pid); if (p && p.ws === ws) p.ws = null; }
        broadcastRoster(room);
    });
});

// Phát hiện kết nối chết (điện thoại khoá màn hình, mất sóng...)
setInterval(() => {
    for (const ws of wss.clients) {
        if (!ws.isAlive) { try { ws.terminate(); } catch (e) {} continue; }
        ws.isAlive = false; try { ws.ping(); } catch (e) {}
    }
}, 20000);
// Dọn phòng bỏ hoang
setInterval(() => {
    const now = Date.now();
    for (const [code, r] of rooms) {
        const anyone = (r.gm && r.gm.readyState === 1) || [...r.players.values()].some(p => p.ws && p.ws.readyState === 1);
        if (anyone) r.lastActive = now;
        if (now - r.lastActive > ROOM_IDLE_MS || now - r.createdAt > ROOM_MAX_MS) rooms.delete(code);
    }
}, 60000);

server.listen(PORT, () => console.log(`Server chạy ở cổng ${PORT}`));
