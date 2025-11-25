#!/usr/bin/env python3
"""
Admin-Only Auto-Plug Bot Manager - FIXED MULTI-SESSION VERSION
"""

import asyncio
import json
import os
import hashlib
import glob
from datetime import datetime, timedelta
import random
from zoneinfo import ZoneInfo
from telegram import Update, InlineKeyboardButton, InlineKeyboardMarkup, Bot
from telegram.ext import Application, CommandHandler, MessageHandler, CallbackQueryHandler, ContextTypes, filters
from telethon import TelegramClient
from telethon.errors import SessionPasswordNeededError, FloodWaitError, SessionRevokedError
import logging

from backend.server import parse_card_input, process_card

# Disable third-party logs
logging.getLogger('httpx').setLevel(logging.ERROR)
logging.getLogger('telegram').setLevel(logging.ERROR)
logging.getLogger('telethon').setLevel(logging.WARNING)

# Only show our app logs
logging.basicConfig(
    format='%(asctime)s - %(levelname)s - %(message)s',
    level=logging.INFO
)
logger = logging.getLogger(__name__)

# Directories
BOTS_DIR = 'bots'
USERS_DIR = 'users_data'
os.makedirs(BOTS_DIR, exist_ok=True)
os.makedirs(USERS_DIR, exist_ok=True)

# Config file
BOTS_CONFIG = os.path.join(BOTS_DIR, 'bots_config.json')

class RateLimiter:
    """Rate limiter for multiple accounts"""
    def __init__(self, max_concurrent=2, delay_between=15):
        self.semaphore = asyncio.Semaphore(max_concurrent)
        self.delay_between = delay_between
        self.last_operation = 0
    
    async def __aenter__(self):
        await self.semaphore.acquire()
        # Add delay between operations
        now = asyncio.get_event_loop().time()
        delay = max(0, self.last_operation + self.delay_between - now)
        if delay > 0:
            await asyncio.sleep(delay)
        self.last_operation = asyncio.get_event_loop().time()
        return self
    
    async def __aexit__(self, exc_type, exc_val, exc_tb):
        self.semaphore.release()

# Global rate limiter - LIMIT CONCURRENT SESSIONS
global_rate_limiter = RateLimiter(max_concurrent=8, delay_between=1)


class StripeBatchChecker:
    """Simple Stripe checker that processes up to max_cards sequentially."""

    def __init__(self, delay_seconds: int = 6, max_cards: int = 100):
        self.delay_seconds = delay_seconds
        self.max_cards = max_cards

    def _parse_cards(self, raw_input: str):
        lines = [line.strip() for line in raw_input.replace('\r', '\n').split('\n')]
        return [line for line in lines if line]

    async def run_checks(self, raw_input: str, bot: Bot, chat_id: int):
        cards = self._parse_cards(raw_input)

        if not cards:
            await bot.send_message(chat_id=chat_id, text="❌ No cards found. Send them as CARD|MM|YYYY|CVV (one per line).")
            return

        if len(cards) > self.max_cards:
            await bot.send_message(chat_id=chat_id, text=f"⚠️ Limiting to first {self.max_cards} cards (received {len(cards)}).")
            cards = cards[: self.max_cards]

        await bot.send_message(chat_id=chat_id, text=f"🛡️ Starting Stripe check for {len(cards)} card(s). Processing line by line...")

        success = 0
        failed = 0
        unknown = 0
        invalid = 0

        for idx, line in enumerate(cards, start=1):
            parsed = parse_card_input(line)
            if not parsed:
                invalid += 1
                await bot.send_message(chat_id=chat_id, text=f"#{idx}: ❌ Invalid format -> {line}")
                continue

            try:
                result = await process_card({}, parsed)
                status = result.get('status', 'UNKNOWN')
                message = result.get('message', 'No response')
                card_display = result.get('card', line)

                if status == 'SUCCESS':
                    success += 1
                    emoji = '✅'
                elif status == 'FAIL':
                    failed += 1
                    emoji = '❌'
                else:
                    unknown += 1
                    emoji = '⚠️'

                await bot.send_message(chat_id=chat_id, text=f"#{idx}: {emoji} {card_display} — {message}")
            except Exception as exc:  # noqa: BLE001 - bubble up to the user
                unknown += 1
                await bot.send_message(chat_id=chat_id, text=f"#{idx}: ⚠️ Error checking card: {exc}")

            if idx < len(cards):
                await asyncio.sleep(self.delay_seconds)

        summary = (
            "📊 Stripe Check Complete\n\n"
            f"✅ Approved: {success}\n"
            f"❌ Declined: {failed}\n"
            f"⚠️ Unknown/Error: {unknown}\n"
            f"🚫 Invalid Format: {invalid}\n"
            f"Total Processed: {len(cards)}"
        )
        await bot.send_message(chat_id=chat_id, text=summary)


stripe_checker = StripeBatchChecker()

