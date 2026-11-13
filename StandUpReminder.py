import customtkinter as ctk
import tkinter as tk
import os
import re
import sys
import time
import math
import json
import wave
import struct
import random
import socket
import ctypes
import winreg
import winsound
import textwrap
import datetime
import threading
import pystray
from PIL import Image, ImageDraw, ImageFont

# ================= CẤU HÌNH HỆ THỐNG =================
INTERVAL_SECONDS = 30 * 60       # Chu kỳ 30 phút (1800 giây)
IDLE_RESET_SECONDS = 5 * 60      # Tự reset nếu rời máy quá 5 phút
ANTI_REFLEX_SECONDS = 5.0        # Thời gian khóa nút chống bấm nhầm (giây)
LOCK_PORT = 47291                # Cổng khóa chống mở trùng app

# Cấu hình Giờ làm việc (08:00 AM - 05:00 PM theo giờ máy tính)
WORK_SCHEDULE_ENABLED = True     # True = Chỉ nhắc trong khung giờ dưới; False = Nhắc 24/24
WORK_START_HOUR = 8              # 08:00 AM
WORK_START_MIN = 0
WORK_END_HOUR = 17               # 05:00 PM (17:00)
WORK_END_MIN = 0
DAILY_GOAL = 18                  # Mục tiêu số lần đứng dậy trong ngày (9 tiếng = 18 lần)

# Đường dẫn thư mục chứa file .exe (để lưu stats & wav)
APP_DIR = os.path.dirname(os.path.abspath(sys.executable if getattr(sys, 'frozen', False) else __file__))
# Đường dẫn tài nguyên nhúng bên trong .exe (hoặc thư mục hiện tại nếu chạy .py)
RESOURCE_DIR = getattr(sys, '_MEIPASS', APP_DIR)

STATS_FILE = os.path.join(APP_DIR, "standup_stats.json")
CHIME_FILE = os.path.join(APP_DIR, "soft_chime.wav")
CADAO_FILE = os.path.join(RESOURCE_DIR, "cadao.txt")

ctk.set_appearance_mode("Dark")
ctk.set_default_color_theme("blue")

# ================= QUẢN LÝ KHO CA DAO TỤC NGỮ =================
class CaDaoManager:
    def __init__(self, filepath):
        self.filepath = filepath
        self.items = self.load_cadao()
        self.deck = []

    def _read_file_lines(self):
        # Ưu tiên file cadao.txt đặt ngoài cạnh .exe nếu người dùng muốn tự chỉnh sửa thêm câu mới
        external_cadao = os.path.join(APP_DIR, "cadao.txt")
        target_path = external_cadao if os.path.exists(external_cadao) else self.filepath

        for enc in ("utf-8-sig", "utf-8", "utf-16"):
            try:
                with open(target_path, 'r', encoding=enc) as f:
                    return f.readlines()
            except Exception:
                continue
        return []

    def load_cadao(self):
        parsed = []
        for raw_line in self._read_file_lines():
            line = raw_line.strip()
            if not line or ":" not in line:
                continue
            line = re.sub(r'^\d+\.\s*', '', line)
            line = line.replace('**', '').strip()

            quote, meaning = line.split(":", 1)
            quote = quote.strip()
            meaning = meaning.strip()
            if quote and meaning:
                parsed.append((quote, meaning))

        if not parsed:
            parsed.append((
                "Ăn quả nhớ kẻ trồng cây",
                "Câu tục ngữ nhắc nhở con người khi được hưởng thành quả ngọt ngào thì phải biết nhớ ơn những người đã tạo dựng nên nó."
            ))
        return parsed

    def get_next_random(self):
        if not self.deck:
            self.deck = list(self.items)
            random.shuffle(self.deck)
        return self.deck.pop()

# ================= WINDOWS API HELPERS =================
class LASTINPUTINFO(ctypes.Structure):
    _fields_ = [("cbSize", ctypes.c_uint), ("dwTime", ctypes.c_uint)]

