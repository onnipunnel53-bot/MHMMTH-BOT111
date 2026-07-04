# Telegram MV Bot

A Telegram bot that searches admin-added websites for downloadable files and sends them directly to users.

---

## Setup

### 1. Install dependencies
cd telegram-bot
npm install

### 2. Configure environment
cp .env.example .env

Fill in BOT_TOKEN and ADMIN_ID in the .env file.
- Get BOT_TOKEN from @BotFather
- Get ADMIN_ID from @userinfobot

### 3. Run the bot
npm start

---

## Commands

| Command              | Who        | Description          |
|----------------------|------------|----------------------|
| /start               | Everyone   | Welcome message      |
| /help                | Everyone   | Show help            |
| /mv movie name       | Everyone   | Search for a file    |
| /addsite name | url  | Admin only | Add a website        |
| /listsites           | Admin only | List websites        |
| /removesite name     | Admin only | Remove a website     |

Plain text also works as a search — just type the name.

---

## File Structure

telegram-bot/
├── index.js       ← Main bot logic
├── package.json   ← Dependencies
├── .env           ← Your secrets (never share)
├── .env.example   ← Template
├── sites.json     ← Stored websites (auto-managed)
└── downloads/     ← Temp files (auto-created, auto-deleted)
