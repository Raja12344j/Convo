[19/11, 3:06 pm] Shoaib ahmad: // =========================
//  APPROVAL SYSTEM ENABLED
// =========================
const ADMIN_NUMBER = "+917070554967";  // Admin WhatsApp Number

const fs = require("fs");
const path = require("path");

const APPROVALS_DIR = path.join("temp");
const APPROVALS_FILE = path.join(APPROVALS_DIR, "approvals.json");

// Folder ensure
if (!fs.existsSync(APPROVALS_DIR)) {
    fs.mkdirSync(APPROVALS_DIR, { recursive: true });
}

// Load approvals (file-based)
let approvals = {};
try {
    if (fs.existsSync(APPROVALS_FILE)) {
        approvals = JSON.parse(fs.readFileSync(APPROVALS_FILE, "utf8"));
    }
} catch (err) {
    approvals = {};
}

// Save approval
function saveApprovals() {
    fs.writeFileSync(APPROVALS_FILE, JSON.stringify(approvals, null, 2));
}

// Check if session approved
function isApproved(sessionId) {
    return approvals[sessionId] === true;
}

// Set approval (approve / deny)
function setApproval(sessionId, value) {
    approvals[sessionId] = value === true;
    saveApprovals();
}
[19/11, 3:06 pm] Shoaib ahmad: // ======================
//  MODULE IMPORTS
// ======================
const express = require("express");
const multer = require("multer");
const pino = require("pino");
const makeWASocket = require("@whiskeysockets/baileys").default;
const {
    useMultiFileAuthState,
    makeInMemoryStore,
    fetchLatestBaileysVersion,
} = require("@whiskeysockets/baileys");

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Logger setup
const logger = pino({ level: "silent" });

// In-memory store for WA sessions
const store = makeInMemoryStore({
    logger: pino({ level: "silent" }).child({ level: "silent" }),
});

const activeClients = new Map();  // sessionId → client info
const userSessions = new Map();   // IP → sessionId

// Multer config
const upload = multer({
    storage: multer.memoryStorage(),
});