def get_idle_duration():
    lii = LASTINPUTINFO()
    lii.cbSize = ctypes.sizeof(LASTINPUTINFO)
    if ctypes.windll.user32.GetLastInputInfo(ctypes.byref(lii)):
        millis = ctypes.windll.kernel32.GetTickCount() - lii.dwTime
        return millis / 1000.0
    return 0

def get_virtual_screen_bounds():
    user32 = ctypes.windll.user32
    left = user32.GetSystemMetrics(76)
    top = user32.GetSystemMetrics(77)
    width = user32.GetSystemMetrics(78)
    height = user32.GetSystemMetrics(79)
    return left, top, width, height

def apply_rounded_corners_win32(window, width, height, radius=32):
    try:
        hwnd = ctypes.windll.user32.GetParent(window.winfo_id())
        rgn = ctypes.windll.gdi32.CreateRoundRectRgn(0, 0, width + 1, height + 1, radius * 2, radius * 2)
        ctypes.windll.user32.SetWindowRgn(hwnd, rgn, True)
    except Exception:
        pass

def generate_soft_chime_wav(filepath):
    if os.path.exists(filepath):
        return
    sample_rate = 44100
    duration = 1.4
    num_samples = int(sample_rate * duration)

    with wave.open(filepath, 'w') as wav_file:
        wav_file.setnchannels(1)
        wav_file.setsampwidth(2)
        wav_file.setframerate(sample_rate)

        for i in range(num_samples):
            t = i / sample_rate
            env = math.exp(-3.2 * t) * (1 - math.exp(-60 * t))
            val = (
                0.55 * math.sin(2 * math.pi * 523.25 * t) +
                0.30 * math.sin(2 * math.pi * 659.25 * t) +
                0.15 * math.sin(2 * math.pi * 783.99 * t)
            )
            sample = int(val * env * 14000)
            wav_file.writeframes(struct.pack('<h', max(-32768, min(32767, sample))))

# ================= HÀM VẼ HÌNH BO GÓC SIÊU MỊN =================
def draw_smooth_round_rect(canvas, x1, y1, x2, y2, r, fill="", outline="", width=0):
    r = min(r, (x2 - x1) / 2, (y2 - y1) / 2)
    if r < 1:
        r = 1
    pts = []
    steps = 16
    for i in range(steps + 1):
        ang = -math.pi / 2 + (math.pi / 2) * (i / steps)
        pts.extend([x2 - r + r * math.cos(ang), y1 + r + r * math.sin(ang)])
    for i in range(steps + 1):
        ang = 0 + (math.pi / 2) * (i / steps)
        pts.extend([x2 - r + r * math.cos(ang), y2 - r + r * math.sin(ang)])
    for i in range(steps + 1):
        ang = math.pi / 2 + (math.pi / 2) * (i / steps)
        pts.extend([x1 + r + r * math.cos(ang), y2 - r + r * math.sin(ang)])
    for i in range(steps + 1):
        ang = math.pi + (math.pi / 2) * (i / steps)
        pts.extend([x1 + r + r * math.cos(ang), y1 + r + r * math.sin(ang)])
    return canvas.create_polygon(pts, fill=fill, outline=outline, width=width, smooth=False)

# ================= QUẢN LÝ THỐNG KÊ & STREAK =================
class StatsManager:
    def __init__(self, filepath):
        self.filepath = filepath
        self.data = self.load()

    def load(self):
        if os.path.exists(self.filepath):
            try:
                with open(self.filepath, 'r', encoding='utf-8') as f:
                    return json.load(f)
            except Exception:
                pass
        return {"history": {}, "streak": 0, "last_active_date": ""}

    def save(self):
        try:
            with open(self.filepath, 'w', encoding='utf-8') as f:
                json.dump(self.data, f, indent=4, ensure_ascii=False)
        except Exception:
            pass

    def get_shift_date_str(self):
        now = datetime.datetime.now()
        if WORK_START_HOUR > WORK_END_HOUR and now.hour < WORK_END_HOUR + 4:
            now -= datetime.timedelta(days=1)
        return now.strftime("%Y-%m-%d")

    def record_standup(self):
        today = self.get_shift_date_str()
        history = self.data.setdefault("history", {})
        history[today] = history.get(today, 0) + 1

        last_date = self.data.get("last_active_date", "")
        if last_date != today:
            yesterday = (datetime.datetime.strptime(today, "%Y-%m-%d") - datetime.timedelta(days=1)).strftime("%Y-%m-%d")
            if last_date == yesterday:
                self.data["streak"] = self.data.get("streak", 0) + 1
            else:
                self.data["streak"] = 1
            self.data["last_active_date"] = today

        self.save()

    def get_today_count(self):
        today = self.get_shift_date_str()
        return self.data.get("history", {}).get(today, 0)

    def get_streak(self):
        return self.data.get("streak", 0)

