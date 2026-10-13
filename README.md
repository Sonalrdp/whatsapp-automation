# WhatsApp Automation Bot 24/7

A lightweight, production-ready WhatsApp automation bot built using Node.js and `@whiskeysockets/baileys` (WebSocket-based, avoiding Puppeteer resource bloat). Features a gorgeous glassmorphic web dashboard, database session persistence (PostgreSQL), and scheduling configured to run 24/7 on Render.

## Features
- **Authentication**: Link your WhatsApp easily using a QR code displayed directly on the web dashboard.
- **Persistent Sessions**: Powered by PostgreSQL database session storage, meaning the bot stays logged in even when the server restarts or container builds trigger on Render.
- **Daily Scheduled Message**: Sends a daily "hlo" (or custom text) to a target contact at a scheduled morning hour (default `09:00 AM IST`).
- **PDF Forwarder**: Automatically detects incoming PDF documents from the target contact, downloads them, and forwards them to a configured group.
- **Web Control Panel**: Real-time monitoring UI showing connection state, log terminal, group list dropdown, and configuration settings.

---

## 🛠️ Local Development Setup

To run and test the bot on your local computer:

### 1. Prerequisites
- **Node.js**: Ensure you have Node.js installed (v18 or higher recommended).
- **Git**: Installed for managing the code repository.

### 2. Installation
Open your terminal in the project directory and run:
```bash
npm install
```

### 3. Run Locally (File-Based Auth fallback)
When running locally without a database, the bot automatically falls back to storing credentials in local files inside the `./auth_info/` folder.
Run:
```bash
npm run dev
```
Once started:
1. Open `http://localhost:3000` in your web browser.
2. Scan the displayed QR Code using your phone's WhatsApp application (**WhatsApp > Linked Devices > Link a Device**).
3. Set your target phone number (include country code, without `+` or spaces, e.g., `919876543210`).
4. Select or enter the target group JID (the list of your active groups will load automatically after connecting).
5. Adjust the daily message text and time, then click **Save**.
6. You can click **Send Test Message** to verify linking.

---

## 🚀 Deployment to Render (24/7 Free Hosting)

Follow these steps to deploy this bot to the cloud, ensuring it runs 24/7 without needing your computer turned on.

### Step 1: Upload Your Code to GitHub
1. Create a new repository on your GitHub account (make it Private if you want to protect your code).
2. Initialize Git in your local folder and push your code:
   ```bash
   git init
   git add .
   git commit -m "initial commit"
   git branch -M main
   git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPO_NAME.git
   git push -u origin main
   ```

### Step 2: Spin Up a Render PostgreSQL Database
*Render containers have ephemeral file systems, meaning local session files disappear whenever Render restarts the app. Using a PostgreSQL database guarantees your session remains connected.*

1. Log into your [Render Dashboard](https://dashboard.render.com/).
2. Click **New > PostgreSQL**.
3. Set a name for your database (e.g., `whatsapp-db`).
4. Select the **Free** tier.
5. Click **Create Database**.
6. Wait for the database status to become "Active". Copy the **Internal Database URL** (e.g., `postgresql://...`).

### Step 3: Deploy the Web Service on Render
1. On the Render Dashboard, click **New > Web Service**.
2. Select **Build and deploy from a Git repository** and connect your GitHub repo.
3. Configure the Web Service settings:
   - **Name**: `whatsapp-bot`
   - **Runtime**: `Node`
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Instance Type**: Select the **Free** tier.
4. Click **Advanced** and add the following **Environment Variables**:
   - `DATABASE_URL`: *(Paste the Internal Database URL you copied in Step 2)*
   - `PORT`: `10000`
5. Click **Create Web Service**.

Render will now build your app and deploy it. Once the build finishes, you will see a live URL (e.g. `https://whatsapp-bot-xxxx.onrender.com`).

---

## ⏰ Keeping the Bot Awake 24/7 (Preventing Spin-Down)

Render's free tier web services automatically spin down (go to sleep) after 15 minutes of inactivity. When asleep, your WhatsApp socket connection will drop. 

**To keep the bot awake 24/7, set up an external pinging service:**

1. Copy your live Render URL (e.g., `https://whatsapp-bot-xxxx.onrender.com`).
2. Go to a free monitoring service like [UptimeRobot](https://uptimerobot.com/) or [cron-job.org](https://cron-job.org/).
3. Create a new HTTP monitor pointing to your bot's liveness endpoint:
   ```text
   https://whatsapp-bot-xxxx.onrender.com/ping
   ```
4. Set the monitoring interval to **every 10 minutes**.
5. This sends a lightweight request to the bot continuously, preventing the Render free tier from going to sleep.

---

## 📖 How to Link & Configure on Production
1. Once deployed, open your live Render app URL in your browser.
2. Scan the QR code with your phone. 
3. After the status changes to **Connected**, fill in the **Bot Configurations** card.
4. Group selection will load all your active groups dynamically, so you can select the target group easily from the dropdown.
5. Click **Save and Apply Settings**.
6. The bot is now running persistently. You can close the browser tab, and the bot will continue processing 24/7.
