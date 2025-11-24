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

from telegram import InlineKeyboardButton, InlineKeyboardMarkup, Update
from telegram.error import BadRequest
from telegram.ext import (
    ApplicationBuilder,
    CallbackQueryHandler,
    CommandHandler,
    ContextTypes,
)

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
        "🤖 Welcome to Carding Tools V2 on Telegram!\n\n"
        "✨ Pick an action below or use the commands:"
    )
    buttons = _build_main_buttons()

    # Send the animation first (no buttons) so the inline keyboard lives on a text message
    # that can be edited safely by callbacks.
    await update.message.reply_animation(
        animation="https://media.giphy.com/media/v1.Y2lkPTc5MGI3NjExdXc5bGM5emloM2VyYXNibDJlc3l2bTVhZGw3OXV4b3Zydm9nZmt4diZlcD12MV9pbnRlcm5hbF9naWZfYnlfaWQmY3Q9Zw/j5QcmXoFWlDz13mRUu/giphy.gif",
        caption=message,
    )

    # Place the inline buttons on a plain text message so Telegram can edit it when users
    # tap the callbacks (avoids BadRequest: There is no text in the message).
    await update.message.reply_text(message, reply_markup=InlineKeyboardMarkup(buttons))


def _build_main_buttons() -> list[list[InlineKeyboardButton]]:
    return [
        [
            InlineKeyboardButton("⚡️ Generate 10 Cards", callback_data="ACTION_GENERATE_CARDS"),
            InlineKeyboardButton("🎯 Generate BIN", callback_data="TEMPLATE_GENERATE_BIN"),
        ],
        [
            InlineKeyboardButton("🔎 Check BIN", callback_data="TEMPLATE_CHECK_BIN"),
            InlineKeyboardButton("🛡️ Check Card", callback_data="TEMPLATE_CHECK_CARD"),
        ],
        [InlineKeyboardButton("📊 Live Status", callback_data="SHOW_STATUS")],
    ]


def _format_cards_with_country(card_type: str = "visa", amount: int = 10) -> tuple[str, InlineKeyboardMarkup]:
    bin_data = get_random_bin_from_database(card_type)
    fallback_bin = generate_bin(card_type)

    header_bin = bin_data["bin"] if bin_data else fallback_bin
    header_country = bin_data["country"] if bin_data else "Unknown"
    header_brand = bin_data["brand"] if bin_data else card_type.title()
    header = (
        "⚡️ Generated cards\n"
        f"BIN: {header_bin}\n"
        f"Brand: {header_brand}\n"
        f"Country: {header_country}\n\n"
        f"Showing {amount} cards (random month/year/CVV):"
    )

    cards = [generate_card(header_bin) for _ in range(amount)]
    body = "\n".join(f"{idx + 1}. {card}" for idx, card in enumerate(cards))

    buttons = InlineKeyboardMarkup(
        [
            [InlineKeyboardButton("🔄 Generate 10 more", callback_data="ACTION_GENERATE_CARDS")],
            [
                InlineKeyboardButton("⬅️ Back", callback_data="SHOW_MENU"),
                InlineKeyboardButton("📊 Status", callback_data="SHOW_STATUS"),
            ],
        ]
    )

    return f"{header}\n\n{body}", buttons


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
        await update.message.reply_text(
            "Card number invalid — must be 13–19 digits and Luhn-valid"
        )
        return
    waiting_message = await update.message.reply_text(
        "⏳ Checking card with Stripe..."
    )

    result = await process_card({}, card)
    status = result.get("status", "UNKNOWN")
    message = result.get("message", "")
    response_excerpt = result.get("response", "")

    emoji = "✅" if status.upper() == "APPROVED" else "❌" if status.upper() == "DECLINED" else "⚠️"
    reply = (
        f"{emoji} Card: {result.get('card', card_text)}\n"
        f"Status: {status}\n"
        f"Message: {message}\n"
    )
    if response_excerpt:
        reply += f"Response snippet: {response_excerpt[:200]}"

    await waiting_message.edit_text(reply)