# ================= NÚT BẤM THANH TIẾN TRÌNH MƯỢT & VIỀN RÕ NÉT =================
class SmoothProgressButton(tk.Canvas):
    def __init__(self, master, width=380, height=56, radius=16, command=None, **kwargs):
        super().__init__(master, width=width, height=height, bg="#1E1E22", highlightthickness=0, **kwargs)
        self.btn_w = width
        self.btn_h = height
        self.radius = radius
        self.command = command
        self.progress = 0.0
        self.is_ready = False
        self.is_hovered = False

        self.bind("<Enter>", self._on_enter)
        self.bind("<Leave>", self._on_leave)
        self.bind("<Button-1>", self._on_click)
        self.redraw()

    def set_progress(self, ratio):
        self.progress = max(0.0, min(1.0, ratio))
        self.is_ready = (self.progress >= 1.0)
        self.redraw()

    def _on_enter(self, _):
        self.is_hovered = True
        if self.is_ready:
            self.configure(cursor="hand2")
            self.redraw()

    def _on_leave(self, _):
        self.is_hovered = False
        self.configure(cursor="")
        self.redraw()

    def _on_click(self, _):
        if self.is_ready and self.command:
            self.command()

    def redraw(self):
        self.delete("all")
        pad = 2

        if not self.is_ready:
            draw_smooth_round_rect(
                self, pad, pad, self.btn_w - pad, self.btn_h - pad,
                self.radius, fill="#2E303E", outline="#7986CB", width=2
            )
            fill_w = (self.btn_w - pad * 2) * self.progress
            if fill_w > self.radius:
                draw_smooth_round_rect(
                    self, pad, pad, pad + fill_w, self.btn_h - pad,
                    self.radius, fill="#5C6BC0", outline=""
                )
            draw_smooth_round_rect(
                self, pad, pad, self.btn_w - pad, self.btn_h - pad,
                self.radius, fill="", outline="#9FA8DA", width=2
            )
            secs_left = math.ceil(ANTI_REFLEX_SECONDS * (1.0 - self.progress))
            self.create_text(
                self.btn_w / 2, self.btn_h / 2,
                text=f"Đợi {secs_left}s...",
                fill="#FFFFFF", font=("Segoe UI", 15, "bold")
            )
        else:
            bg_col = "#1B5E20" if self.is_hovered else "#2E7D32"
            border_col = "#A5D6A7" if self.is_hovered else "#66BB6A"
            draw_smooth_round_rect(
                self, pad, pad, self.btn_w - pad, self.btn_h - pad,
                self.radius, fill=bg_col, outline=border_col, width=2.5
            )
            self.create_text(
                self.btn_w / 2, self.btn_h / 2,
                text="Okay Hiếu đứng dậy rồi á",
                fill="#FFFFFF", font=("Segoe UI", 16, "bold")
            )

