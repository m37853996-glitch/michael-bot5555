import os
import json
import logging
import asyncio
import subprocess
from http.server import HTTPServer, BaseHTTPRequestHandler
import threading
from telegram import Update, InlineKeyboardButton, InlineKeyboardMarkup
from telegram.ext import (
    ApplicationBuilder,
    ContextTypes,
    CommandHandler,
    CallbackQueryHandler,
    MessageHandler,
    filters
)

# --- سيرفر ويب وهمي لإرضاء منصة Render ومنع إيقاف البوت ---
class SimpleHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b"Bot is alive and running!")

def run_web_server():
    port = int(os.environ.get("PORT", 10000))
    server = HTTPServer(('0.0.0.0', port), SimpleHandler)
    server.serve_forever()

# تشغيل السيرفر في الخلفية فور إقلاع السكربت
threading.Thread(target=run_web_server, daemon=True).start()
# --------------------------------------------------------
