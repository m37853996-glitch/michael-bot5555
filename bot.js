const express = require('express');
const app = express();
const PORT = process.env.PORT || 10000;

app.get('/', (req, res) => {
    res.status(200).send('Bot is active and running 24/7 successfully!');
});

app.head('/', (req, res) => {
    res.sendStatus(200);
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Web server is running on port ${PORT}`);
});

const { Telegraf, Markup } = require("telegraf");
const fs = require("fs");
const path = require("path");
const axios = require("axios");

const bot = new Telegraf("8854896488:AAEXXUTuwpD04u-VIOmBMQr-eo_SdTytJHw");
const CHANNEL_USERNAME = "@Michaelm4kk";

const dbPath = path.join(__dirname, "cooldowns.json");
const dataPath = path.join(__dirname, "bot_data.json");
const usersJsonPath = path.join(__dirname, "users.json");
const accountsPath = path.join(__dirname, "accounts.txt");

let userLikeCooldowns = fs.existsSync(dbPath) ? JSON.parse(fs.readFileSync(dbPath, "utf8")) : {};
function saveCooldowns() { fs.writeFileSync(dbPath, JSON.stringify(userLikeCooldowns, null, 2)); }

let botData = {
  activeUsers: ["8988529781"],
  activeGroups: ["-1004308451962"],
  disabledGroups: [],
  admins: ["8988529781"],
  adminInterfaces: {},
  userGroups: {},
  notifiedUsers: [],
  groupExpiry: {},
  userExpiry: {},
  codes: {},
  groupDailyCooldowns: {},
  autoLikes: {},
  accountBatchIndex: 0,
  groupActivationTimes: {},
  groupExpiryNotified: [],
  groupLeavedGroups: {},
  groupJoinRecords: {},
  trialsClaimed: [],
  targetCooldowns: {},
  userPermissions: {},
  groupPermissions: {},
  spamActiveAccounts: {},
  spamFfActiveAccounts: {},
  bannedOrBlocked: [],
  globalTargetLimits: {},
  groupUserAttempts: {},
  isBotGloballyPaused: false,
  pauseStartTime: null,
  totalPausedDuration: 0
};

const processingUsers = new Set();
const taskQueue = [];
let isProcessingQueue = false;

const MAX_QUEUE_SIZE = 30;
const QUEUE_DELAY_MS = 300;
function enqueueLikeTask(targetUid) {
  return new Promise((resolve, reject) => {
    targetUid = String(targetUid).trim();
    if (processingUsers.has(targetUid)) return reject(new Error("DUPLICATE_UID"));
    if (taskQueue.length >= MAX_QUEUE_SIZE) return reject(new Error("QUEUE_FULL"));
    processingUsers.add(targetUid);
    taskQueue.push({ targetUid, resolve, reject });
    processQueue();
  });
}

async function processQueue() {
  if (isProcessingQueue || taskQueue.length === 0) return;
  isProcessingQueue = true;
  const task = taskQueue.shift();
  try {
    const result = await sendLikesApiDirect(task.targetUid);
    task.resolve(result);
  } catch (err) {
    task.reject(err);
  } finally {
    processingUsers.delete(task.targetUid);
    isProcessingQueue = false;
    setTimeout(processQueue, QUEUE_DELAY_MS);
  }
}

if (fs.existsSync(dataPath)) {
  try {
    const loaded = JSON.parse(fs.readFileSync(dataPath, "utf8"));
    Object.assign(botData, loaded);
  } catch (e) {}
}

function saveData() { fs.writeFileSync(dataPath, JSON.stringify(botData, null, 2)); }
if (botData.isBotGloballyPaused && !botData.pauseStartTime) {
  botData.pauseStartTime = Date.now();
  saveData();
}
const DEVELOPER_ID = "8988529781";
const isAdmin = (id) => botData.admins.includes(id.toString()) || id.toString() === DEVELOPER_ID;
const isDev = (id) => id.toString() === DEVELOPER_ID;
const getAdminInterface = (id) => {
  if (isDev(id)) return "all";
  return (botData.adminInterfaces && botData.adminInterfaces[id.toString()]) || "all";
};
function getAdjustedExpiry(originalExpiry) {
  if (!originalExpiry) return null;
  let currentPauseTimeAdded = 0;
  if (botData.isBotGloballyPaused && botData.pauseStartTime) {
    currentPauseTimeAdded = Date.now() - botData.pauseStartTime;
  }
  let historicalPauseAdjusted = botData.totalPausedDuration || 0;
  return originalExpiry + historicalPauseAdjusted + currentPauseTimeAdded;
}

function escapeMarkdown(text) {
  if (!text) return "";
  return text.toString()
    .replace(/\\/g, '\\\\').replace(/_/g, '\\_').replace(/\*/g, '\\*')
    .replace(/`/g, '\\`').replace(/\[/g, '\\[').replace(/\]/g, '\\]')
    .replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

function getAccounts() {
  if (!fs.existsSync(accountsPath)) return [];
  const data = fs.readFileSync(accountsPath, "utf8");
  return data.split("\n").map(acc => acc.trim()).filter(acc => acc.length > 0);
}

async function checkSubscription(ctx, userId) {
  try {
    const member = await ctx.telegram.getChatMember(CHANNEL_USERNAME, userId);
    return ['creator', 'administrator', 'member'].includes(member.status);
  } catch (e) {
    return false;
  }
}

function isUserActive(userId) {
  if (isAdmin(userId)) return true;
  if (!botData.activeUsers.includes(userId)) return false;
  const expiry = botData.userExpiry[userId];
  if (!expiry) return false;
  const adjustedExpiry = getAdjustedExpiry(expiry);
  if (adjustedExpiry && adjustedExpiry < Date.now()) return false;
  return true;
}

function isGroupActive(chatId) {
  if (!botData.activeGroups.includes(chatId)) return false;
  const expiry = botData.groupExpiry[chatId];
  if (!expiry) return false;
  const adjustedExpiry = getAdjustedExpiry(expiry);
  if (adjustedExpiry && adjustedExpiry < Date.now()) return false;
  return true;
}

async function resolveChatId(ctx, input) {
  if (!input) return null;
  let cleanInput = input.trim();
  if (/^-?\d+$/.test(cleanInput)) {
    return cleanInput;
  }
  if (cleanInput.includes("t.me/")) {
    let clean = cleanInput.split("t.me/")[1];
    clean = clean.split("?")[0].split("/")[0].trim();
    cleanInput = clean.startsWith("+") ? clean : (clean.startsWith("@") ? clean : "@" + clean);
  } else if (!cleanInput.startsWith("@")) {
    cleanInput = "@" + cleanInput;
  }
  try {
    const chatInfo = await ctx.telegram.getChat(cleanInput);
    return chatInfo.id.toString();
  } catch (e) {
    return null;
  }
}

function getUserActiveSpamCount(userId, type = 'all') {
  if (!botData.spamActiveAccounts) botData.spamActiveAccounts = {};
  if (!botData.spamFfActiveAccounts) botData.spamFfActiveAccounts = {};
  const now = Date.now();
  const COOLDOWN_6H = 6 * 60 * 60 * 1000;
  let activeUids = new Set();

  for (const [uid, data] of Object.entries(botData.spamActiveAccounts)) {
    if (now - data.timestamp >= COOLDOWN_6H) {
      delete botData.spamActiveAccounts[uid];
    } else if (data.userId === userId) {
      activeUids.add(uid);
    }
  }

  for (const [uid, data] of Object.entries(botData.spamFfActiveAccounts)) {
    if (now - data.timestamp >= COOLDOWN_6H) {
      delete botData.spamFfActiveAccounts[uid];
    } else if (data.userId === userId) {
      activeUids.add(uid);
    }
  }

  saveData();
  return activeUids.size;
}

async function checkBotPermissions(ctx) {
  try {
    const botId = ctx.botInfo ? ctx.botInfo.id : (await ctx.telegram.getMe()).id;
    const member = await ctx.telegram.getChatMember(ctx.chat.id, botId);
    if (member.status !== 'administrator' && member.status !== 'creator') return false;
    if (member.status === 'administrator' && (member.can_send_messages === false || member.can_send_media_messages === false)) return false;
    return true;
  } catch (e) { return false; }
}

async function isGroupAdmin(ctx) {
  try {
    const m = await ctx.telegram.getChatMember(ctx.chat.id, ctx.from.id);
    return m.status === 'creator' || m.status === 'administrator';
  } catch (e) { return false; }
}

async function sendLikesApiDirect(targetUid) {
  const allAccounts = getAccounts();
  let currentBatch = [];

  if (allAccounts.length > 0) {
    const batchSize = 220;
    const totalBatches = Math.ceil(allAccounts.length / batchSize);
    if (botData.accountBatchIndex >= totalBatches) botData.accountBatchIndex = 0;
    const start = botData.accountBatchIndex * batchSize;
    currentBatch = allAccounts.slice(start, start + batchSize);
    botData.accountBatchIndex = (botData.accountBatchIndex + 1) % totalBatches;
    saveData();
  }

  const beforeRes = await axios.get("http://de26.spaceify.eu:26080/info", { params: { uid: targetUid }, timeout: 15000 });
  if (!beforeRes || !beforeRes.data || !beforeRes.data.basicInfo || !beforeRes.data.basicInfo.nickname) {
    throw new Error("INVALID_UID");
  }
  const beforeLikes = beforeRes.data.basicInfo.liked || 0;
  const nickname = escapeMarkdown(beforeRes.data.basicInfo.nickname);
  const level = beforeRes.data.basicInfo.level || 0;

  try {
    await axios.get("http://de26.spaceify.eu:26080/like", { params: { uid: targetUid, accounts: currentBatch.join(",") }, timeout: 25000 });
  } catch (e) {}

  const afterRes = await axios.get("http://de26.spaceify.eu:26080/info", { params: { uid: targetUid }, timeout: 15000 });
  const afterLikes = (afterRes && afterRes.data && afterRes.data.basicInfo) ? (afterRes.data.basicInfo.liked || beforeLikes) : beforeLikes;
  const addedLikes = afterLikes >= beforeLikes ? (afterLikes - beforeLikes) : 0;

  return { nickname, level, beforeLikes, afterLikes, addedLikes };
}
bot.on('my_chat_member', (ctx) => {
  try {
    const chatId = ctx.chat.id.toString();
    const chatTitle = ctx.chat.title || "Group";
    const chatType = ctx.chat.type;
    const newStatus = ctx.myChatMember.new_chat_member.status;

    if (['member', 'administrator', 'creator'].includes(newStatus)) {
      if (!botData.activeChannels) botData.activeChannels = {};
      botData.activeChannels[chatId] = {
        title: chatTitle,
        type: chatType,
        username: ctx.chat.username ? `@${ctx.chat.username}` : "Private",
        addedAt: Date.now()
      };
      saveData();
    }

    if (['left', 'kicked'].includes(newStatus)) {
      if (botData.activeChannels && botData.activeChannels[chatId]) {
        delete botData.activeChannels[chatId];
        saveData();
      }

      if (!botData.bannedOrBlocked) botData.bannedOrBlocked = [];
      const record = `${chatTitle} (${chatId})`;
      if (!botData.bannedOrBlocked.includes(record)) {
        botData.bannedOrBlocked.push(record);
      }
      delete botData.groupJoinRecords[chatId];
      delete botData.groupExpiry[chatId];
      delete botData.groupPermissions[chatId];
      if (botData.groupActivationTimes) delete botData.groupActivationTimes[chatId];
      const idx = botData.activeGroups.indexOf(chatId);
      if (idx !== -1) botData.activeGroups.splice(idx, 1);
      const dIdx = botData.disabledGroups.indexOf(chatId);
      if (dIdx !== -1) botData.disabledGroups.splice(dIdx, 1);
      
      if (botData.userGroups) {
        for (const uId of Object.keys(botData.userGroups)) {
          botData.userGroups[uId] = botData.userGroups[uId].filter(g => g !== chatId);
        }
      }

      saveData();
    }
  } catch (e) {}
});

bot.use(async (ctx, next) => {
  try {
    if (ctx.chat && (ctx.chat.type === 'group' || ctx.chat.type === 'supergroup')) {
      const chatId = ctx.chat.id.toString();
      const chatTitle = ctx.chat.title || "Group";
      const chatUsername = ctx.chat.username ? `@${ctx.chat.username}` : (ctx.chat.invite_link || "No Username");
      if (!botData.groupJoinRecords[chatId]) {
        botData.groupJoinRecords[chatId] = { title: chatTitle, username: chatUsername, joinedAt: Date.now() };
        saveData();
      }
    }
  } catch (e) {}
  return next();
});

bot.use(async (ctx, next) => {
  try {
    if (ctx.chat && ctx.chat.type === 'private' && ctx.from) {
      const userId = ctx.from.id.toString();
      const userName = ctx.from.first_name || "User";
      const text = ctx.message && ctx.message.text ? ctx.message.text : "";
      
      if (text.startsWith("/start") && userId !== DEVELOPER_ID) {
        await ctx.telegram.sendMessage(
          DEVELOPER_ID,
          `🚨 **New user started the bot!**\n\n👤 Name: ${userName}\n🆔 ID: \`${userId}\``,
          { parse_mode: "Markdown" }
        ).catch(() => {});
      }
    }
  } catch (e) {}
  return next();
});

bot.use(async (ctx, next) => {
  if (ctx.chat && ctx.chat.type === 'private') {
    const userId = ctx.from.id.toString();
    if (userId === DEVELOPER_ID) return next();
    
    if (ctx.callbackQuery) {
      const data = ctx.callbackQuery.data;
      if (data === "check_subscription" || data === "enter_code" || data === "to_spam_menu" || data === "to_main_menu") return next();
    }
    
    const isSubscribed = await checkSubscription(ctx, userId);
    if (!isSubscribed) {
      const subMsg = `⚠️ Sorry, channel subscription is mandatory to use the bot!\nhttps://t.me/Michaelm4kk\n📢 Please subscribe first, then click «✅ Check Subscription».`;
      const subKeyboard = Markup.inlineKeyboard([
        [Markup.button.url("📢 Subscribe to Channel", "https://t.me/Michaelm4kk")],
        [Markup.button.callback("✅ Check Subscription", "check_subscription")]
      ]);
      return ctx.reply(subMsg, { parse_mode: "Markdown", ...subKeyboard }).catch(() => {});
    }
  }
  return next();
});

bot.use(async (ctx, next) => {
  const userId = ctx.from ? ctx.from.id.toString() : "";
  if (botData.isBotGloballyPaused && userId !== DEVELOPER_ID) {
    const isStartCommand = ctx.message && ctx.message.text && ctx.message.text.startsWith("/start");
    
    if (isStartCommand) {
      const maintenanceMsg = 
        `╭━━━━━━━━━━━━━━━━━━╮\n` +
        `⚡ 𝙈𝙄𝘾𝙃𝘼𝙀𝙇 𝙀𝙇𝙄𝙏𝙀\n` +
        `╰━━━━━━━━━━━━━━━━━━╯\n\n` +
        `🛠️ Sorry, the bot is currently under maintenance.\n\n` +
        `⏳ We are working on updates to provide the best service.\n\n` +
        `💙 Thank you for your understanding.\n\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `⚡ 𝙈𝙄𝘾𝙃𝘼𝙀𝙇 𝙀𝙇𝙄𝙏𝙀`;
      
      return ctx.reply(maintenanceMsg).catch(() => {});
    }

    const pauseMsg = "⚠️ Sorry, the bot is paused by the developer. All timers are frozen!";
    if (ctx.callbackQuery) {
      return ctx.answerCbQuery(pauseMsg, { show_alert: true }).catch(() => {});
    }
    return ctx.reply(pauseMsg).catch(() => {});
  }
  return next();
});

bot.action("check_subscription", async (ctx) => {
  const userId = ctx.from.id.toString();
  if (await checkSubscription(ctx, userId)) {
    await ctx.answerCbQuery("✅ Subscription verified successfully!", { show_alert: false });
    try { await ctx.deleteMessage(); } catch (e) {}
    return ctx.reply("🎉 Subscription confirmed! Send /start to open the bot.");
  } else {
    return ctx.answerCbQuery("❌ Sorry, you haven't subscribed to the channel yet!", { show_alert: true });
  }
});
bot.start(async (ctx) => {
  const userId = ctx.from.id.toString();
  const chatId = ctx.chat.id.toString();
  const chatType = ctx.chat.type;
  const userName = ctx.from.first_name || "User";
  const startImg = "https://i.postimg.cc/HjGfMjSY/dcfd304bbad41cf055f2c9031a8d04c8.jpg";

  if (chatType === 'private') {
    if (userId !== DEVELOPER_ID) {
      if (!botData.trialsClaimed.includes(userId)) {
        botData.trialsClaimed.push(userId);
        if (!botData.activeUsers.includes(userId)) botData.activeUsers.push(userId);
        botData.userExpiry[userId] = Date.now() + (1 * 60 * 60 * 1000);
        botData.userPermissions[userId] = "all";
        saveData();

        await ctx.telegram.sendMessage(
          DEVELOPER_ID,
          `🎁 *New trial hour granted!*\n\n👤 User: ${userName}\n🆔 ID: \`${userId}\`\n⏳ Duration: 1 hour`,
          { parse_mode: "Markdown" }
        ).catch(() => {});

        const trialWelcomeMsg = 
          `╭━━━━━━━━━━━━━━━━━━╮\n` +
          `⚡ 𝙈𝙄𝘾𝙃𝘼𝙀𝙇 𝙀𝙇𝙄𝙏𝙀\n` +
          `╰━━━━━━━━━━━━━━━━━━╯\n\n` +
          `🎁 Welcome to excellence!\n\n` +
          `✅ Free trial activated successfully.\n\n` +
          `⏳ Duration: 1 hour free.\n\n` +
          `⚡ Available Services:\n` +
          `🎯 Likes\n` +
          `🚀 Spam & Teams\n\n` +
          `🔥 Enjoy Michael Elite services!\n\n` +
          `━━━━━━━━━━━━━━━━━━\n` +
          `⚡ 𝙈𝙄𝘾𝙃𝘼𝙀𝙇 𝙀𝙇𝙄𝙏𝙀`;

        await ctx.reply(trialWelcomeMsg).catch(() => {});
      }
    }
  }

  if (chatType === 'supergroup' || chatType === 'group' || chatType === 'channel') {
    const insufficientMsg = 
      `⛔ Notice | INSUFFICIENT PERMISSIONS\n\n` +
      `━━━━━━━━━━━━━━━━━━\n\n` +
      `⚠️ The bot is not active in this group or subscription expired.\n\n` +
      `🛠️ To activate contact developer:\n` +
      `👨‍💻 Developer: @m4kk6\n\n` +
      `━━━━━━━━━━━━━━━━━━\n` +
      `⚡ 𝙈𝙄𝘾𝙃𝘼𝙀𝙇 𝙀𝙇𝙄𝙏𝙀`;

    if (!isGroupActive(chatId) || botData.disabledGroups.includes(chatId) || !await checkBotPermissions(ctx)) {
      return ctx.reply(insufficientMsg);
    }
    
    const gPerm = botData.groupPermissions[chatId] || "all";
    let grpTxt = "";
    if (gPerm === "all") {
      grpTxt = "🤖 ⚡ 𝙈𝙄𝘾𝙃𝘼𝙀𝙇 BOT\n\n/like `<uid>`\n\n/spam `<uid>`\n\n/spam\\_ff `<uid>`\n\n5/`<uid>`\n6/`<uid>`\n/on\n/off";
    } else if (gPerm === "like") {
      grpTxt = "🤖 LIKE BOT\n\n/like `<uid>`\n/on\n/off";
    } else if (gPerm === "spam") {
      grpTxt = "🤖 SPAM BOT\n\n/spam `<uid>`\n/spam\\_ff `<uid>`\n\n5/`<uid>`\n6/`<uid>`\n/on\n/off";
    }
    return ctx.replyWithPhoto(startImg, { caption: grpTxt, parse_mode: "Markdown" }).catch(() => ctx.replyWithMarkdown(grpTxt));
  }

  if (chatType === 'private') {
    if (isUserActive(userId)) {
      return sendFirstMenu(ctx, startImg, userId);
    }
    const buyTxt = 
      `╭━━━━━━━━━━━━━━━━━━╮\n` +
      `⚡ 𝙈𝙄𝘾𝙃𝘼𝙀𝙇 𝙀𝙇𝙄𝙏𝙀\n` +
      `╰━━━━━━━━━━━━━━━━━━╯\n\n` +
      `⚠️ Sorry dear ${userName},\n\n` +
      `🔒 Subscription expired, services are for subscribers only.\n\n` +
      `💎 To subscribe or inquire, contact developer:\n\n` +
      `👤 @m4kk6\n\n` +
      `━━━━━━━━━━━━━━━━━━\n` +
      `⚡ 𝙈𝙄𝘾𝙃𝘼𝙀𝙇 𝙀𝙇𝙄𝙏𝙀`;

    return ctx.replyWithPhoto(startImg, {
      caption: buyTxt,
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard([
        [Markup.button.callback("🎟️ Enter Subscription Code", "enter_code")],
        [Markup.button.url("💬 Contact Developer", "https://t.me/m4kk6")]
      ])
    }).catch(() => {});
  }
});