class AdminAccount:
    """Admin's Telegram account for auto-plugging - FIXED SESSION MANAGEMENT"""
    
    def __init__(self, admin_id, bot_token):
        self.admin_id = admin_id
        self.bot_token = bot_token

        # 🔥 CRITICAL FIX: Create unique session per admin+bot combination
        session_id = hashlib.md5(f"{admin_id}:{bot_token}".encode()).hexdigest()[:16]
        self.user_dir = os.path.join(USERS_DIR, f"admin_{admin_id}_bot_{session_id}")
        os.makedirs(self.user_dir, exist_ok=True)
        
        # file paths
        self.config_file = os.path.join(self.user_dir, 'config.json')
        self.groups_file = os.path.join(self.user_dir, 'groups.json')
        self.messages_file = os.path.join(self.user_dir, 'messages.json')
        
        # 🔥 UNIQUE SESSION FILE - includes bot token in hash
        bot_token_hash = hashlib.md5(bot_token.encode()).hexdigest()[:12]
        self.session_file = os.path.join(self.user_dir, f'session_{bot_token_hash}')
        
        # load stored data
        self.config = self.load_config()
        self.groups = self.load_groups()
        self.messages = self.load_messages()
        
        # runtime variables
        self.client = None
        self.is_running = self.config.get('auto_plug_running', False)
        self.last_chat_id = self.config.get('last_chat_id', None)
        self.total_plugs = self.config.get('total_plugs', 0)
        self.interval = self.config.get('interval', 1.0)
        self.auto_task = None
        self.message_index = self.config.get('message_index', 0)

    def load_config(self):
        if os.path.exists(self.config_file):
            try:
                with open(self.config_file, 'r') as f:
                    return json.load(f)
            except:
                return {}
        return {}
    
    def save_config(self):
        try:
            with open(self.config_file, 'w') as f:
                json.dump(self.config, f, indent=2)
        except Exception as e:
            logger.error(f"Error saving config for {self.admin_id}: {e}")
    
    def load_groups(self):
        if os.path.exists(self.groups_file):
            try:
                with open(self.groups_file, 'r', encoding='utf-8') as f:
                    data = json.load(f)
                    return data.get('groups', [])
            except:
                return []
        return []
    
    def save_groups(self):
        try:
            with open(self.groups_file, 'w', encoding='utf-8') as f:
                json.dump({'groups': self.groups}, f, indent=2, ensure_ascii=False)
        except Exception as e:
            logger.error(f"Error saving groups for {self.admin_id}: {e}")
    
    def load_messages(self):
        if os.path.exists(self.messages_file):
            try:
                with open(self.messages_file, 'r', encoding='utf-8') as f:
                    data = json.load(f)
                    return data.get('messages', [])
            except:
                return []
        return []
    
    def save_messages(self):
        try:
            with open(self.messages_file, 'w', encoding='utf-8') as f:
                json.dump({'messages': self.messages}, f, indent=2, ensure_ascii=False)
        except Exception as e:
            logger.error(f"Error saving messages for {self.admin_id}: {e}")

    async def handle_session_revoked(self):
        """Handle revoked session by clearing and requiring re-login"""
        try:
            if self.client:
                await self.client.disconnect()
                self.client = None
            
            session_path = f'{self.session_file}.session'
            if os.path.exists(session_path):
                os.remove(session_path)
            
            # Update config
            self.config['logged_in'] = False
            self.save_config()
            
            logger.info(f"Cleared revoked session for admin {self.admin_id}")
            return False
        except Exception as e:
            logger.error(f"Error handling revoked session for admin {self.admin_id}: {e}")
            return False

    async def ensure_connected(self):
        """Ensure client is connected with proper error handling"""
        if not self.client:
            if self.is_logged_in():
                success, msg = await self.login()
                return success
            return False
        
        if not self.client.is_connected():
            try:
                await self.client.connect()
                return True
            except SessionRevokedError:
                return await self.handle_session_revoked()
            except Exception as e:
                logger.error(f"Connection error for admin {self.admin_id}: {e}")
                return False
        return True

    def set_auto_plug_running(self, running: bool, chat_id: int = None):
        self.is_running = running
        self.config['auto_plug_running'] = running
        if chat_id is not None:
            self.last_chat_id = chat_id
            self.config['last_chat_id'] = chat_id
        self.save_config()
        
    def set_credentials(self, api_id, api_hash, phone):
        self.config['api_id'] = str(api_id)
        self.config['api_hash'] = str(api_hash)
        self.config['phone'] = str(phone)
        self.config['configured'] = True
        self.config['configured_at'] = datetime.utcnow().isoformat()
        self.save_config()
    
    def is_configured(self):
        return self.config.get('configured', False) and \
               'api_id' in self.config and \
               'api_hash' in self.config and \
               'phone' in self.config
    
    def is_logged_in(self):
        return self.config.get('logged_in', False) and os.path.exists(f'{self.session_file}.session')
    
    async def login(self):
        if not self.is_configured():
            return False, "Not configured. Use /setup first"
        
        async with global_rate_limiter:
            try:
                self.client = TelegramClient(
                    self.session_file,
                    int(self.config['api_id']),
                    self.config['api_hash']
                )
                
                await self.client.connect()
                
                if not await self.client.is_user_authorized():
                    await self.client.send_code_request(self.config['phone'])
                    return False, "Code sent to your Telegram. Use /code <code> to verify"
                
                me = await self.client.get_me()
                self.config['logged_in'] = True
                self.config['username'] = me.username or me.first_name
                self.save_config()
                
                logger.info(f"Admin {self.admin_id} logged in as {me.username or me.first_name}")
                return True, f"Logged in as {me.username or me.first_name}"
                
            except SessionRevokedError:
                await self.handle_session_revoked()
                return False, "Session revoked. Please setup again with /setup"
            except Exception as e:
                logger.error(f"Login error for {self.admin_id}: {e}")
                return False, f"Login error: {str(e)[:50]}"
    
    async def verify_code(self, code):
        async with global_rate_limiter:
            try:
                await self.client.sign_in(self.config['phone'], code)
                
                me = await self.client.get_me()
                self.config['logged_in'] = True
                self.config['username'] = me.username or me.first_name
                self.save_config()
                
                logger.info(f"Admin {self.admin_id} verified")
                return True, f"✅ Logged in as {me.username or me.first_name}"
                
            except Exception as e:
                logger.error(f"Verification error for {self.admin_id}: {e}")
                return False, f"Verification failed: {str(e)[:50]}"
    
    async def refresh_groups(self):
        """Refresh groups with rate limiting"""
        async with global_rate_limiter:
            if not await self.ensure_connected():
                return 0, "Not logged in. Use /login first"
            
            try:
                self.groups = []
                dialogs = await self.client.get_dialogs()
                
                for dialog in dialogs:
                    if dialog.is_group or dialog.is_channel:
                        self.groups.append({
                            'chat_id': dialog.id,
                            'title': dialog.title,
                            'type': 'channel' if dialog.is_channel else 'group'
                        })
                
                self.save_groups()
                logger.info(f"Admin {self.admin_id} refreshed {len(self.groups)} groups")
                return len(self.groups), f"Found {len(self.groups)} groups"
                
            except SessionRevokedError:
                await self.handle_session_revoked()
                return 0, "Session revoked. Please login again with /login"
            except Exception as e:
                logger.error(f"Refresh groups error for {self.admin_id}: {e}")
                return 0, f"Error: {str(e)[:50]}"
    
    async def send_plugs(self):
        """Send plugs with improved session management"""
        if not self.messages:
            return {"success": 0, "failed": 0, "message": "No messages configured"}
        
        if not await self.ensure_connected():
            return {"success": 0, "failed": 0, "message": "Not logged in"}
        
        if not self.groups:
            count, msg = await self.refresh_groups()
            if count == 0:
                return {"success": 0, "failed": 0, "message": "No groups found"}
        
        # 🔥 Sequential message selection
        message = self.messages[self.message_index]

        # 🔄 Move to next message index
        self.message_index = (self.message_index + 1) % len(self.messages)
        self.config['message_index'] = self.message_index
        self.save_config()

        success_list = []
        failed_list = []

        
        # Process in smaller batches with delays
        BATCH_SIZE = 3
        for i in range(0, len(self.groups), BATCH_SIZE):
            batch = self.groups[i:i + BATCH_SIZE]
            
            for group in batch:
                try:
                    await self.client.send_message(group['chat_id'], message)
                    success_list.append(group['title'])
                    self.total_plugs += 1
                    
                except SessionRevokedError:
                    await self.handle_session_revoked()
                    failed_list.append({"title": group['title'], "error": "Session revoked"})
                    break
                    
                except FloodWaitError as e:
                    logger.warning(f"Flood wait for {self.admin_id}: {e.seconds}s")
                    failed_list.append({"title": group['title'], "error": f"Flood wait {e.seconds}s"})
                    await asyncio.sleep(min(e.seconds, 10))
                    
                except Exception as e:
                    error_msg = str(e)[:30]
                    failed_list.append({"title": group['title'], "error": error_msg})
                    await asyncio.sleep(0.1)
            
            # Delay between batches
            if i + BATCH_SIZE < len(self.groups):
                await asyncio.sleep(0.5)
        
        self.config['total_plugs'] = self.total_plugs
        self.config['last_plug'] = datetime.utcnow().isoformat()
        self.save_config()
        
        return {
            "success": len(success_list),
            "failed": len(failed_list),
            "success_list": success_list,
            "failed_list": failed_list,
            "message_sent": message,   # 🔥 The message used
            "message": "Completed"
        }

    
    async def auto_plug_loop(self, bot, chat_id):
        logger.info(f"Auto-plug started for admin {self.admin_id}, interval {self.interval}h")
        
        while self.is_running:
            try:
                result = await self.send_plugs()
                
                status_msg = f"🚀 Auto-Plug Complete\n\n"
                status_msg +=f"📝 Message Used:\n{result['message_sent']}\n\n"
                status_msg += f"✅ Success: {result['success']}\n"
                status_msg += f"❌ Failed: {result['failed']}\n"
                status_msg += f"📊 Total Plugs: {self.total_plugs}\n"
                
                await bot.send_message(chat_id=chat_id, text=status_msg)
                
                # Wait for next interval
                wait_seconds = self.interval * 3600
                elapsed = 0
                while elapsed < wait_seconds and self.is_running:
                    await asyncio.sleep(60)
                    elapsed += 60
                    
            except Exception as e:
                logger.error(f"Auto-plug error for admin {self.admin_id}: {e}")
                await asyncio.sleep(300)
        
        await bot.send_message(chat_id=chat_id, text="⏹️ Auto-plug stopped")

    def get_plug_times(self):
        """Returns (last_plug_display, next_plug_display) in Philippine Time"""
        last_plug = self.config.get('last_plug')
        if last_plug:
            last_dt_utc = datetime.fromisoformat(last_plug)
            last_dt_pht = last_dt_utc.astimezone(ZoneInfo("Asia/Manila"))
            last_plug_disp = last_dt_pht.strftime("%Y-%m-%d %H:%M:%S PHT")
            if self.is_running and self.interval:
                next_dt_utc = last_dt_utc + timedelta(hours=self.interval)
                next_dt_pht = next_dt_utc.astimezone(ZoneInfo("Asia/Manila"))
                next_plug_disp = next_dt_pht.strftime("%Y-%m-%d %H:%M:%S PHT")
            else:
                next_plug_disp = "N/A"
        else:
            last_plug_disp = "N/A"
            next_plug_disp = "N/A"
        return last_plug_disp, next_plug_disp

    def get_status(self):
        username = self.config.get('username', 'Not logged in')
        logged_in = self.is_logged_in()
        last_plug_disp, next_plug_disp = self.get_plug_times()
        
        if logged_in:
            status = f"""🤖 Auto-Plug Bot 

📊 **Status:**
• Session: ✅ Active
• User: {username}
• Auto: {'🟢 Running' if self.is_running else '🔴 Stopped'}
• Groups: {len(self.groups)}
• Messages: {len(self.messages)}
• Interval: {self.interval}h
• Total Plugs: {self.total_plugs}
• Last Plug: {last_plug_disp}
• Next Plug: {next_plug_disp}

📝 **Messages:**
/addmessage - Add message
/listmessages - List all
/removemessage <n> - Remove
/clearmessages - Clear all

🚀 **Auto-Plug:**
/startauto - Start auto-plug
/stopauto - Stop auto-plug
/setinterval <hours> - Set interval

⚡ **Manual:**
/plugnow - Send now
/refreshgroups - Refresh groups

🔐 **Session:**
/logout - Logout and clear session"""
        else:
            status = f"""🤖 Auto-Plug Bot 

📊 **Status:**
• Session: ❌ Not Active
• User: Not logged in

🔐 **Setup Required:**

**1️⃣ Get API Credentials:**
   → https://my.telegram.org
   → API development tools
   → Create app
   → Copy API_ID and API_HASH

**2️⃣ Configure:**
   /setcredentials <API_ID> <API_HASH> <PHONE>
   
   Example:
   `/setcredentials 12345678 abcdef123 +1234567890`

**3️⃣ Login:**
   /login
   
**4️⃣ Verify Code:**
   /code <code>

Once logged in, you'll see all available commands!"""
        
        return status

