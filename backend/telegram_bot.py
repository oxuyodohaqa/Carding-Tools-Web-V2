"""Telegram bot interface for Carding Tools V2.

Commands:
- /start or /help: Show usage instructions.
- /generate <BIN|MM|YYYY|CVV>: Generate a single card (month/year/cvv optional).
- /generate_bin <visa|mastercard|amex|discover> [random|database]: Generate a BIN.
- /check_bin <bin>: Look up BIN information from the CSV database.
- /check <CARD|MM|YYYY|CVV>: Run the Stripe checker for a card.

Set TELEGRAM_BOT_TOKEN in the environment before running this module.
"""
from __future__ import annotations

import logging
import os

from telegram import Update
from telegram.ext import ApplicationBuilder, CommandHandler, ContextTypes

from dotenv import load_dotenv

from backend.server import (
    generate_bin,
    generate_card,
    get_random_bin_from_database,
    get_total_bins,
    lookup_bin,
    parse_card_input,
    process_card,
)

logging.basicConfig(
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s", level=logging.INFO
)
logger = logging.getLogger(__name__)


load_dotenv()


def _require_token() -> str:
    token = os.getenv("TELEGRAM_BOT_TOKEN")
    if not token:
        raise RuntimeError(
            "TELEGRAM_BOT_TOKEN environment variable is required to run the bot."
        )
    return token


async def start(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """Send a help message with available commands."""
    message = (
        "Welcome to Carding Tools V2 on Telegram!\n\n"
        "Commands:\n"
        "• /generate <BIN|MM|YYYY|CVV> — Generate one card.\n"
        "• /generate_bin <visa|mastercard|amex|discover> [random|database] — Generate a BIN.\n"
        "• /check_bin <bin> — Lookup BIN details.\n"
        "• /check <CARD|MM|YYYY|CVV> — Run Stripe checker for a card.\n\n"
        "Bot username: @itsmeaab (set in BotFather)."
    )
    await update.message.reply_text(message)


async def generate(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """Generate a single card from the provided BIN and optional fields."""
    if not context.args:
        await update.message.reply_text(
            "Usage: /generate <BIN|MM|YYYY|CVV> — e.g. /generate 424242|12|2028|123"
        )
        return

    bin_input = context.args[0]
    month = context.args[1] if len(context.args) > 1 else None
    year = context.args[2] if len(context.args) > 2 else None
    cvv = context.args[3] if len(context.args) > 3 else None

    card = generate_card(bin_input, month, year, cvv)
    await update.message.reply_text(f"Generated card: {card}")


async def generate_bin_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """Generate a BIN, optionally using the bundled database."""
    card_type = context.args[0].lower() if context.args else "visa"
    mode = context.args[1].lower() if len(context.args) > 1 else "random"

    if mode == "database":
        bin_data = get_random_bin_from_database(card_type)
        if not bin_data:
            await update.message.reply_text(
                "No matching BINs found in the database. Try /generate_bin <type> random."
            )
            return

        response = (
            "BIN from database:\n"
            f"BIN: {bin_data['bin']}\n"
            f"Brand: {bin_data['brand']}\n"
            f"Type: {bin_data['type']}\n"
            f"Category: {bin_data['category']}\n"
            f"Issuer: {bin_data['issuer']}\n"
            f"Country: {bin_data['country']}\n"
        )
        await update.message.reply_text(response)
        return

    bin_number = generate_bin(card_type)
    await update.message.reply_text(f"Generated BIN: {bin_number}")


async def check_bin_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """Lookup BIN information."""
    if not context.args:
        await update.message.reply_text("Usage: /check_bin <bin>")
        return

    bin_number = context.args[0]
    if not bin_number.isdigit() or len(bin_number) != 6:
        await update.message.reply_text("BIN must be 6 digits.")
        return

    result = lookup_bin(bin_number)
    total_bins = get_total_bins()

    if not result:
        await update.message.reply_text(
            f"BIN not found. Database contains {total_bins} entries."
        )
        return

    response = (
        "BIN details:\n"
        f"BIN: {result['bin']}\n"
        f"Brand: {result['brand']}\n"
        f"Type: {result['type']}\n"
        f"Category: {result['category']}\n"
        f"Issuer: {result['issuer']}\n"
        f"Country: {result['country']}\n"
        f"Database size: {total_bins}"
    )
    await update.message.reply_text(response)


async def check_card_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """Run the Stripe checker for a single card."""
    if not context.args:
        await update.message.reply_text(
            "Usage: /check <CARD|MM|YYYY|CVV> — e.g. /check 4242424242424242|12|2028|123"
        )
        return

    card_text = " ".join(context.args)
    card = parse_card_input(card_text)
    if not card:
        await update.message.reply_text("Invalid format. Use CARD|MM|YYYY|CVV.")
        return

    result = await process_card({}, card)
    status = result.get("status", "UNKNOWN")
    message = result.get("message", "")
    response_excerpt = result.get("response", "")

    reply = (
        f"Card: {result.get('card', card_text)}\n"
        f"Status: {status}\n"
        f"Message: {message}\n"
    )
    if response_excerpt:
        reply += f"Response snippet: {response_excerpt[:200]}"

    await update.message.reply_text(reply)


async def help_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    await start(update, context)


def main() -> None:
    token = _require_token()
    application = ApplicationBuilder().token(token).build()

    application.add_handler(CommandHandler("start", start))
    application.add_handler(CommandHandler("help", help_command))
    application.add_handler(CommandHandler("generate", generate))
    application.add_handler(CommandHandler("generate_bin", generate_bin_command))
    application.add_handler(CommandHandler("check_bin", check_bin_command))
    application.add_handler(CommandHandler("check", check_card_command))

    logger.info("Starting Telegram bot with username @itsmeaab")
    application.run_polling()


if __name__ == "__main__":
    main()