function sendFirstMenu(ctx, imgUrl, userId) {
  const perm = isAdmin(userId) ? getAdminInterface(userId) : (botData.userPermissions[userId] || "all");
  const isSpamOnly = perm === "spam";

  let txt = isSpamOnly ? "🤖 *SPAM BOT*\n\n" : "🤖 *LIKE BOT*\n\n";
  txt += "╭───────────────╮\n" +
         "⚡ MICHAEL ELITE\n" +
         "╰───────────────╯\n\n";

  if (perm === "like" || perm === "all") {
    txt += "🎯 *User Commands*\n\n" +
           "/like `<uid>`\n↳ Send likes\n\n" +
           "/likeauto `<uid>` `<days>`\n↳ Enable auto-like\n\n" +
           "/removeauto `<uid>` `<days>`\n↳ Remove auto-like\n\n" +
           "/groups\n↳ Show active groups\n\n";
  }
  if (perm === "spam" || perm === "all") {
    txt += "🎯 *User Commands*\n\n" +
           "/spam `<uid>`\n↳ Spam team invites\n" +
           "/spam\\_ff `<uid>`\n↳ Spam friend requests\n\n" +
           "5/`<uid>`\n↳ 5-man squad\n\n" +
           "6/`<uid>`\n↳ 6-man squad\n\n";
  }

  if (isDev(userId)) {
    txt += "━━━━━━━━━━━━━━\n\n" +
           "⚙️ *Developer Commands*\n\n" +
           "/offbot\n↳ Pause bot & freeze timers ❄️\n\n" +
           "/onbot\n↳ Resume bot & timers ⚡\n\n" +
           "/gencode `<duration>` `<like/spam/all>`\n↳ Generate code\n\n" +
           "/codes\n↳ Show all codes\n\n" +
           "/cloak `<code>`\n↳ Revoke code\n\n" +
           "/users\n↳ Show stats 📊\n\n" +
           "/addgroup `<group_id>` `<user_id>` `<duration>` `<like/spam/all>`\n↳ Activate group\n\n" +
           "/remgroup `<group_id>`\n↳ Remove group\n\n" +
           "/addadmin `<id>` `<like/spam/all>`\n↳ Add admin\n\n" +
           "/remadmin `<id>`\n↳ Remove admin\n\n";
  } else if (isAdmin(userId)) {
    txt += "━━━━━━━━━━━━━━\n\n" +
           "⚙️ *Admin Commands*\n\n" +
           "/gencode `<duration>` `<like/spam/all>`\n↳ Generate code\n\n" +
           "/codes\n↳ Show your codes\n\n" +
           "/cloak `<code>`\n↳ Revoke your code\n\n";
  }

  txt += "━━━━━━━━━━━━━━\n\n" +
         "💳 Credit: @m4kk6";

  const keyboardRows = [[Markup.button.callback("📊 My Subscription Info", "show_myinfo")]];
  if (perm === "all") {
    keyboardRows.push([Markup.button.callback("➡️ Switch to " + (isSpamOnly ? "Likes" : "Spam & Teams"), isSpamOnly ? "to_main_menu" : "to_spam_menu")]);
  }
  const keyboard = Markup.inlineKeyboard(keyboardRows);

  if (ctx.callbackQuery) {
    return ctx.editMessageCaption(txt, { parse_mode: "Markdown", ...keyboard }).catch(() => {});
  }
  return ctx.replyWithPhoto(imgUrl, { caption: txt, parse_mode: "Markdown", ...keyboard }).catch(() => {});
}