# Global storage - FIXED: Proper session isolation
admin_accounts = {}

def get_admin_account(admin_id, bot_token):
    """Get or create admin account with proper session isolation"""
    # Create unique key for this admin+bot combination
    key = hashlib.md5(f"{admin_id}:{bot_token}".encode()).hexdigest()
    
    if key not in admin_accounts:
        admin_accounts[key] = AdminAccount(admin_id, bot_token)
        logger.info(f"Created new session for admin {admin_id} on bot {bot_token[:10]}...")
    
    return admin_accounts[key]

def _bots_from_env():
    """Read multi-bot config from environment (comma-separated)."""
    tokens = [t.strip() for t in os.getenv('BOT_TOKENS', '').split(',') if t.strip()]
    if not tokens:
        return None

    admins_raw = [a.strip() for a in os.getenv('BOT_ADMIN_IDS', '').split(',') if a.strip()]
    names_raw = [n.strip() for n in os.getenv('BOT_NAMES', '').split(',') if n.strip()]

    bots = []
    for idx, token in enumerate(tokens):
        try:
            admin_id = int(admins_raw[idx])
        except (IndexError, ValueError):
            logger.warning(
                "Skipping bot token at index %s because BOT_ADMIN_IDS is missing or invalid for it",
                idx,
            )
            continue

        bot_name = names_raw[idx] if idx < len(names_raw) else f"bot_{idx + 1}"

        bots.append({
            'bot_token': token,
            'admin_user_id': admin_id,
            'bot_name': bot_name,
            'added': datetime.utcnow().isoformat()
        })

    if not bots:
        logger.warning("No valid bots loaded from environment; falling back to config file")
        return None

    logger.info(f"Loaded {len(bots)} bot(s) from environment BOT_TOKENS with unique admins")
    return {'bots': bots}