# ================= ỨNG DỤNG CHÍNH =================
class StandUpApp:
    def __init__(self, root):
        self.root = root
        self.root.title("Nhắc nhở đứng dậy")
        self.root.withdraw()

        self.stats = StatsManager(STATS_FILE)
        self.cadao = CaDaoManager(CADAO_FILE)
        self.schedule_active = WORK_SCHEDULE_ENABLED

        self.target_time = None
        self.paused_until = None
        self.is_popup_showing = False
        self.is_sleeping = False
        self.tray_icon = None
        self.last_icon_state = None

        self.overlay_win = None
        self.popup_win = None
        self.unlock_start_time = 0

        self.start_countdown(INTERVAL_SECONDS)
        threading.Thread(target=self.setup_tray, daemon=True).start()
        self.update_status_loop()

    def is_within_work_hours(self):
        if not self.schedule_active:
            return True
        now = datetime.datetime.now().time()
        start_t = datetime.time(WORK_START_HOUR, WORK_START_MIN)
        end_t = datetime.time(WORK_END_HOUR, WORK_END_MIN)

        if start_t <= end_t:
            return start_t <= now <= end_t
        else:
            return now >= start_t or now <= end_t

    def toggle_schedule(self):
        self.schedule_active = not self.schedule_active
        if self.tray_icon:
            self.tray_icon.update_menu()

    def create_progress_icon(self, ring_rgb, ratio, text_str):
        size = 64
        img = Image.new('RGBA', (size, size), (0, 0, 0, 0))
        d = ImageDraw.Draw(img)

        d.ellipse([4, 4, size - 4, size - 4], fill=(28, 28, 30, 245))
        d.ellipse([4, 4, size - 4, size - 4], outline=(70, 70, 75, 255), width=6)

        if ratio > 0:
            sweep_angle = 360 * max(0.0, min(1.0, ratio))
            d.arc([4, 4, size - 4, size - 4], start=-90, end=-90 + sweep_angle, fill=ring_rgb, width=6)

        try:
            font = ImageFont.truetype("arialbd.ttf", 26 if len(text_str) <= 2 else 22)
        except IOError:
            font = ImageFont.load_default()

        bbox = d.textbbox((0, 0), text_str, font=font)
        tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
        d.text(((size - tw) / 2, (size - th) / 2 - 2), text_str, fill=(255, 255, 255, 255), font=font)
        return img

    def setup_tray(self):
        menu = pystray.Menu(
            pystray.MenuItem(
                lambda item: f"Hôm nay: {self.stats.get_today_count()}/{DAILY_GOAL} lần (Streak: {self.stats.get_streak()} ngày)",
                None, enabled=False
            ),
            pystray.Menu.SEPARATOR,
            pystray.MenuItem("Hiện thông báo ngay (Test)", lambda: self.root.after(0, self.show_popup)),
            pystray.MenuItem("Hoãn 5 phút", lambda: self.root.after(0, lambda: self.snooze(5))),
            pystray.MenuItem("Tạm dừng 1 tiếng", lambda: self.root.after(0, lambda: self.pause_app(60))),
            pystray.MenuItem("Đặt lại 30 phút từ đầu", lambda: self.root.after(0, lambda: self.start_countdown(INTERVAL_SECONDS))),
            pystray.Menu.SEPARATOR,
            pystray.MenuItem(
                f"Chỉ nhắc trong ca ({WORK_START_HOUR:02d}:{WORK_START_MIN:02d}-{WORK_END_HOUR:02d}:{WORK_END_MIN:02d})",
                lambda: self.root.after(0, self.toggle_schedule),
                checked=lambda item: self.schedule_active
            ),
            pystray.Menu.SEPARATOR,
            pystray.MenuItem("Thoát hẳn app", self.quit_app)
        )
        init_img = self.create_progress_icon((46, 125, 50), 1.0, "30")
        self.tray_icon = pystray.Icon("StandUpHieu", init_img, "Còn 30 phút đến thông báo", menu)
        self.tray_icon.run()

    def quit_app(self):
        if self.tray_icon:
            self.tray_icon.stop()
        self.root.after(0, self.root.destroy)

    def start_countdown(self, seconds):
        self.paused_until = None
        self.is_popup_showing = False
        self.target_time = time.time() + seconds

    def snooze(self, minutes):
        self.close_popup_with_fade()
        self.start_countdown(minutes * 60)

    def pause_app(self, minutes):
        self.close_popup_with_fade()
        self.is_popup_showing = False
        self.paused_until = time.time() + (minutes * 60)

    def update_status_loop(self):
        now = time.time()

        if not self.is_within_work_hours() and not self.is_popup_showing:
            if not self.is_sleeping:
                self.is_sleeping = True
            self.update_tray_visual(
                (100, 110, 120), 0.0, "Zzz",
                f"Đang ngủ đông (Ngoài giờ {WORK_START_HOUR:02d}:00-{WORK_END_HOUR:02d}:00)"
            )
            self.root.after(2000, self.update_status_loop)
            return
        elif self.is_sleeping:
            self.is_sleeping = False
            self.start_countdown(INTERVAL_SECONDS)

        if self.paused_until:
            if now >= self.paused_until:
                self.start_countdown(INTERVAL_SECONDS)
            else:
                mins_paused = math.ceil((self.paused_until - now) / 60)
                self.update_tray_visual((150, 150, 150), 0.0, "II", f"Đang tạm dừng (còn {mins_paused} phút)")
                self.root.after(1000, self.update_status_loop)
                return

        if self.target_time and not self.is_popup_showing:
            if get_idle_duration() >= IDLE_RESET_SECONDS:
                self.target_time = now + INTERVAL_SECONDS

            remaining = self.target_time - now
            if remaining <= 0:
                self.show_popup()
            else:
                if remaining >= 20 * 60:
                    ring_rgb = (76, 175, 80)
                elif remaining >= 5 * 60:
                    ring_rgb = (255, 167, 38)
                else:
                    ring_rgb = (239, 83, 80)

                ratio = remaining / INTERVAL_SECONDS
                mins_left = math.ceil(remaining / 60)
                icon_txt = "<1" if remaining < 60 else str(mins_left)
                tooltip = "Còn dưới 1 phút đến thông báo" if remaining < 60 else f"Còn {mins_left} phút đến thông báo"

                self.update_tray_visual(ring_rgb, round(ratio, 2), icon_txt, tooltip)

        self.root.after(1000, self.update_status_loop)

    def update_tray_visual(self, ring_rgb, ratio, icon_txt, tooltip):
        if not self.tray_icon:
            return
        state_key = (ring_rgb, ratio, icon_txt)
        if state_key != self.last_icon_state:
            self.tray_icon.icon = self.create_progress_icon(ring_rgb, ratio, icon_txt)
            self.last_icon_state = state_key
        if self.tray_icon.title != tooltip:
            self.tray_icon.title = tooltip

    def keep_popup_on_top(self, _=None):
        if self.is_popup_showing and self.popup_win:
            try:
                if self.overlay_win:
                    self.overlay_win.lower(self.popup_win)
                self.popup_win.lift()
                self.popup_win.focus_force()
            except Exception:
                pass

    def show_popup(self):
        if self.is_popup_showing:
            return
        self.is_popup_showing = True
        self.update_tray_visual((239, 83, 80), 0.0, "0", "Đã đến giờ đứng dậy!")

        try:
            winsound.PlaySound(CHIME_FILE, winsound.SND_FILENAME | winsound.SND_ASYNC)
        except Exception:
            self.root.bell()

        v_left, v_top, v_width, v_height = get_virtual_screen_bounds()
        self.overlay_win = tk.Toplevel(self.root)
        self.overlay_win.overrideredirect(True)
        self.overlay_win.geometry(f"{v_width}x{v_height}+{v_left}+{v_top}")
        self.overlay_win.configure(bg="#000000")
        self.overlay_win.attributes("-alpha", 0.0)
        self.overlay_win.attributes("-topmost", True)
        self.overlay_win.bind("<Button-1>", self.keep_popup_on_top)

        quote_raw, meaning_raw = self.cadao.get_next_random()
        if "/" in quote_raw:
            parts = [p.strip() for p in quote_raw.split("/", 1)]
            wrapped_quote = f"“ {parts[0]}\n{parts[1]} ”"
        else:
            wrapped_quote = f"“ {textwrap.fill(quote_raw, width=54)} ”"

        wrapped_meaning = textwrap.fill(f"➡ {meaning_raw}", width=82)

        q_lines = wrapped_quote.count("\n") + 1
        m_lines = wrapped_meaning.count("\n") + 1

        win_w = 860
        box_h = 54 + (q_lines * 34) + (m_lines * 26)
        win_h = 250 + box_h

        prim_w = self.root.winfo_screenwidth()
        prim_h = self.root.winfo_screenheight()
        pos_x = (prim_w // 2) - (win_w // 2)
        pos_y = (prim_h // 2) - (win_h // 2)

        self.popup_win = tk.Toplevel(self.root)
        self.popup_win.overrideredirect(True)
        self.popup_win.transient(self.overlay_win)
        self.popup_win.attributes("-topmost", True)
        self.popup_win.configure(bg="#1E1E22")
        self.popup_win.geometry(f"{win_w}x{win_h}+{pos_x}+{pos_y}")
        self.popup_win.bind("<FocusOut>", self.keep_popup_on_top)

        canvas = tk.Canvas(self.popup_win, width=win_w, height=win_h, bg="#1E1E22", highlightthickness=0)
        canvas.pack(fill="both", expand=True)

        corner_radius = 32
        draw_smooth_round_rect(
            canvas, 2, 2, win_w - 3, win_h - 3, corner_radius,
            fill="#1E1E22", outline="#FFD1DC", width=2.5
        )

        streak_num = self.stats.get_streak()
        today_num = self.stats.get_today_count()
        draw_smooth_round_rect(canvas, 36, 24, 340, 58, 17, fill="#2A2A32", outline="#3E3E48", width=1)
        canvas.create_text(
            52, 41,
            text=f"🔥 Streak: {streak_num} ngày   •   Hôm nay: {today_num}/{DAILY_GOAL}",
            fill="#FFB74D", font=("Segoe UI", 12, "bold"), anchor="w"
        )

        self.clock_item = canvas.create_text(
            win_w - 40, 41,
            text=datetime.datetime.now().strftime("%H:%M:%S"),
            fill="#B0BEC5", font=("Consolas", 14, "bold"), anchor="e"
        )

        canvas.create_text(
            win_w / 2, 96,
            text="Đứng dậy đi lại đi Hiếu!",
            fill="#FFD1DC", font=("Segoe UI", 28, "bold"), anchor="center"
        )

        box_x1, box_y1 = 44, 140
        box_x2, box_y2 = win_w - 44, 140 + box_h
        draw_smooth_round_rect(
            canvas, box_x1, box_y1, box_x2, box_y2, 22,
            fill="#27272D", outline="#3C3C46", width=1.5
        )

        draw_smooth_round_rect(
            canvas, (win_w / 2) - 35, box_y1 + 14, (win_w / 2) + 35, box_y1 + 18, 2,
            fill="#FFD1DC"
        )

        quote_y = box_y1 + 32 + (q_lines * 17)
        canvas.create_text(
            win_w / 2, quote_y,
            text=wrapped_quote,
            fill="#FFF8E7", font=("Segoe UI", 19, "bold italic"),
            justify="center", anchor="center"
        )

        sep_y = box_y1 + 42 + (q_lines * 34)
        canvas.create_line(box_x1 + 40, sep_y, box_x2 - 40, sep_y, fill="#42424D", width=1)

        meaning_y = sep_y + 16
        canvas.create_text(
            box_x1 + 32, meaning_y,
            text=wrapped_meaning,
            fill="#E0E0E0", font=("Segoe UI", 13),
            justify="left", anchor="nw"
        )

        self.progress_btn = SmoothProgressButton(
            self.popup_win, width=380, height=56, radius=16, command=self.confirm_stand_up
        )
        canvas.create_window(win_w / 2, box_y2 + 54, window=self.progress_btn)

        self.popup_win.update()
        apply_rounded_corners_win32(self.popup_win, win_w, win_h, radius=corner_radius)

        self.popup_win.deiconify()
        self.popup_win.lift()
        self.popup_win.focus_force()

        self.overlay_step = 0
        self.animate_overlay_fade_in()
        self.unlock_start_time = time.time()
        self.animate_button_progress()
        self.update_popup_clock()

    def animate_overlay_fade_in(self):
        if self.overlay_step <= 10 and self.is_popup_showing and self.overlay_win:
            ratio = self.overlay_step / 10.0
            try:
                self.overlay_win.attributes("-alpha", 0.58 * ratio)
            except Exception:
                pass
            self.overlay_step += 1
            self.popup_win.after(20, self.animate_overlay_fade_in)

    def animate_button_progress(self):
        if not self.is_popup_showing or not self.popup_win:
            return
        elapsed = time.time() - self.unlock_start_time
        ratio = elapsed / ANTI_REFLEX_SECONDS
        self.progress_btn.set_progress(ratio)
        if ratio < 1.0:
            self.popup_win.after(30, self.animate_button_progress)

    def update_popup_clock(self):
        if not self.is_popup_showing or not self.popup_win:
            return
        try:
            canvas = self.popup_win.winfo_children()[0]
            canvas.itemconfigure(self.clock_item, text=datetime.datetime.now().strftime("%H:%M:%S"))
        except Exception:
            pass
        self.popup_win.after(1000, self.update_popup_clock)

    def close_popup_with_fade(self):
        self.is_popup_showing = False
        self.fade_out_start = time.time()
        self.fade_out_duration = 0.9

        if self.popup_win:
            self.popup_win.unbind("<FocusOut>")
        if self.overlay_win:
            self.overlay_win.unbind("<Button-1>")

        self._run_fade_out_frame()

    def _run_fade_out_frame(self):
        elapsed = time.time() - self.fade_out_start
        progress = min(1.0, elapsed / self.fade_out_duration)
        ease_factor = (1.0 - progress) ** 3

        if progress < 1.0:
            if self.popup_win:
                try:
                    self.popup_win.attributes("-alpha", 1.0 * ease_factor)
                except Exception:
                    pass
            if self.overlay_win:
                try:
                    self.overlay_win.attributes("-alpha", 0.58 * ease_factor)
                except Exception:
                    pass
            self.root.after(15, self._run_fade_out_frame)
        else:
            if self.popup_win:
                try:
                    self.popup_win.destroy()
                except Exception:
                    pass
                self.popup_win = None
            if self.overlay_win:
                try:
                    self.overlay_win.destroy()
                except Exception:
                    pass
                self.overlay_win = None

    def confirm_stand_up(self):
        if not self.is_popup_showing:
            return
        self.stats.record_standup()
        if self.tray_icon:
            self.tray_icon.update_menu()
        self.close_popup_with_fade()
        self.start_countdown(INTERVAL_SECONDS)

# ================= TỰ KHỞI ĐỘNG CÙNG WINDOWS =================
def add_to_startup():
    if getattr(sys, 'frozen', False):
        app_path = f'"{sys.executable}"'
    else:
        python_exe = sys.executable.replace("python.exe", "pythonw.exe")
        script_path = os.path.abspath(__file__)
        app_path = f'"{python_exe}" "{script_path}"'

    key_path = r"Software\Microsoft\Windows\CurrentVersion\Run"
    try:
        key = winreg.OpenKey(winreg.HKEY_CURRENT_USER, key_path, 0, winreg.KEY_SET_VALUE)
        winreg.SetValueEx(key, "StandUpReminderHieu", 0, winreg.REG_SZ, app_path)
        winreg.CloseKey(key)
    except Exception:
        pass

if __name__ == "__main__":
    lock_socket = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        lock_socket.bind(("127.0.0.1", LOCK_PORT))
    except socket.error:
        sys.exit(0)

    generate_soft_chime_wav(CHIME_FILE)
    add_to_startup()

    root = ctk.CTk()
    app = StandUpApp(root)
    root.mainloop()