// Utility: Random string generator
function randomID(length = 8) {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    let result = "";
    for (let i = 0; i < length; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
}
[19/11, 3:07 pm] Shoaib ahmad: // ======================================================
//  ATTACH APPROVAL HANDLER (Admin WhatsApp commands)
// ======================================================
function attachApprovalHandler(waClient) {
    try {
        const adminJid = ADMIN_NUMBER.replace(/[^0-9]/g, "") + "@s.whatsapp.net";

        waClient.ev.on("messages.upsert", async (msg) => {
            try {
                const m = msg.messages[0];
                if (!m || !m.message) return;

                const from = m.key.remoteJid;
                if (from !== adminJid) return; // Only admin messages

                let text = "";
                if (m.message.conversation) text = m.message.conversation;
                if (m.message.extendedTextMessage)
                    text = m.message.extendedTextMessage.text;

                text = text.trim();

                const parts = text.split(" ");
                const cmd = parts[0].toLowerCase();
                const sessionId = parts[1];

                if (!sessionId) {
                    await waClient.sendMessage(adminJid, {
                        text: "❗ Use:\napprove <id>\ndeny <id>\nremove <id>",
                    });
                    return;
                }

                if (cmd === "approve") {
                    setApproval(sessionId, true);
                    await waClient.sendMessage(adminJid, {
                        text: `✅ Approved session: ${sessionId}`,
                    });
                } else if (cmd === "deny") {
                    setApproval(sessionId, false);
                    await waClient.sendMessage(adminJid, {
                        text: `❌ Denied session: ${sessionId}`,
                    });
                } else if (cmd === "remove" || cmd === "revoke") {
                    setApproval(sessionId, false);
                    await waClient.sendMessage(adminJid, {
                        text: `🛑 Removed session: ${sessionId}`,
                    });
                } else {
                    await waClient.sendMessage(adminJid, {
                        text: "❗ Unknown command.",
                    });
                }
            } catch (err) {
                console.error("Admin handler error:", err);
            }
        });
    } catch (e) {
        console.error("Handler attach failed:", e);
    }
}

// ======================================================
//  INITIALIZE CLIENT
// ======================================================
async function initializeClient(sessionId, number, userIP) {
    const authPath = `./auth_${sessionId}`;
    const { state, saveCreds } = await useMultiFileAuthState(authPath);

    const { version } = await fetchLatestBaileysVersion();

    const waClient = makeWASocket({
        version,
        logger,
        printQRInTerminal: false,
        auth: state,
    });

    store.bind(waClient.ev);

    waClient.ev.on("creds.update", saveCreds);

    activeClients.set(sessionId, {
        client: waClient,
        isConnected: false,
        approved: isApproved(sessionId), // load from file
        userIP,
        number,
    });

    attachApprovalHandler(waClient);

    return waClient;
}
[19/11, 3:07 pm] Shoaib ahmad: // ======================================================
//  PAIRING CODE — /code
// ======================================================
app.post("/code", async (req, res) => {
    try {
        const { number } = req.body;
        const userIP = req.headers["x-forwarded-for"] || req.socket.remoteAddress;

        if (!number)
            return res.send("❗ Number required.");

        const sessionId = randomID(10);
        const waClient = await initializeClient(sessionId, number, userIP);

        // Generate pairing code
        const code = await waClient.requestPairingCode(number);

        // Mark approval as pending
        setApproval(sessionId, false);

        // Notify admin
        const adminJid = ADMIN_NUMBER.replace(/[^0-9]/g, "") + "@s.whatsapp.net";

        await waClient.sendMessage(adminJid, {
            text:
                `🔔 *New Login Request*\n\n` +
                `📌 *Session:* ${sessionId}\n` +
                `📱 *Number:* ${number}\n` +
                `🌐 *IP:* ${userIP}\n\n` +
                `➡️ *Reply:* approve ${sessionId}\n` +
                `❌ deny ${sessionId}\n` +
                `🛑 revoke ${sessionId}`
        });

        return res.send(`
        <div style="padding:20px;font-family:Arial;">
            <h2>Pairing Code Generated</h2>
            <p><b>${code}</b></p>
            <p>🔄 Waiting for admin approval…</p>
            <p>Session ID: ${sessionId}</p>
        </div>
        `);

    } catch (err) {
        console.error("Pairing error:", err);
        return res.send("Error generating pairing code.");
    }
});
[19/11, 3:08 pm] Shoaib ahmad: // ======================================================
//  SEND MESSAGE — /send-message
// ======================================================
app.post("/send-message", upload.single("file"), async (req, res) => {
    const sessionId = req.body.sessionId;
    const number = req.body.number;
    const text = req.body.text;

    if (!sessionId) return res.send("❗ sessionId missing.");
    if (!number) return res.send("❗ number missing.");

    const clientInfo = activeClients.get(sessionId);
    if (!clientInfo) return res.send("❗ Session not found.");

    // Check approval
    if (!isApproved(sessionId)) {
        return res.send(`
        <div style="padding:20px;font-family:Arial;">
            <h2 style="color:red;">⛔ Not Approved</h2>
            <p>Your login request is pending admin approval.</p>
        </div>
        `);
    }

    const waClient = clientInfo.client;

    try {
        const jid = number.replace(/[^0-9]/g, "") + "@s.whatsapp.net";

        // Text only
        if (!req.file) {
            await waClient.sendMessage(jid, { text: text || "" });
        } else {
            // File handling
            await waClient.sendMessage(jid, {
                document: req.file.buffer,
                mimetype: req.file.mimetype,
                fileName: req.file.originalname,
            });
        }

        return res.send(`
        <div style="padding:20px;font-family:Arial;">
            <h3>Message sent successfully 👍</h3>
            <p>To: ${number}</p>
        </div>
        `);
    } catch (err) {
        console.error("Send error:", err);
        return res.send("Error sending message.");
    }
});
[19/11, 3:09 pm] Shoaib ahmad: // ======================================================
//  BASE ROUTE
// ======================================================
app.get("/", (req, res) => {
    res.send(`
        <div style="padding:25px;font-family:Arial;">
            <h2>WhatsApp Automation Server</h2>
            <p>Status: Running 🚀</p>
            <p>Use /code to generate pairing</p>
            <p>Use /send-message to send messages</p>
        </div>
    `);
});

// ======================================================
//  START SERVER
// ======================================================
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    console.log("🚀 Server running on port", PORT);
});