def _bots_from_file():
    """Load bot config from bots_config.json while ensuring per-bot admin mapping."""
    if not os.path.exists(BOTS_CONFIG):
        return None

    try:
        with open(BOTS_CONFIG, 'r') as f:
            data = json.load(f)
    except Exception as exc:
        logger.error(f"Failed to read {BOTS_CONFIG}: {exc}")
        return {'bots': []}

    bots = []
    for idx, bot in enumerate(data.get('bots', [])):
        token = bot.get('bot_token', '').strip()
        admin_id = bot.get('admin_user_id')

        if not token or admin_id is None:
            logger.warning("Skipping bot entry %s in config file: missing token or admin_user_id", idx)
            continue

        try:
            admin_int = int(admin_id)
        except Exception:
            logger.warning("Skipping bot entry %s in config file: admin_user_id is not an integer", idx)
            continue

        bots.append({
            'bot_token': token,
            'admin_user_id': admin_int,
            'bot_name': bot.get('bot_name', f"bot_{idx + 1}"),
            'added': bot.get('added', datetime.utcnow().isoformat())
        })

    return {'bots': bots}


def load_bots_config():
    """Load bot configurations (file/default) and merge optional env additions."""
    bots = []
    source = 'default'

    file_config = _bots_from_file()
    if file_config is not None:
        bots.extend(file_config.get('bots', []))
        source = 'config file'
    else:
        default = {
            'bots': [
                {
                    'bot_token': 'YOUR_BOT_TOKEN_HERE',
                    'admin_user_id': 0,
                    'bot_name': 'bot_1',
                    'added': datetime.utcnow().isoformat()
                }
            ]
        }
        bots.extend(default['bots'])
        try:
            os.makedirs(BOTS_DIR, exist_ok=True)
            with open(BOTS_CONFIG, 'w') as f:
                json.dump(default, f, indent=2)
        except Exception as exc:
            logger.error(f"Failed to create default bots config: {exc}")

    env_config = _bots_from_env()
    if env_config:
        existing_tokens = {bot['bot_token'] for bot in bots}
        added = 0
        for bot in env_config.get('bots', []):
            if bot['bot_token'] in existing_tokens:
                logger.info("Skipping env bot token already present in file/default config")
                continue
            bots.append(bot)
            added += 1
        if added:
            logger.info(f"Merged {added} bot(s) from environment with {source} bots")

    return {'bots': bots}

def is_admin_for_bot(user_id, bot_token):
    """Check if user is admin for this bot"""
    config = load_bots_config()
    for bot in config['bots']:
        if bot['bot_token'] == bot_token and bot['admin_user_id'] == user_id:
            return True
    return False

def get_admin_id_for_bot(bot_token):
    """Get admin ID for bot token"""
    config = load_bots_config()
    for bot in config['bots']:
        if bot['bot_token'] == bot_token:
            return bot['admin_user_id']
    return None

# Command Handlers (Keep all your existing command handlers - they'll work with the new session management)

async def start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Start command - admin only"""
    user_id = update.effective_user.id
    bot_token = context.bot.token
    
    if not is_admin_for_bot(user_id, bot_token):
        await update.message.reply_text("❌ Access denied. Admin only.")
        return
    
    # Get user's Telegram username
    user = update.effective_user
    if user.username:
        user_display = f"@{user.username}"
    elif user.first_name:
        user_display = user.first_name
    else:
        user_display = "Admin"
    
    account = get_admin_account(user_id, bot_token)
    
    if account.is_logged_in():
        # Already logged in - show main menu
        keyboard = [
            [InlineKeyboardButton("📊 Status", callback_data='status')],
            [InlineKeyboardButton("📝 Messages", callback_data='messages')],
            [InlineKeyboardButton("🚀 Auto-Plug", callback_data='autoplug')]
        ]
        
        session_user = account.config.get('username', 'Unknown')
        
        welcome_text = f"""🤖 Auto-Plug Bot 

Welcome back, {user_display}! 👋

✅ **Session Active**
📱 Logged in as: {session_user}
👥 Groups: {len(account.groups)}
📝 Messages: {len(account.messages)}
{'🟢 Auto-Plug: Running' if account.is_running else '🔴 Auto-Plug: Stopped'}
🛡️ Stripe Checker: /stripecheck (paste or upload up to 100 cards)

Choose an option below:"""
    else:
        # Not logged in - show setup
        keyboard = [
            [InlineKeyboardButton("⚙️ Setup Account", callback_data='setup')],
            [InlineKeyboardButton("📊 Status", callback_data='status')]
        ]
        
        welcome_text = f"""🤖 Auto-Plug Bot 

Welcome {user_display}! 👋

🔐 **First time setup:**
Click "Setup Account" to get started

📝 **You'll need:**
• API_ID & API_HASH from https://my.telegram.org
• Your phone number
• Run /stripecheck to validate up to 100 cards at once

After setup, you can auto-plug to all your groups!"""

    reply_markup = InlineKeyboardMarkup(keyboard)
    await update.message.reply_text(welcome_text, reply_markup=reply_markup)

async def setup_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Setup credentials"""
    user_id = update.effective_user.id
    bot_token = context.bot.token
    
    if not is_admin_for_bot(user_id, bot_token):
        await update.message.reply_text("❌ Access denied")
        return
    
    help_text = """🔐 Setup Your Account

Send: /setcredentials <API_ID> <API_HASH> <PHONE>

**Example:**
`/setcredentials 12345678 abcdef1234567890 +1234567890`

📝 Get credentials:
1. https://my.telegram.org
2. Login → API development tools
3. Create app
4. Copy API_ID and API_HASH

⚠️ Phone must include country code"""
    
    await update.message.reply_text(help_text, parse_mode='Markdown')

