// =====================================================================
//  Làng Xí Nghiệp Nợ — server phòng chơi online (Giai đoạn 1: sảnh chờ)
//  - Quản trò tạo phòng, người chơi vào bằng tên + mã phòng
//  - Khoá phòng khi quản trò bắt đầu: người MỚI bị từ chối, người CŨ vẫn vào lại được
//  - Rớt mạng thì tự vào lại bằng mã định danh (token) lưu trên máy
//  - Server KHÔNG giữ dữ liệu ván: máy quản trò giữ hết. Server khởi động lại thì
//    máy quản trò tự dựng lại phòng (restore).
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
    return { code, gmToken, gm: null, locked: false, players: new Map(), createdAt: Date.now(), lastActive: Date.now() };
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
        case 'ping': return send(ws, { t: 'pong' });
        default: return err(ws, 'UNKNOWN', 'Lệnh không hợp lệ');
    }
}

// ---------------- HTTP (để Render kiểm tra sức khoẻ + đánh thức server) ----------------
const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
    res.end(`Lang Xi Nghiep No server OK — ${rooms.size} phòng\n`);
});
const wss = new WebSocketServer({ server, maxPayload: 16 * 1024 });

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