async def _send_status(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    total_bins = get_total_bins()
    status_message = (
        "📊 Live Status\n"
        "• 🤖 Bot: Online\n"
        "• 🗄️ BIN Database: Loaded with "
        f"{total_bins} entries\n"
        "• ⚙️ Checker: Ready for Stripe tests\n"
        "• 📱 Platform: Works on PC & Pterodactyl®"
    )

    buttons = InlineKeyboardMarkup(
        [
            [InlineKeyboardButton("⚡️ Generate 10 Cards", callback_data="ACTION_GENERATE_CARDS")],
            [InlineKeyboardButton("⬅️ Back", callback_data="SHOW_MENU")],
        ]
    )

    if update.callback_query:
        await update.callback_query.answer("Status refreshed ✨")
        await _edit_or_send(update.callback_query, status_message, buttons)
    else:
        await update.message.reply_text(status_message, reply_markup=buttons)


async def help_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    await start(update, context)


async def handle_buttons(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    query = update.callback_query
    if not query:
        return

    await query.answer()
    data = query.data

    templates = {
        "TEMPLATE_GENERATE": "⚡️ Use /generate <BIN|MM|YYYY|CVV> — example: /generate 424242|12|2028|123",
        "TEMPLATE_GENERATE_BIN": "🎯 Use /generate_bin <visa|mastercard|amex|discover> [random|database]",
        "TEMPLATE_CHECK_BIN": "🔎 Use /check_bin <bin> — example: /check_bin 424242",
        "TEMPLATE_CHECK_CARD": "🛡️ Use /check <CARD|MM|YYYY|CVV> — example: /check 4242424242424242|12|2028|123",
    }

    if data == "ACTION_GENERATE_CARDS":
        message, buttons = _format_cards_with_country()
        await _edit_or_send(query, message, buttons)
    elif data == "SHOW_MENU":
        await _edit_or_send(
            query,
            "🤖 Back to menu — pick an action:",
            InlineKeyboardMarkup(_build_main_buttons()),
        )
    elif data == "SHOW_STATUS":
        await _send_status(update, context)
    elif data in templates:
        await _edit_or_send(query, templates[data])
    else:
        await _edit_or_send(query, "Use /help to see all commands.")


async def _edit_or_send(
    query, text: str, reply_markup: InlineKeyboardMarkup | None = None
) -> None:
    """Edit the callback message when possible, otherwise send a fresh reply.

    Some Telegram callbacks can arrive on messages that only contain captions
    (e.g., animations). Editing those messages triggers ``BadRequest: There is no
    text in the message``. This helper edits text messages when available and
    falls back to replying so inline buttons remain functional.
    """

    try:
        if query.message and query.message.text:
            await query.edit_message_text(text, reply_markup=reply_markup)
            return

        # If the message is media-only (caption) or missing entirely, send a new reply
        # to keep the user flow alive without raising BadRequest.
        if query.message:
            await query.message.reply_text(text, reply_markup=reply_markup)
        else:
            await query.from_user.send_message(text, reply_markup=reply_markup)
    except BadRequest as exc:  # pragma: no cover - network-side safety net
        logger.warning("Falling back to reply_text after BadRequest", exc_info=exc)
        if query.message:
            await query.message.reply_text(text, reply_markup=reply_markup)
        else:
            await query.from_user.send_message(text, reply_markup=reply_markup)


def main() -> None:
    token = _require_token()
    application = ApplicationBuilder().token(token).build()

    application.add_handler(CommandHandler("start", start))
    application.add_handler(CommandHandler("help", help_command))
    application.add_handler(CommandHandler("status", _send_status))
    application.add_handler(CommandHandler("generate", generate))
    application.add_handler(CommandHandler("generate_bin", generate_bin_command))
    application.add_handler(CommandHandler("check_bin", check_bin_command))
    application.add_handler(CommandHandler("check", check_card_command))
    application.add_handler(CallbackQueryHandler(handle_buttons))

    logger.info("Starting Telegram bot with username @itsmeaab")
    application.run_polling()


if __name__ == "__main__":
    main()