async def setcredentials(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Set credentials"""
    user_id = update.effective_user.id
    bot_token = context.bot.token
    
    if not is_admin_for_bot(user_id, bot_token):
        await update.message.reply_text("❌ Access denied")
        return
    
    if len(context.args) != 3:
        await update.message.reply_text(
            "❌ Format: /setcredentials <API_ID> <API_HASH> <PHONE>\n\n"
            "Example: /setcredentials 12345678 abcdef123 +1234567890"
        )
        return
    
    api_id, api_hash, phone = context.args
    
    if not api_id.isdigit():
        await update.message.reply_text("❌ API_ID must be numeric")
        return
    
    if not phone.startswith('+'):
        await update.message.reply_text("❌ Phone must start with + and country code")
        return
    
    account = get_admin_account(user_id, bot_token)
    account.set_credentials(api_id, api_hash, phone)

    await update.message.reply_text("✅ Credentials saved!\n\nNow use /login")

async def login_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Login"""
    user_id = update.effective_user.id
    bot_token = context.bot.token
    
    if not is_admin_for_bot(user_id, bot_token):
        await update.message.reply_text("❌ Access denied")
        return
    
    account = get_admin_account(user_id, bot_token)
    
    if not account.is_configured():
        await update.message.reply_text("❌ Use /setup first")
        return
    
    await update.message.reply_text("🔐 Logging in...")
    
    success, message = await account.login()
    
    if success:
        await update.message.reply_text(f"✅ {message}")
        count, msg = await account.refresh_groups()
        await update.message.reply_text(f"🔄 {msg}")
    else:
        await update.message.reply_text(f"📱 {message}")

async def code_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Verify code"""
    user_id = update.effective_user.id
    bot_token = context.bot.token
    
    if not is_admin_for_bot(user_id, bot_token):
        await update.message.reply_text("❌ Access denied")
        return
    
    account = get_admin_account(user_id, bot_token)
    
    if len(context.args) != 1:
        await update.message.reply_text("Usage: /code <code>")
        return
    
    code = context.args[0]
    
    if not account.client:
        await update.message.reply_text("❌ Use /login first")
        return
    
    success, message = await account.verify_code(code)
    await update.message.reply_text(message)
    
    if success:
        count, msg = await account.refresh_groups()
        await update.message.reply_text(f"🔄 {msg}")

async def logout_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Logout"""
    user_id = update.effective_user.id
    bot_token = context.bot.token
    
    if not is_admin_for_bot(user_id, bot_token):
        await update.message.reply_text("❌ Access denied")
        return
    
    account = get_admin_account(user_id, bot_token)
    
    if account.is_running:
        account.set_auto_plug_running(False)
    
    if account.client:
        await account.client.disconnect()
        account.client = None
    
    session_path = f'{account.session_file}.session'
    if os.path.exists(session_path):
        os.remove(session_path)
    
    account.config['logged_in'] = False
    account.save_config()
    
    await update.message.reply_text("✅ Logged out and session cleared")

async def status_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Status"""
    user_id = update.effective_user.id
    bot_token = context.bot.token
    
    if not is_admin_for_bot(user_id, bot_token):
        await update.message.reply_text("❌ Access denied")
        return
    
    account = get_admin_account(user_id, bot_token)
    
    keyboard = [
        [InlineKeyboardButton("🔄 Refresh Groups", callback_data='refresh')],
        [InlineKeyboardButton("🚀 Plug Now", callback_data='plugnow')],
        [InlineKeyboardButton("▶️ Start Auto", callback_data='startauto'),
         InlineKeyboardButton("⏹️ Stop Auto", callback_data='stopauto')]
    ]
    reply_markup = InlineKeyboardMarkup(keyboard)
    
    await update.message.reply_text(account.get_status(), reply_markup=reply_markup, parse_mode='Markdown')

async def addmessage(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Add message"""
    user_id = update.effective_user.id
    bot_token = context.bot.token
    
    if not is_admin_for_bot(user_id, bot_token):
        await update.message.reply_text("❌ Access denied")
        return
    
    context.user_data['waiting_for_message'] = True
    await update.message.reply_text("📝 Send the message to add:")

async def listmessages(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """List messages"""
    user_id = update.effective_user.id
    bot_token = context.bot.token
    
    if not is_admin_for_bot(user_id, bot_token):
        await update.message.reply_text("❌ Access denied")
        return
    
    account = get_admin_account(user_id, bot_token)
    
    if not account.messages:
        await update.message.reply_text("❌ No messages")
        return
    
    text = f"📝 Your Messages ({len(account.messages)}):\n\n"
    for i, msg in enumerate(account.messages, 1):
        preview = msg[:80] + "..." if len(msg) > 80 else msg
        text += f"{i}. {preview}\n\n"
    
    await update.message.reply_text(text)

async def removemessage(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Remove message"""
    user_id = update.effective_user.id
    bot_token = context.bot.token
    
    if not is_admin_for_bot(user_id, bot_token):
        await update.message.reply_text("❌ Access denied")
        return
    
    account = get_admin_account(user_id, bot_token)

    if len(context.args) != 1:
        await update.message.reply_text("Usage: /removemessage <number>")
        return
    
    try:
        index = int(context.args[0]) - 1
        if 0 <= index < len(account.messages):
            account.messages.pop(index)
            account.save_messages()
            await update.message.reply_text(f"✅ Removed message #{index + 1}")
        else:
            await update.message.reply_text(f"❌ Invalid (1-{len(account.messages)})")
    except ValueError:
        await update.message.reply_text("❌ Must be number")

async def clearmessages(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Clear all messages"""
    user_id = update.effective_user.id
    bot_token = context.bot.token
    
    if not is_admin_for_bot(user_id, bot_token):
        await update.message.reply_text("❌ Access denied")
        return
    
    account = get_admin_account(user_id, bot_token)
    count = len(account.messages)
    account.messages = []
    account.save_messages()
    
    await update.message.reply_text(f"✅ Cleared {count} messages")

async def setinterval(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Set interval"""
    user_id = update.effective_user.id
    bot_token = context.bot.token
    
    if not is_admin_for_bot(user_id, bot_token):
        await update.message.reply_text("❌ Access denied")
        return
    
    account = get_admin_account(user_id, bot_token)
    
    if len(context.args) != 1:
        await update.message.reply_text("Usage: /setinterval <hours>\n\nExample: /setinterval 1.5")
        return
    
    try:
        interval = float(context.args[0])
        if interval < 0.5:
            await update.message.reply_text("❌ Minimum 0.5 hours")
            return
        
        account.interval = interval
        account.config['interval'] = interval
        account.save_config()
        
        await update.message.reply_text(f"✅ Interval: {interval}h")
    except ValueError:
        await update.message.reply_text("❌ Must be number")

async def refreshgroups_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Refresh groups"""
    user_id = update.effective_user.id
    bot_token = context.bot.token
    
    if not is_admin_for_bot(user_id, bot_token):
        await update.message.reply_text("❌ Access denied")
        return
    
    account = get_admin_account(user_id, bot_token)
    await update.message.reply_text("🔄 Refreshing groups...")
    count, msg = await account.refresh_groups()
    await update.message.reply_text(f"✅ {msg}")

async def plugnow_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Plug now"""
    user_id = update.effective_user.id
    bot_token = context.bot.token
    
    if not is_admin_for_bot(user_id, bot_token):
        await update.message.reply_text("❌ Access denied")
        return
    
    account = get_admin_account(user_id, bot_token)
    
    if not account.messages:
        await update.message.reply_text("❌ Add messages first with /addmessage")
        return
    
    await update.message.reply_text(f"🚀 Sending to {len(account.groups)} groups...")
    result = await account.send_plugs()
    
    response = (
    f"✅ Plug Complete!\n\n"
    f"📝 Message Used:\n{result['message_sent']}\n\n"
    f"📤 Sent: {result['success']}\n"
    f"❌ Failed: {result['failed']}\n"
    f"📊 Total Plugs: {account.total_plugs}\n\n"
)

    
    # Show successful groups
    if result['success_list']:
        response += f"✅ Sent to:\n"
        for title in result['success_list'][:10]:
            response += f"• {title}\n"
        if len(result['success_list']) > 10:
            response += f"• ... and {len(result['success_list']) - 10} more\n"
        response += "\n"
    
    # Show failed groups
    if result['failed_list']:
        response += f"❌ Failed:\n"
        for item in result['failed_list'][:10]:
            response += f"• {item['title']}: {item['error']}\n"
        if len(result['failed_list']) > 10:
            response += f"• ... and {len(result['failed_list']) - 10} more\n"
    
    await update.message.reply_text(response)

async def startauto_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Start auto"""
    user_id = update.effective_user.id
    bot_token = context.bot.token
    
    if not is_admin_for_bot(user_id, bot_token):
        await update.message.reply_text("❌ Access denied")
        return
    
    account = get_admin_account(user_id, bot_token)
    
    if account.is_running:
        await update.message.reply_text("⚠️ Already running")
        return
    
    if not account.messages:
        await update.message.reply_text("❌ Add messages first with /addmessage")
        return

    chat_id = update.effective_chat.id
    account.set_auto_plug_running(True, chat_id)
    account.auto_task = asyncio.create_task(account.auto_plug_loop(context.bot, chat_id))

    await update.message.reply_text(
        f"✅ Auto-Plug Started!\n\n"
        f"📊 Groups: {len(account.groups)}\n"
        f"📝 Messages: {len(account.messages)}\n"
        f"⏱️ Interval: {account.interval}h"
    )

async def stopauto_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Stop auto"""
    user_id = update.effective_user.id
    bot_token = context.bot.token

    if not is_admin_for_bot(user_id, bot_token):
        await update.message.reply_text("❌ Access denied")
        return

    account = get_admin_account(user_id, bot_token)

    if not account.is_running:
        await update.message.reply_text("⚠️ Not running")
        return

    account.set_auto_plug_running(False)
    await update.message.reply_text("✅ Auto-Plug Stopped!")


async def _run_stripe_from_text(update: Update, context: ContextTypes.DEFAULT_TYPE, raw_text: str):
    """Helper to trigger Stripe checks from text or file content."""
    context.user_data['awaiting_stripe_input'] = False
    await stripe_checker.run_checks(raw_text, context.bot, update.effective_chat.id)


async def stripecheck_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Start Stripe check for a block of cards (up to 100)."""
    user_id = update.effective_user.id
    bot_token = context.bot.token

    if not is_admin_for_bot(user_id, bot_token):
        await update.message.reply_text("❌ Access denied")
        return

    text_after_command = update.message.text.split(' ', 1)
    card_block = text_after_command[1].strip() if len(text_after_command) > 1 else ""

    if card_block:
        await _run_stripe_from_text(update, context, card_block)
        return

    context.user_data['awaiting_stripe_input'] = True
    await update.message.reply_text(
        "🛡️ Send cards to check with Stripe.\n\n"
        "• Format: CARD|MM|YYYY|CVV\n"
        "• Up to 100 lines per run\n"
        "• You can paste text or upload a .txt file"
    )


async def handle_document(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Handle uploaded documents for Stripe checks."""
    user_id = update.effective_user.id
    bot_token = context.bot.token

    if not is_admin_for_bot(user_id, bot_token):
        return

    if not context.user_data.get('awaiting_stripe_input'):
        return

    document = update.message.document
    try:
        file = await document.get_file()
        content = await file.download_as_bytearray()
        text = content.decode('utf-8', errors='ignore')
    except Exception as exc:  # noqa: BLE001
        await update.message.reply_text(f"❌ Couldn't read file: {exc}")
        context.user_data['awaiting_stripe_input'] = False
        return

    await _run_stripe_from_text(update, context, text)

async def handle_message(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Handle text messages"""
    user_id = update.effective_user.id
    bot_token = context.bot.token

    if not is_admin_for_bot(user_id, bot_token):
        return

    if context.user_data.get('awaiting_stripe_input'):
        await _run_stripe_from_text(update, context, update.message.text)
        return

    if context.user_data.get('waiting_for_message'):
        account = get_admin_account(user_id, bot_token)
        message_text = update.message.text
        
        if len(message_text) < 10:
            await update.message.reply_text("❌ Too short (min 10 chars)")
            return
        
        # Optional: Check message limit (set to 20)
        MAX_MESSAGES = 20
        if len(account.messages) >= MAX_MESSAGES:
            await update.message.reply_text(f"❌ Maximum {MAX_MESSAGES} messages allowed!\n\nUse /removemessage <n> to remove old ones first.")
            context.user_data['waiting_for_message'] = False
            return
        
        account.messages.append(message_text)
        account.save_messages()
        context.user_data['waiting_for_message'] = False
        
        await update.message.reply_text(
            f"✅ Message added!\n\n"
            f"Total: {len(account.messages)}\n\n"
            f"Use /addmessage to add more"
        )

async def button_callback(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Handle buttons"""
    query = update.callback_query
    await query.answer()
    
    user_id = query.from_user.id
    bot_token = context.bot.token
    
    if not is_admin_for_bot(user_id, bot_token):
        await query.message.reply_text("❌ Access denied")
        return
    
    account = get_admin_account(user_id, bot_token)
    
    if query.data == 'setup':
        await query.message.reply_text(
            "🔐 Setup\n\n"
            "/setcredentials <API_ID> <API_HASH> <PHONE>\n\n"
            "Get from: https://my.telegram.org",
            parse_mode='Markdown'
        )
    
    elif query.data == 'status':
        keyboard = [
            [InlineKeyboardButton("🔄 Refresh Groups", callback_data='refresh')],
            [InlineKeyboardButton("🚀 Plug Now", callback_data='plugnow')],
            [InlineKeyboardButton("▶️ Start Auto", callback_data='startauto'),
             InlineKeyboardButton("⏹️ Stop Auto", callback_data='stopauto')]
        ]
        reply_markup = InlineKeyboardMarkup(keyboard)
        await query.message.reply_text(account.get_status(), reply_markup=reply_markup, parse_mode='Markdown')
    
    elif query.data == 'messages':
        keyboard = [
            [InlineKeyboardButton("➕ Add", callback_data='addmsg')],
            [InlineKeyboardButton("📋 List", callback_data='listmsg')],
            [InlineKeyboardButton("🔙 Back", callback_data='back')]
        ]
        reply_markup = InlineKeyboardMarkup(keyboard)
        await query.message.reply_text("📝 Messages:", reply_markup=reply_markup)
    
    elif query.data == 'addmsg':
        context.user_data['waiting_for_message'] = True
        await query.message.reply_text("📝 Send message:")
    
    elif query.data == 'listmsg':
        if not account.messages:
            await query.message.reply_text("❌ No messages")
        else:
            text = f"📝 Messages ({len(account.messages)}):\n\n"
            for i, msg in enumerate(account.messages, 1):
                preview = msg[:80] + "..." if len(msg) > 80 else msg
                text += f"{i}. {preview}\n\n"
            await query.message.reply_text(text)
    
    elif query.data == 'refresh':
        await query.message.reply_text("🔄 Refreshing...")
        count, msg = await account.refresh_groups()
        await query.message.reply_text(f"✅ {msg}")
    
    elif query.data == 'plugnow':
        if not account.messages:
            await query.message.reply_text("❌ Add messages first")
            return
        
        await query.message.reply_text(f"🚀 Sending to {len(account.groups)} groups...")
        result = await account.send_plugs()
        
        # Detailed response
        response = f"✅ Plug Complete!\n\n"
        response += f"📝 Message Used:\n{result['message_sent']}\n\n"
        response += f"📤 Sent: {result['success']}\n"
        response += f"❌ Failed: {result['failed']}\n"
        response += f"📊 Total Plugs: {account.total_plugs}\n\n"
        
        # Show successful groups
        if result['success_list']:
            response += f"✅ Sent to:\n"
            for title in result['success_list'][:10]:
                response += f"• {title}\n"
            if len(result['success_list']) > 10:
                response += f"• ... and {len(result['success_list']) - 10} more\n"
            response += "\n"
        
        # Show failed groups
        if result['failed_list']:
            response += f"❌ Failed:\n"
            for item in result['failed_list'][:10]:
                response += f"• {item['title']}: {item['error']}\n"
            if len(result['failed_list']) > 10:
                response += f"• ... and {len(result['failed_list']) - 10} more\n"
        
        await query.message.reply_text(response)
    
    elif query.data == 'startauto':
        if account.is_running:
            await query.message.reply_text("⚠️ Already running")
            return
        
        if not account.messages:
            await query.message.reply_text("❌ Add messages first")
            return
        
        account.set_auto_plug_running(True, query.message.chat_id)
        account.auto_task = asyncio.create_task(account.auto_plug_loop(context.bot, query.message.chat_id))
        
        await query.message.reply_text(
            f"✅ Auto-Plug Started!\n\n"
            f"📊 Groups: {len(account.groups)}\n"
            f"📝 Messages: {len(account.messages)}\n"
            f"⏱️ Interval: {account.interval}h"
        )
    
    elif query.data == 'stopauto':
        if not account.is_running:
            await query.message.reply_text("⚠️ Not running")
            return
        
        account.set_auto_plug_running(False)
        await query.message.reply_text("✅ Auto-Plug Stopped!")
    
    elif query.data == 'autoplug':
        keyboard = [
            [InlineKeyboardButton("▶️ Start", callback_data='startauto')],
            [InlineKeyboardButton("⏹️ Stop", callback_data='stopauto')],
            [InlineKeyboardButton("🔙 Back", callback_data='back')]
        ]
        reply_markup = InlineKeyboardMarkup(keyboard)
        await query.message.reply_text(
            f"🚀 Auto-Plug\n\n"
            f"Status: {'🟢 Running' if account.is_running else '🔴 Stopped'}\n"
            f"Interval: {account.interval}h\n\n"
            f"Use /setinterval <hours> to change",
            reply_markup=reply_markup
        )
    
    elif query.data == 'back':
        # Get user display name
        user = query.from_user
        if user.username:
            user_display = f"@{user.username}"
        elif user.first_name:
            user_display = user.first_name
        else:
            user_display = "Admin"
        
        if account.is_logged_in():
            keyboard = [
                [InlineKeyboardButton("📊 Status", callback_data='status')],
                [InlineKeyboardButton("📝 Messages", callback_data='messages')],
                [InlineKeyboardButton("🚀 Auto-Plug", callback_data='autoplug')]
            ]
            session_user = account.config.get('username', 'Unknown')
            text = f"""🤖 Auto-Plug Bot 

Welcome back, {user_display}! 👋

✅ **Session Active**
📱 Logged in as: {session_user}
👥 Groups: {len(account.groups)}
📝 Messages: {len(account.messages)}
{'🟢 Auto-Plug: Running' if account.is_running else '🔴 Auto-Plug: Stopped'}

Choose an option below:"""
        else:
            keyboard = [
                [InlineKeyboardButton("⚙️ Setup Account", callback_data='setup')],
                [InlineKeyboardButton("📊 Status", callback_data='status')]
            ]
            text = f"""🤖 Auto-Plug Bot 

Welcome {user_display}! 👋

🔐 **First time setup:**
Click "Setup Account" to get started"""
        
        reply_markup = InlineKeyboardMarkup(keyboard)
        await query.message.reply_text(text, reply_markup=reply_markup, parse_mode='Markdown')

def create_bot_application(token):
    """Create bot application"""
    app = Application.builder().token(token).build()
    
    # Add handlers
    app.add_handler(CommandHandler("start", start))
    app.add_handler(CommandHandler("setup", setup_command))
    app.add_handler(CommandHandler("setcredentials", setcredentials))
    app.add_handler(CommandHandler("login", login_command))
    app.add_handler(CommandHandler("code", code_command))
    app.add_handler(CommandHandler("logout", logout_command))
    app.add_handler(CommandHandler("status", status_command))
    app.add_handler(CommandHandler("addmessage", addmessage))
    app.add_handler(CommandHandler("listmessages", listmessages))
    app.add_handler(CommandHandler("removemessage", removemessage))
    app.add_handler(CommandHandler("clearmessages", clearmessages))
    app.add_handler(CommandHandler("setinterval", setinterval))
    app.add_handler(CommandHandler("stripecheck", stripecheck_command))
    app.add_handler(CommandHandler("refreshgroups", refreshgroups_command))
    app.add_handler(CommandHandler("plugnow", plugnow_command))
    app.add_handler(CommandHandler("startauto", startauto_command))
    app.add_handler(CommandHandler("stopauto", stopauto_command))
    app.add_handler(CallbackQueryHandler(button_callback))
    app.add_handler(MessageHandler(filters.Document.ALL, handle_document))
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, handle_message))

    return app

async def restart_auto_plugs():
    """Restart auto-plugs for all admins with proper session isolation"""
    config = load_bots_config()
    valid_bots = [b for b in config['bots'] if b['bot_token'] != 'YOUR_BOT_TOKEN_HERE' and b['admin_user_id'] != 0]
    
    for bot_config in valid_bots:
        bot_token = bot_config['bot_token']
        admin_id = bot_config['admin_user_id']
        
        try:
            account = get_admin_account(admin_id, bot_token)
            
            if not (account.is_logged_in() and account.is_running and account.last_chat_id):
                continue
            
            # Create bot instance for this specific token
            bot = Bot(token=bot_token)
            
            # Start auto-plug loop
            account.auto_task = asyncio.create_task(
                account.auto_plug_loop(bot, account.last_chat_id)
            )
            logger.info(f"Restarted auto-plug for admin {admin_id}")
            
        except Exception as e:
            logger.error(f"Failed to restart auto-plug for admin {admin_id}: {e}")

async def delayed_start(coroutine, bot, chat_id, delay=0):
    if delay > 0:
        await asyncio.sleep(delay)
    await coroutine(bot, chat_id)

async def cleanup_all_sessions():
    """Cleanup all sessions on shutdown"""
    for key, account in admin_accounts.items():
        try:
            if account.is_running:
                account.set_auto_plug_running(False)
            
            if account.client and account.client.is_connected():
                await account.client.disconnect()
                
            if account.auto_task and not account.auto_task.done():
                account.auto_task.cancel()
        except Exception as e:
            logger.error(f"Cleanup error for {key}: {e}")

async def run_all_bots():
    """Run all configured bots"""
    config = load_bots_config()
    
    if not config['bots']:
        print("❌ No bots configured!")
        print(f"Edit {BOTS_CONFIG}")
        return
    
    # Filter valid bots
    valid_bots = [b for b in config['bots'] if b['bot_token'] != 'YOUR_BOT_TOKEN_HERE' and b['admin_user_id'] != 0]
    
    if not valid_bots:
        print("❌ No valid bots configured!")
        print(f"Edit {BOTS_CONFIG} and set bot_token and admin_user_id")
        return
    
    print(f"\n✅ Loading {len(valid_bots)} bots...\n")
    
    # Create applications
    applications = []
    for bot in valid_bots:
        try:
            app = create_bot_application(bot['bot_token'])
            applications.append((bot['bot_name'], bot['admin_user_id'], app))
            print(f"✅ {bot['bot_name']} (Admin: {bot['admin_user_id']}) loaded")
        except Exception as e:
            print(f"❌ {bot['bot_name']} failed: {e}")
    
    if not applications:
        print("❌ No bots started!")
        return
    
    print(f"\n🚀 Starting {len(applications)} bots...\n")
    
    # Initialize all apps
    for name, admin_id, app in applications:
        await app.initialize()
        await app.start()
        print(f"✅ {name} started (Admin: {admin_id})")

    print("\n" + "="*60)
    print("🤖 All Bots Running!")
    print("="*60)
    print("\n📱 Admins can now message their bots")
    print("💬 Use /start to begin\n")

    # ✅ FIXED: Restart auto-plugs for all admins
    await restart_auto_plugs()

    # Start polling for all
    async with asyncio.TaskGroup() as tg:
        for name, admin_id, app in applications:
            tg.create_task(app.updater.start_polling(allowed_updates=Update.ALL_TYPES))

    # Keep running
    await asyncio.Event().wait()

def main():
    print("""
╔══════════════════════════════════════════════╗
║  🤖 Admin-Only Auto-Plug Bot Manager        ║
║  Fixed Multi-Session + Multi-Bot Support    ║
╚══════════════════════════════════════════════╝
    """)
    try:
        asyncio.run(run_all_bots())
    except KeyboardInterrupt:
        print("\n\n🛑 Shutting down all bots...")
        asyncio.run(cleanup_all_sessions())
        print("👋 Stopped")
    except Exception as e:
        print(f"\n❌ Error: {e}")
        asyncio.run(cleanup_all_sessions())
        import traceback
        traceback.print_exc()

if __name__ == '__main__':
    main()
