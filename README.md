# Carding Tools V2

![Python](https://img.shields.io/badge/Python-3.11+-3776AB?style=for-the-badge&logo=python&logoColor=white)
![Flask](https://img.shields.io/badge/Flask-000000?style=for-the-badge&logo=flask&logoColor=white)
![License](https://img.shields.io/badge/License-Educational-orange?style=for-the-badge)
![Status](https://img.shields.io/badge/Status-Active-success?style=for-the-badge)
[![Live Preview](https://img.shields.io/badge/Live%20Preview-Open%20Demo-4c1?style=for-the-badge)](https://cardingtoolsv2.vercel.app/)
[![Discord](https://img.shields.io/badge/Discord-Join%20Us-5865F2?style=for-the-badge&logo=discord&logoColor=white)](https://discord.gg/rgWcEw5G8a)

A modern, professional web application for credit card testing and validation. Built with Flask, featuring an animated UI, Stripe API integration, and advanced security measures.

## 🎯 What's New in V2

### Major Features
- **🔥 Stripe Checker** - Real-time card validation using Stripe's payment API through charity:water donation endpoint
- **🎨 Animated Background** - Interactive diagonal moving squares grid with hover effects
- **🌓 Theme Toggle** - Seamless dark/light mode with persistent localStorage
- **🔒 API Security** - Base64 obfuscated Stripe keys to prevent theft when deployed
- **✨ Modern UI** - Glassmorphic design with gradient animations and smooth transitions
- **📱 Fully Responsive** - Optimized for both desktop and mobile devices

### Improvements Over V1
- **Better Card Validation**: Stripe API integration provides real-world card testing vs Luhn-only validation
- **Enhanced Security**: Obfuscated API keys in code for Vercel/production deployment
- **Modern Design**: Complete UI overhaul with Inter & Outfit fonts, animated gradients
- **Smoother UX**: Fade & slide animations, no scrollbars, better tab navigation
- **Professional Tools**: 4 specialized tools instead of general-purpose generators

## 🛠️ Features

### 1. Card Generator
- Generate Luhn-validated card numbers with custom BIN prefix
- Optional month (MM), year (YYYY), and CVV inputs (auto-generated if empty)
- Bulk generation: 1-100 cards
- Copy all cards or clear results
- Output format: `CARDNUMBER|MM|YYYY|CVV`

### 2. BIN Generator
- **Two Generation Modes:**
  - **Generate Randomly**: Creates random BINs with appropriate prefix for selected card type
  - **Grab from Database**: Fetches random BINs from database with complete valid information (no N/A values)
- Select card type: Visa, Mastercard, American Express, Discover
- Bulk generation with amount selector (1-100)
- Output displays BIN numbers only (6 digits)
- Copy all and clear functionality

### 3. BIN Checker
- Look up BIN details (Brand, Type, Category, Issuer, Country)
- Bulk checking support (multiple BINs, one per line)
- Validates BIN format (must be 6 digits)
- Progress bar showing check completion
- Real-time results display

### 4. Stripe Checker ⭐ NEW
- **Real Stripe API validation** through charity:water donation endpoint
- Paste bulk cards (one per line) to check against Stripe
- **6-second delay between checks** to prevent rate limiting and avoid conflicts with the API
- Real-time results with color-coded status:
  - ✅ **Green** = Approved/Success
  - ❌ **Red** = Declined/Failed  
  - ⚠️ **Yellow** = Unknown response
- Progress bar and countdown timer
- Results display one by one as they complete

> ⚠️ **Note**: The Stripe Checker uses a live charity donation endpoint. This may stop working in the future if the API is updated or the endpoint changes. The 6-second delay is crucial to prevent overwhelming the server and avoid getting your IP blocked.

## 🎨 UI Features

- **Animated Squares Background** - Diagonal moving grid with interactive hover effects
- **Theme Toggle** - Dark/light mode with smooth transitions (persisted in localStorage)
- **Gradient Header** - Animated color-shifting "Carding Tools V2" title
- **Modern Typography** - Google Fonts (Inter for body, Outfit for headers)
- **Smooth Animations** - Fade & slide transitions between tabs
- **Glassmorphic Cards** - Transparent containers with backdrop blur
- **No Scrollbars** - Clean UI without visible scrollbars (scrolling still works)
- **Responsive Grid** - Tabs adapt: 4 columns (desktop), 2 columns (mobile)

## 🔒 Security Features

- **Obfuscated API Keys** - Stripe key encoded with base64 to prevent easy theft
- **Rate Limiting** - 6-second delays between Stripe checks
- **Vercel Ready** - Includes vercel.json and requirements.txt for deployment
- **No Environment Variables Required** - Keys embedded (obfuscated) in code

## 📁 Tech Stack

- **Backend**: Python Flask
- **Frontend**: Vanilla JavaScript, CSS3
- **Dependencies**: aiohttp, fake-useragent
- **Deployment**: Vercel-ready with vercel.json
- **Fonts**: Google Fonts (Inter, Outfit)

## 🚀 API Endpoints

- `POST /generate` - Generate Luhn-validated cards
- `POST /generate_bin` - Generate BIN by card type
- `POST /check_bin` - Check BIN details
- `POST /check` - Validate card against Stripe API

## 📦 Deployment

### Local Development
```bash
pip install -r requirements.txt
python app.py
```

### Telegram Bot
Run the tools on Telegram with your bot (for example `@itsmeaab`).

```bash
export TELEGRAM_BOT_TOKEN="<your-bot-token>"
python -m backend.telegram_bot
```

#### New interactive UI
- Inline buttons (Generate Card/BIN, Check BIN/Card, Live Status)
- Animated welcome GIF + emoji-rich responses
- `/status` command shows live BIN count and readiness

#### Run from VS Code on your laptop

1. Install [VS Code](https://code.visualstudio.com/) and the **Python** extension.
2. Clone this repository and open the folder in VS Code.
3. Copy the sample environment file and paste your bot token (for example the one you sent: `8482984175:AAFC-gyiLIB1gBnWwqYX1ix85BPIFXNfJM8`).

   ```bash
   cp .env.example .env
   echo "TELEGRAM_BOT_TOKEN=8482984175:AAFC-gyiLIB1gBnWwqYX1ix85BPIFXNfJM8" > .env
   ```

4. Install the Python dependencies inside VS Code's terminal:

   ```bash
   pip install -r requirements.txt
   ```

5. Start the bot from VS Code using **Run and Debug ▸ Run Telegram Bot** (provided in `.vscode/launch.json`) or run it manually:

   ```bash
   python -m backend.telegram_bot
   ```

If you prefer Windows PowerShell, replace the `echo` command above with:

```powershell
Set-Content -Path .env -Value 'TELEGRAM_BOT_TOKEN=8482984175:AAFC-gyiLIB1gBnWwqYX1ix85BPIFXNfJM8'
python -m backend.telegram_bot
```

#### Run on Pterodactyl® or other panels
1. Create a new **Python 3.11** (or newer) server/egg.
2. Upload the repository files (or pull from Git) into the container.
3. Add an environment variable named `TELEGRAM_BOT_TOKEN` with your bot token.
4. Set the startup/entry command to:

   ```bash
   python -m backend.telegram_bot
   ```

5. Start the server. The bot uses long polling, so it runs fine without webhooks.

### Vercel Deployment
1. Push to GitHub
2. Import to Vercel
3. Deploy automatically (vercel.json configured)

## 📝 Usage

### Card Generator
1. Enter BIN prefix (or leave empty for random)
2. Optionally set month, year, CVV (auto-generated if empty)
3. Set amount (1-100 cards)
4. Click "Generate Cards"
5. Copy all or clear results

### Stripe Checker
1. Paste cards in format: `CARDNUMBER|MM|YYYY|CVV` (one per line)
2. Click "Check Cards"
3. Wait for validation (6s delay between cards)
4. View color-coded results

### BIN Generator
1. Select card type (Visa/MC/Amex/Discover)
2. Choose generation mode:
   - **Generate Randomly**: Creates random valid BINs
   - **Grab from Database**: Fetches real BINs with complete valid data
3. Set amount (1-100)
4. Click "Generate BINs"
5. Copy results

### BIN Checker
1. Enter BIN numbers (6 digits, one per line)
2. Click "Check BINs"
3. View detailed BIN information

## ⚠️ Disclaimer

This tool is for **educational and testing purposes only**. The Stripe integration uses a charity donation endpoint for validation. Do not use for illegal activities or unauthorized testing.

## 🔗 Credits

**Made by Walter**

## 📄 License

For educational purposes only.