async function sendMyInfo(ctx) {
  const userId = ctx.from.id.toString();
  const chatType = ctx.chat.type;

  if (chatType !== 'private') {
    return ctx.reply("⚠️ Use this command in private chat with the bot only.");
  }

  const expiry = botData.userExpiry[userId];
  const userPerm = botData.userPermissions[userId] || "all";
  let personalRemaining = "Not active / Expired ❌";

  if (isAdmin(userId)) {
    personalRemaining = "Always active (Admin ⚡)";
  } else if (expiry) {
    const adjustedExpiry = getAdjustedExpiry(expiry);
    const timeLeftMs = adjustedExpiry - Date.now();
    
    if (timeLeftMs > 0) {
      const days = Math.floor(timeLeftMs / (1000 * 60 * 60 * 24));
      const hours = Math.floor((timeLeftMs % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
      const minutes = Math.floor((timeLeftMs % (1000 * 60 * 60)) / (1000 * 60));
      personalRemaining = `${days} days, ${hours} hours, ${minutes} minutes`;
    }
  }

  let serviceTypeDesc = "All Services (Likes + Spam & Teams)";
  if (userPerm === "like") serviceTypeDesc = "Likes Only";
  if (userPerm === "spam") serviceTypeDesc = "Spam & Teams Only";

  let groupsSummary = "📌 You have no active groups.";
  if (botData.userGroups && botData.userGroups[userId] && botData.userGroups[userId].length > 0) {
    const userGList = botData.userGroups[userId];
    groupsSummary = `👥 Active groups: \`${userGList.length}\`\n`;
    
    for (const gId of userGList) {
      const record = botData.groupJoinRecords[gId] || { title: "Group" };
      const gExpiry = botData.groupExpiry[gId];
      let gTimeText = "Permanent";
      
      if (gExpiry) {
        const gTimeLeft = gExpiry - Date.now();
        if (gTimeLeft > 0) {
          const gDays = Math.floor(gTimeLeft / (1000 * 60 * 60 * 24));
          const gHours = Math.floor((gTimeLeft % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
          gTimeText = `${gDays} days, ${gHours} hours`;
        } else {
          gTimeText = "Expired ❌";
        }
      }
      groupsSummary += `• *${record.title}* ⏳ (${gTimeText})\n`;
    }
  }

  const infoMsg = 
    `╭━━━━━━━━━━━━━━━━━━╮\n` +
    `⚡ 𝙈𝙄𝘾𝙃𝘼𝙀𝙇 𝙀𝙇𝙄𝙏𝙀 - Subscription Report\n` +
    `╰━━━━━━━━━━━━━━━━━━╯\n\n` +
    `👤 *First: Personal Subscription*\n` +
    `🆔 ID: \`${userId}\`\n` +
    `🛡️ Permission: *${serviceTypeDesc}*\n` +
    `⏳ Remaining: \`${personalRemaining}\`\n\n` +
    `━━━━━━━━━━━━━━━━━━\n\n` +
    `👥 *Second: Group Subscriptions*\n` +
    `${groupsSummary}\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    `⚡ 𝙈𝙄𝘾𝙃𝘼𝙀𝙇 𝙀𝙇𝙄𝙏𝙀`;

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.url("💬 Renew or Buy via Developer", "https://t.me/m4kk6")]
  ]);

  return ctx.replyWithMarkdown(infoMsg, keyboard);
}

bot.command("myinfo", async (ctx) => sendMyInfo(ctx));
bot.action("show_myinfo", async (ctx) => {
  await ctx.answerCbQuery();
  return sendMyInfo(ctx);
});

bot.action("to_spam_menu", async (ctx) => {
  const userId = ctx.from.id.toString();
  const perm = isAdmin(userId) ? getAdminInterface(userId) : (botData.userPermissions[userId] || "all");

  if (perm !== "spam" && perm !== "all") {
    return ctx.answerCbQuery("❌ Sorry, your subscription does not support the spam interface!", { show_alert: true });
  }

  let txt = "🤖 *SPAM BOT*\n\n" +
            "╭───────────────╮\n" +
            "⚡ MICHAEL ELITE\n" +
            "╰───────────────╯\n\n" +
            "🎯 *User Commands*\n\n" +
            "/spam `<uid>`\n↳ Spam team invites\n" +
            "/spam\\_ff `<uid>`\n↳ Spam friend requests\n" +
            "5/`<uid>`\n↳ 5-man squad\n\n" +
            "6/`<uid>`\n↳ 6-man squad\n\n";

  if (isDev(userId)) {
    txt += "━━━━━━━━━━━━━━\n\n" +
           "⚙️ *Developer Commands*\n\n" +
           "/offbot\n↳ Pause bot ❄️\n\n" +
           "/onbot\n↳ Resume bot ⚡\n\n" +
           "/gencode `<duration>` `<like/spam/all>`\n↳ Generate code\n\n" +
           "/codes\n↳ Show all codes\n\n" +
           "/cloak `<code>`\n↳ Revoke code\n\n" +
           "/users\n↳ Show stats 📊\n\n" +
           "/addgroup `<group_id>` `<user_id>` `<duration>` `<like/spam/all>`\n↳ Activate group\n\n" +
           "/remgroup `<group_id>`\n↳ Remove group\n\n" +
           "/addadmin `<id>` `<like/spam/all>`\n↳ Add admin\n\n" +
           "/remadmin `<id>`\n↳ Remove admin\n\n";
  } else if (isAdmin(userId)) {
    txt += "━━━━━━━━━━━━━━\n\n" +
           "⚙️ *Admin Commands*\n\n" +
           "/gencode `<duration>` `<like/spam/all>`\n↳ Generate code\n\n" +
           "/codes\n↳ Show your codes\n\n" +
           "/cloak `<code>`\n↳ Revoke your code\n\n";
  }

  txt += "━━━━━━━━━━━━━━\n\n" +
         "💳 Credit: @m4kk6";

  let keyboardRows = [];
  if (perm === "all") {
    keyboardRows.push([Markup.button.callback("⬅️ Back to Likes", "to_main_menu")]);
  }
  keyboardRows.push([Markup.button.callback("📊 My Subscription Info", "show_myinfo")]);
  const keyboard = Markup.inlineKeyboard(keyboardRows);

  return ctx.editMessageCaption(txt, { parse_mode: "Markdown", ...keyboard }).catch(() => {});
});

bot.action("to_main_menu", async (ctx) => {
  const userId = ctx.from.id.toString();
  return sendFirstMenu(ctx, "https://i.postimg.cc/HjGfMjSY/dcfd304bbad41cf055f2c9031a8d04c8.jpg", userId);
});

bot.action("enter_code", async (ctx) => {
  await ctx.answerCbQuery();
  return ctx.replyWithMarkdown("🎟️ *Please send your activation code now:*");
});
bot.command("offbot", (ctx) => {
  const userId = ctx.from.id.toString();
  if (!isDev(userId)) return ctx.reply("❌ Developer only command.");
  if (botData.isBotGloballyPaused) {
    return ctx.reply("⚠️ Bot is already paused!");
  }
  botData.isBotGloballyPaused = true;
  botData.pauseStartTime = Date.now();
  saveData();
  return ctx.replyWithMarkdown("❄️ *Bot paused for everyone and all timers frozen successfully!*");
});

bot.command("onbot", (ctx) => {
  const userId = ctx.from.id.toString();
  if (!isDev(userId)) return ctx.reply("❌ Developer only command.");
  if (!botData.isBotGloballyPaused) {
    return ctx.reply("⚠️ Bot is running normally.");
  }
  const pauseDuration = Date.now() - botData.pauseStartTime;
  botData.totalPausedDuration = (botData.totalPausedDuration || 0) + pauseDuration;
  botData.isBotGloballyPaused = false;
  botData.pauseStartTime = null;
  saveData();
  return ctx.replyWithMarkdown("⚡ *Bot resumed and all subscriptions/timers updated successfully!*");
});

bot.command("gencode", async (ctx) => {
  const userId = ctx.from.id.toString();
  if (!isAdmin(userId)) return ctx.reply("❌ Admins only.");
  const parts = ctx.message.text.split(" ");
  const durationArg = (parts[1] || "1d").toLowerCase();
  const permType = (parts[2] || "all").toLowerCase();

  if (!['like', 'spam', 'all'].includes(permType)) {
    return ctx.reply("⚠️ Specify permission accurately:\n`like`, `spam`, or `all`");
  }

  let ms = 24 * 60 * 60 * 1000;
  let suffix = "1D";

  if (durationArg.endsWith('m')) {
    const mins = parseInt(durationArg) || 1;
    ms = mins * 60 * 1000;
    suffix = `${mins}M`;
  } else if (durationArg.endsWith('h')) {
    const hours = parseInt(durationArg) || 1;
    ms = hours * 60 * 60 * 1000;
    suffix = `${hours}H`;
  } else if (durationArg.endsWith('d') || !isNaN(durationArg)) {
    const days = parseInt(durationArg) || 1;
    ms = days * 24 * 60 * 60 * 1000;
    suffix = `${days}D`;
  }
  const code = `MICHAEL-${Math.random().toString(36).substring(2, 6).toUpperCase()}${suffix}`;
  const creatorName = ctx.from.first_name || ctx.from.username || "Admin";
  botData.codes[code] = {
    durationMs: ms,
    durationDesc: durationArg,
    permissionType: permType,
    used: false,
    createdBy: userId,
    createdByName: creatorName
  };
  saveData();

  if (!isDev(userId)) {
    await ctx.telegram.sendMessage(
      DEVELOPER_ID,
      `🆕 New code generated by admin\n\n👤 Admin: ${creatorName}\n🆔 ID: ${userId}\n🔑 Code: ${code}\n⏳ Duration: ${durationArg}\n🛡️ Interface: ${permType}`
    ).catch(() => {});
  }

  return ctx.replyWithMarkdown(`✅ *Code generated successfully:*\n🔑 \`${code}\`\n⏳ Duration: ${durationArg}\n🛡️ Permission: *${permType}*`);
});

bot.command("codes", (ctx) => {
  const userId = ctx.from.id.toString();
  if (!isAdmin(userId)) return ctx.reply("❌ Admins only.");
  const unused = Object.keys(botData.codes).filter(k => !botData.codes[k].used && (isDev(userId) || botData.codes[k].createdBy === userId));
  if (!unused.length) return ctx.reply("📌 No active codes.");
  let txt = isDev(userId) ? "📋 *All active codes:*\n\n" : "📋 *Your active codes:*\n\n";
  for (const c of unused) txt += `🔑 \`${c}\` (Duration: ${botData.codes[c].durationDesc} | Permission: ${botData.codes[c].permissionType})\n`;
  return ctx.replyWithMarkdown(txt);
});

bot.command("cloak", (ctx) => {
  const userId = ctx.from.id.toString();
  if (!isAdmin(userId)) return ctx.reply("❌ Admins only.");
  const code = (ctx.message.text.split(" ")[1] || "").trim();
  if (!code || !botData.codes[code] || (!isDev(userId) && botData.codes[code].createdBy !== userId)) return ctx.reply("❌ Code not found in your codes.");
  botData.codes[code].used = true;
  saveData();
  return ctx.replyWithMarkdown(`✅ Code revoked: \`${code}\``);
});

bot.command("users", (ctx) => {
  const userId = ctx.from.id.toString();
  if (!isDev(userId)) return ctx.reply("❌ Developer only command.");
  
  const totalSubscribers = botData.activeUsers.length;
  const totalActiveGroups = botData.activeGroups.length;
  const totalAdmins = botData.admins.length;
  const bannedList = botData.bannedOrBlocked && botData.bannedOrBlocked.length > 0 
    ? botData.bannedOrBlocked.map((g, idx) => `${idx + 1}. ${g}`).join("\n") 
    : "No groups have blocked or kicked the bot yet.";

  const statsMsg = 
    `📊 *Bot Statistics:*\n\n` +
    `👤 Subscribers: \`${totalSubscribers}\`\n` +
    `👥 Active Groups: \`${totalActiveGroups}\`\n` +
    `🛡️ Admins: \`${totalAdmins}\`\n\n` +
    `🚫 *Blocked/Kicked Groups (${botData.bannedOrBlocked ? botData.bannedOrBlocked.length : 0}):*\n` +
    `${bannedList}`;

  return ctx.replyWithMarkdown(statsMsg);
});

bot.command("addadmin", async (ctx) => {
  const userId = ctx.from.id.toString();
  if (!isDev(userId)) return ctx.reply("❌ Developer only.");
  const parts = ctx.message.text.trim().split(/\s+/);
  const uId = parts[1];
  const interfaceType = (parts[2] || "all").toLowerCase();
  if (!uId || !/^\d+$/.test(uId)) return ctx.reply("⚠️ Usage: `/addadmin <ID> <like/spam/all>`");
  if (!['like', 'spam', 'all'].includes(interfaceType)) {
    return ctx.reply("⚠️ Interface must be like, spam, or all.");
  }
  if (!botData.admins.includes(uId)) botData.admins.push(uId);
  if (!botData.adminInterfaces) botData.adminInterfaces = {};
  botData.adminInterfaces[uId] = interfaceType;
  saveData();
  await ctx.telegram.sendMessage(uId, `🎉 You are now an admin.\n🖥️ Assigned interface: ${interfaceType}`).catch(() => {});
  return ctx.replyWithMarkdown(`✅ Admin \`${uId}\` configured successfully.\n🖥️ Interface: *${interfaceType}*`);
});

bot.command("remadmin", async (ctx) => {
  const userId = ctx.from.id.toString();
  if (!isDev(userId)) return ctx.reply("❌ Developer only.");
  const uId = ctx.message.text.split(" ")[1];
  if (!uId) return ctx.reply("⚠️ Usage: `/remadmin <ID>`");
  const idx = botData.admins.indexOf(uId);
  if (idx !== -1 && uId !== DEVELOPER_ID) {
    botData.admins.splice(idx, 1);
    if (botData.adminInterfaces) delete botData.adminInterfaces[uId];
    saveData();
    await ctx.telegram.sendMessage(uId, "⚠️ Notice: You have been removed from admins.").catch(() => {});
    return ctx.replyWithMarkdown(`✅ Admin (\`${uId}\`) removed successfully.`);
  }
  return ctx.reply("❌ Cannot remove this admin.");
});

bot.command("addgroup", async (ctx) => {
  const userId = ctx.from.id.toString();
  if (!isDev(userId)) return ctx.reply("❌ Developer only.");
  const parts = ctx.message.text.split(/\s+/);
  let gInput = parts[1];
  const uId = parts[2];
  const durationArg = (parts[3] || "30d").toLowerCase();
  const groupPerm = (parts[4] || "all").toLowerCase();

  if (!gInput || !uId) {
    return ctx.replyWithMarkdown("⚠️ *Correct usage:*\n`/addgroup <group_id_or_link> <user_id> <duration> <like/spam/all>`");
  }

  if (!['like', 'spam', 'all'].includes(groupPerm)) {
    return ctx.reply("⚠️ Permission must be: `like`, `spam`, or `all`");
  }

  let gId = await resolveChatId(ctx, gInput);
  if (!gId) {
    return ctx.reply("❌ Could not find group via ID/link. Ensure bot is in the group.");
  }

  let ms = 30 * 24 * 60 * 60 * 1000;
  let durationDesc = durationArg;

  if (durationArg.endsWith('m')) {
    const mins = parseInt(durationArg) || 30;
    ms = mins * 60 * 1000;
  } else if (durationArg.endsWith('h')) {
    const hours = parseInt(durationArg) || 24;
    ms = hours * 60 * 60 * 1000;
  } else if (durationArg.endsWith('d') || !isNaN(durationArg)) {
    const days = parseInt(durationArg) || 30;
    ms = days * 24 * 60 * 60 * 1000;
  }

  if (!botData.activeGroups.includes(gId)) botData.activeGroups.push(gId);
  const nowTime = Date.now();
  botData.groupActivationTimes[gId] = nowTime;
  botData.groupExpiry[gId] = nowTime + ms;
  botData.groupPermissions[gId] = groupPerm;

  if (!botData.userGroups[uId]) botData.userGroups[uId] = [];
  if (!botData.userGroups[uId].includes(gId)) botData.userGroups[uId].push(gId);
  saveData();

  let serviceDesc = "";
  if (groupPerm === "all") serviceDesc = "All Services";
  else if (groupPerm === "like") serviceDesc = "Likes Only";
  else if (groupPerm === "spam") serviceDesc = "Spam Only";

  const successMsg = 
    `╭━━━ ⚡ 𝙈𝙄𝘾𝙃𝘼𝙀𝙇 𝙀𝙇𝙄𝙏𝙀 ━━━╮\n\n` +
    `🎉 Subscription activated successfully!\n\n` +
    `🏷️ Group: ${gInput}\n` +
    `📅 Duration: ${durationDesc}\n` +
    `⚙️ Services: ${serviceDesc}\n\n` +
    `✅ Group is ready.\n\n` +
    `╰━━━━━━━━━━━━━━━━━━╯\n` +
    `⚡ 𝙈𝙄𝘾𝙃𝘼𝙀𝙇 𝙀𝙇𝙄𝙏𝙀`;

  await ctx.telegram.sendMessage(uId, successMsg, { parse_mode: "Markdown" }).catch(() => {});
  return ctx.replyWithMarkdown(`✅ *Group activated successfully!*\n🆔 ID: \`${gId}\`\n🛡️ Permission: *${groupPerm}*`);
});

bot.command("remgroup", async (ctx) => {
  const userId = ctx.from.id.toString();
  if (!isDev(userId)) return ctx.reply("❌ Developer only.");
  const parts = ctx.message.text.split(/\s+/);
  let gInput = parts[1];
  if (!gInput) return ctx.replyWithMarkdown("⚠️ *Usage:*\n`/remgroup <group_id_or_link>`");

  let gId = await resolveChatId(ctx, gInput);
  if (!gId) gId = gInput;

  const idx = botData.activeGroups.indexOf(gId);
  if (idx !== -1) {
    botData.activeGroups.splice(idx, 1);
    delete botData.groupExpiry[gId];
    delete botData.groupPermissions[gId];
    
    if (botData.userGroups) {
      for (const uId of Object.keys(botData.userGroups)) {
        botData.userGroups[uId] = botData.userGroups[uId].filter(g => g !== gId);
      }
    }

    saveData();
    return ctx.replyWithMarkdown(`🔴 *Group removed successfully!*`);
  }
  return ctx.replyWithMarkdown(`⚠️ Group not found in active groups.`);
});

bot.command("groups", async (ctx) => {
  const userId = ctx.from.id.toString();

  if (!botData.userGroups || !botData.userGroups[userId] || botData.userGroups[userId].length === 0) {
    return ctx.reply("📌 You have no active groups.");
  }

  const userGList = botData.userGroups[userId];
  let likeGroupsText = "🎯 *Active Like Groups:*\n\n";
  let spamGroupsText = "🚀 *Active Spam Groups:*\n\n";
  
  let likeCount = 0;
  let spamCount = 0;

  for (let i = 0; i < userGList.length; i++) {
    const gId = userGList[i];
    const record = botData.groupJoinRecords[gId] || { title: "Group", username: "No username" };
    const perm = botData.groupPermissions[gId] || "all";
    const activeStatus = isGroupActive(gId) ? "Active 🟢" : "Expired 🔴";
    
    const groupItem = `• *${record.title}*\n  🆔 ID: \`${gId}\`\n  ⚙️ Status: ${activeStatus}\n-------------------------\n`;

    if (perm === "like" || perm === "all") {
      likeGroupsText += groupItem;
      likeCount++;
    }
    if (perm === "spam" || perm === "all") {
      spamGroupsText += groupItem;
      spamCount++;
    }
  }

  let finalTxt = "";
  if (likeCount > 0) finalTxt += likeGroupsText + "\n";
  if (spamCount > 0) finalTxt += spamGroupsText;

  if (finalTxt.trim() === "") {
    return ctx.reply("📌 You have no active groups.");
  }

  return ctx.replyWithMarkdown(finalTxt);
});

bot.command("likeauto", async (ctx) => {
  const userId = ctx.from.id.toString();
  const permission = isAdmin(userId) ? getAdminInterface(userId) : (botData.userPermissions[userId] || "all");
  if (permission === "spam") return ctx.reply("❌ This interface does not support like commands.");
  const parts = ctx.message.text.split(/\s+/);
  const targetUid = parts[1];
  const daysInput = parseInt(parts[2]);

  if (!targetUid || !daysInput || isNaN(daysInput)) {
    return ctx.replyWithMarkdown("⚠️ *Usage:*\n`/likeauto <uid> <days>`\n*(Example: `/likeauto 1712656538 5`)*");
  }

  if (daysInput < 2 || daysInput > 10) {
    return ctx.reply("❌ Days must be between 2 and 10.");
  }

  if (!botData.autoLikes) botData.autoLikes = {};
  if (!botData.autoLikes[userId]) botData.autoLikes[userId] = {};

  const userUidsCount = Object.keys(botData.autoLikes[userId]).length;
  if (!botData.autoLikes[userId][targetUid] && userUidsCount >= 5) {
    return ctx.reply("❌ Maximum limit reached (5 UIDs in auto-like at once).");
  }

  botData.autoLikes[userId][targetUid] = daysInput;
  saveData();

  return ctx.replyWithMarkdown(
    `✅ *Auto-like activated successfully!*\n` +
    `🎯 UID: \`${targetUid}\`\n` +
    `⏳ Days: \`${daysInput} days\`\n` +
    `📊 Active UIDs: \`${Object.keys(botData.autoLikes[userId]).length}/5\``
  );
});

bot.command("removeauto", async (ctx) => {
  const userId = ctx.from.id.toString();
  const permission = isAdmin(userId) ? getAdminInterface(userId) : (botData.userPermissions[userId] || "all");
  if (permission === "spam") return ctx.reply("❌ This interface does not support like commands.");
  const text = ctx.message.text.trim();
  const parts = text.split(/\s+/);
  const targetUid = parts[1];
  const daysToSubtract = parts[2] ? parseInt(parts[2].replace("/", "")) : null;

  if (!targetUid) {
    return ctx.replyWithMarkdown("⚠️ *Usage:*\nFull remove: `/removeauto <uid>`\nSubtract days: `/removeauto <uid> <days>`");
  }

  if (!botData.autoLikes || !botData.autoLikes[userId] || !botData.autoLikes[userId][targetUid]) {
    return ctx.reply("⚠️ UID not found in your auto-like list.");
  }

  if (daysToSubtract && !isNaN(daysToSubtract)) {
    let currentDays = botData.autoLikes[userId][targetUid];
    let newDays = currentDays - daysToSubtract;

    if (newDays <= 0) {
      delete botData.autoLikes[userId][targetUid];
      saveData();
      return ctx.replyWithMarkdown(`✅ UID \`${targetUid}\` removed completely.`);
    } else {
      botData.autoLikes[userId][targetUid] = newDays;
      saveData();
      return ctx.replyWithMarkdown(`✅ Days subtracted for UID \`${targetUid}\`.\n⏳ Remaining: \`${newDays} days\`.`);
    }
  } else {
    delete botData.autoLikes[userId][targetUid];
    saveData();
    return ctx.replyWithMarkdown(`✅ *UID (\`${targetUid}\`) removed from auto-like successfully!*`);
  }
});
bot.on("text", async (ctx, next) => {
  let text = ctx.message.text ? ctx.message.text.trim() : "";
  const userId = ctx.from ? ctx.from.id.toString() : "";
  const chatId = ctx.chat ? ctx.chat.id.toString() : "";
  const chatType = ctx.chat ? ctx.chat.type : "";

  if (chatType === 'supergroup' || chatType === 'group') {
    if (!isGroupActive(chatId) || botData.disabledGroups.includes(chatId)) {
      if (/^\/(?:like|spam|spam_ff|5\/|6\/)/i.test(text) || /^\/(?:like|spam|spam_ff)\d+/i.test(text)) {
        return ctx.reply("⛔ Sorry, this group is not active or subscription expired.");
      }
      return;
    }
  }

  if (chatType === 'private' && !isUserActive(userId)) {
    if (text.startsWith("MICHAEL-") || botData.codes[text]) {
      return processRedeem(ctx, text);
    }
  }

  if (/^\/on(?:@[A-Za-z0-9_]+)?$/i.test(text)) {
    if (chatType === 'private') return ctx.reply("⚠️ For authorized groups only.");
    if (!isGroupActive(chatId)) return ctx.reply("⚠️ Group not active.");
    if (!await isGroupAdmin(ctx) && !isAdmin(userId)) return ctx.reply("❌ Group admins only.");
    const idx = botData.disabledGroups.indexOf(chatId);
    if (idx !== -1) { botData.disabledGroups.splice(idx, 1); saveData(); }
    return ctx.reply("🟢 Bot enabled in group successfully!");
  }

  if (/^\/(?:off|of)(?:@[A-Za-z0-9_]+)?$/i.test(text)) {
    if (chatType === 'private') return ctx.reply("⚠️ For authorized groups only.");
    if (!isGroupActive(chatId)) return ctx.reply("⚠️ Group not active.");
    if (!await isGroupAdmin(ctx) && !isAdmin(userId)) return ctx.reply("❌ Group admins only.");
    if (!botData.disabledGroups.includes(chatId)) { botData.disabledGroups.push(chatId); saveData(); }
    return ctx.reply("Bot disabled in group ⚠️");
  }

  if (/^\/like\d+$/i.test(text)) {
    text = text.replace(/\/like/i, "/like ");
  } else if (/^\/spam_ff\d+$/i.test(text)) {
    text = text.replace(/\/spam_ff/i, "/spam_ff ");
  } else if (/^\/spam\d+$/i.test(text)) {
    text = text.replace(/\/spam/i, "/spam ");
  }

  const parts = text.split(/\s+/);
  const baseCmd = parts[0].split('@')[0].toLowerCase();

  if (chatType === 'private') {
    const userPerm = isAdmin(userId) ? getAdminInterface(userId) : (botData.userPermissions[userId] || "all");
    if (userPerm === "like" && (/^\/(?:spam|spam_ff)/i.test(baseCmd) || /^5\//.test(text) || /^6\//.test(text))) {
      return;
    }
    if (userPerm === "spam" && (baseCmd === '/like' || baseCmd === '/likeauto' || baseCmd === '/removeauto')) {
      return;
    }
  }

  if (baseCmd === '/like') {
    const perm = chatType !== 'private' ? (botData.groupPermissions[chatId] || "all") : "all";
    if (chatType !== 'private' && perm === "spam") {
      return ctx.reply("❌ Sorry, this group is for spam only.");
    }
  }

  if (baseCmd === '/spam' || baseCmd === '/spam_ff' || baseCmd === '5/' || baseCmd === '6/' || text.startsWith("5/") || text.startsWith("6/")) {
    const perm = chatType !== 'private' ? (botData.groupPermissions[chatId] || "all") : "all";
    if (chatType !== 'private' && perm === "like") {
      return ctx.reply("❌ Sorry, this group is for likes only.");
    }
  }

  if (baseCmd === '/like') {
    const targetUid = parts[1];
    if (!targetUid || !/^\d+$/.test(targetUid)) {
      return ctx.replyWithMarkdown("⚠️ *Usage:*\n`/like <uid>`");
    }

    let waitMsg = await ctx.reply(`⏳ Sending likes to UID: (${targetUid}), please wait...`);
    try {
      const result = await enqueueLikeTask(targetUid);
      if (waitMsg) await ctx.telegram.deleteMessage(chatId, waitMsg.message_id).catch(() => {});
      
      const successReply = 
        `╭━━━ ⚡ 𝙈𝙄𝘾𝙃𝘼𝙀𝙇 𝙀𝙇𝙄𝙏𝙀 ━━━╮\n\n` +
        `✅ Likes sent successfully!\n\n` +
        `👤 Nickname: *${result.nickname}*\n` +
        `🆔 UID: \`${targetUid}\`\n` +
        `📊 Level: *${result.level}*\n` +
        `❤️ Before: \`${result.beforeLikes}\`\n` +
        `💙 After: \`${result.afterLikes}\`\n` +
        `🔥 Added: \`+${result.addedLikes}\`\n\n` +
        `╰━━━━━━━━━━━━━━━━━━╯\n` +
        `⚡ 𝙈𝙄𝘾𝙃𝘼𝙀𝙇 𝙀𝙇𝙄𝙏𝙀`;

      return ctx.replyWithMarkdown(successReply);
    } catch (e) {
      if (waitMsg) await ctx.telegram.deleteMessage(chatId, waitMsg.message_id).catch(() => {});
      if (e.message === "DUPLICATE_UID") {
        return ctx.reply("⚠️ This UID is currently processing in queue.");
      } else if (e.message === "QUEUE_FULL") {
        return ctx.reply("⚠️ High traffic, try again later.");
      } else if (e.message === "INVALID_UID") {
        return ctx.reply("❌ Invalid UID.");
      }
      return ctx.reply("❌ Error sending likes.");
    }
  }

  if (baseCmd === '/spam' || baseCmd === '/spam_ff' || text.startsWith("5/") || text.startsWith("6/")) {
    let targetUid = parts[1];
    let spamType = "team";

    if (baseCmd === '/spam_ff') spamType = "ff";
    else if (text.startsWith("5/")) {
      spamType = "team5";
      targetUid = text.replace("5/", "").trim();
    } else if (text.startsWith("6/")) {
      spamType = "team6";
      targetUid = text.replace("6/", "").trim();
    }

    if (!targetUid || !/^\d+$/.test(targetUid)) {
      return ctx.replyWithMarkdown("⚠️ *Usage:*\n`/spam <uid>` or `/spam_ff <uid>`");
    }

    const activeSpamCount = getUserActiveSpamCount(userId, spamType);
    if (!isAdmin(userId) && activeSpamCount >= 3) {
      return ctx.reply("❌ Max active spam limit reached (3).");
    }

    const accounts = getAccounts();
    if (accounts.length === 0) {
      return ctx.reply("❌ No accounts in accounts.txt.");
    }

    let waitMsg = await ctx.reply(`🚀 Starting spam for UID: (\`${targetUid}\`), please wait...`, { parse_mode: "Markdown" });

    try {
      const apiEndpoint = spamType === "ff" ? "http://de26.spaceify.eu:26080/spam_ff" : "http://de26.spaceify.eu:26080/spam";
      const response = await axios.get(apiEndpoint, {
        params: { uid: targetUid, accounts: accounts.slice(0, 50).join(",") },
        timeout: 30000
      });

      if (waitMsg) await ctx.telegram.deleteMessage(chatId, waitMsg.message_id).catch(() => {});

      const timestamp = Date.now();
      if (spamType === "ff") {
        botData.spamFfActiveAccounts[targetUid] = { userId, timestamp };
      } else {
        botData.spamActiveAccounts[targetUid] = { userId, timestamp };
      }
      saveData();

      return ctx.replyWithMarkdown(
        `╭━━━ ⚡ 𝙈𝙄𝘾𝙃𝘼𝙀𝙇 𝙀𝙇𝙄𝙏𝙀 ━━━╮\n\n` +
        `🚀 Spam started successfully!\n\n` +
        `🎯 Target UID: \`${targetUid}\`\n` +
        `⏳ Cooldown: \`6 hours\`\n` +
        `⚡ Executed successfully.\n\n` +
        `╰━━━━━━━━━━━━━━━━━━╯\n` +
        `⚡ 𝙈𝙄𝘾𝙃𝘼𝙀𝙇 𝙀𝙇𝙄𝙏𝙀`
      );
    } catch (e) {
      if (waitMsg) await ctx.telegram.deleteMessage(chatId, waitMsg.message_id).catch(() => {});
      return ctx.reply("❌ Error executing spam.");
    }
  }

  return next();
});

async function processRedeem(ctx, codeText) {
  const code = codeText.trim();
  if (!botData.codes[code] || botData.codes[code].used) return ctx.reply("❌ Invalid or used code.");
  const userId = ctx.from.id.toString();
  const codeData = botData.codes[code];
  codeData.used = true; codeData.usedBy = userId;
  codeData.usedByName = ctx.from.first_name || ctx.from.username || "User";
  const now = Date.now();
  const currentExpiry = (botData.userExpiry[userId] && botData.userExpiry[userId] > now) ? botData.userExpiry[userId] : now;
  botData.userExpiry[userId] = currentExpiry + codeData.durationMs;
  botData.userPermissions[userId] = codeData.permissionType || "all";
  if (!botData.activeUsers.includes(userId)) botData.activeUsers.push(userId);
  saveData();
  const creatorName = codeData.createdByName || "Unknown";
  const creatorId = codeData.createdBy || "Unknown";
  const redeemerName = codeData.usedByName;
  await ctx.telegram.sendMessage(
    DEVELOPER_ID,
    `🎟️ Subscription code used\n\n🔑 Code: ${code}\n👤 Creator: ${creatorName}\n🆔 Creator ID: ${creatorId}\n👤 User: ${redeemerName}\n🆔 User ID: ${userId}\n🛡️ Interface: ${codeData.permissionType}`
  ).catch(() => {});
  return ctx.replyWithMarkdown(`🎉 Congratulations! Subscription activated. Interface: *${codeData.permissionType.toUpperCase()}*`);
}

bot.launch({
  polling: {
    timeout: 30,
    limit: 100,
  }
}).then(() => console.log("Telegram Bot is running with Polling successfully!")).catch(console.error);

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));

