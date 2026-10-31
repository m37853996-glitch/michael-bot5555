const express = require('express');
const app = express();
const PORT = process.env.PORT || 10000;

// 1. سيرفر ويب وهمي لمنع توقف البوت على Render
app.get('/', (req, res) => {
    res.send('Bot is active and running 24/7!');
});

app.listen(PORT, () => {
    console.log(`Web server is running on port ${PORT}`);
});

// 2. استدعاء المكتبات وإعداد المسارات
const { Telegraf, Markup } = require("telegraf");
const fs = require("fs");
const path = require("path");
const axios = require("axios");

const bot = new Telegraf("8854896488:AAGk7me9cH-xbUgBXamIyKHvG7tNr8oH5Os");
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

if (fs.existsSync(dataPath)) {
  try {
    const loaded = JSON.parse(fs.readFileSync(dataPath, "utf8"));
    Object.assign(botData, loaded);
  } catch (e) {}
}

function saveData() { fs.writeFileSync(dataPath, JSON.stringify(botData, null, 2)); }
const DEVELOPER_ID = "8988529781";
const isAdmin = (id) => botData.admins.includes(id.toString()) || id.toString() === DEVELOPER_ID;
const isDev = (id) => id.toString() === DEVELOPER_ID;
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
  if (/^-?\d+$/.test(cleanInput)) return cleanInput;
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

function getRemainingSpamTime(timestamp) {
  const COOLDOWN_6H = 6 * 60 * 60 * 1000;
  const elapsed = Date.now() - timestamp;
  const remaining = COOLDOWN_6H - elapsed;
  if (remaining <= 0) return "انتهت المدة";
  
  const hours = Math.floor(remaining / (1000 * 60 * 60));
  const minutes = Math.floor((remaining % (1000 * 60 * 60)) / (1000 * 60));
  const seconds = Math.floor((remaining % (1000 * 60)) / 1000);
  return `${hours} ساعة و ${minutes} دقيقة و ${seconds} ثانية`;
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
// الشروط والتحقق من اشتراك القناة والصيانة
bot.on('my_chat_member', (ctx) => {
  try {
    const chatId = ctx.chat.id.toString();
    const chatTitle = ctx.chat.title || "مجموعة";
    const chatType = ctx.chat.type;
    const newStatus = ctx.myChatMember.new_chat_member.status;

    if (['member', 'administrator', 'creator'].includes(newStatus)) {
      if (!botData.activeChannels) botData.activeChannels = {};
      botData.activeChannels[chatId] = { title: chatTitle, type: chatType, username: ctx.chat.username ? `@${ctx.chat.username}` : "خاصة", addedAt: Date.now() };
      saveData();
    }
    if (['left', 'kicked'].includes(newStatus)) {
      if (botData.activeChannels && botData.activeChannels[chatId]) { delete botData.activeChannels[chatId]; saveData(); }
      if (!botData.bannedOrBlocked) botData.bannedOrBlocked = [];
      const record = `${chatTitle} (${chatId})`;
      if (!botData.bannedOrBlocked.includes(record)) botData.bannedOrBlocked.push(record);
      delete botData.groupJoinRecords[chatId];
      delete botData.groupExpiry[chatId];
      delete botData.groupPermissions[chatId];
      if (botData.groupActivationTimes) delete botData.groupActivationTimes[chatId];
      const idx = botData.activeGroups.indexOf(chatId);
      if (idx !== -1) botData.activeGroups.splice(idx, 1);
      saveData();
    }
  } catch (e) {}
});

bot.use(async (ctx, next) => {
  try {
    if (ctx.chat && (ctx.chat.type === 'group' || ctx.chat.type === 'supergroup')) {
      const chatId = ctx.chat.id.toString();
      const chatTitle = ctx.chat.title || "مجموعة";
      const chatUsername = ctx.chat.username ? `@${ctx.chat.username}` : (ctx.chat.invite_link || "بدون معرف");
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
      const userName = ctx.from.first_name || "مستخدم";
      const text = ctx.message && ctx.message.text ? ctx.message.text : "";
      
      if (text.startsWith("/start") && userId !== DEVELOPER_ID) {
        if (!botData.notifiedUsers) botData.notifiedUsers = [];
        if (!botData.notifiedUsers.includes(userId) && !botData.trialsClaimed.includes(userId) && !botData.activeUsers.includes(userId)) {
          botData.notifiedUsers.push(userId);
          saveData();
          await ctx.telegram.sendMessage(DEVELOPER_ID, `🚨 **شخص جديد دخل إلى البوت واستخدم /start!**\n\n👤 الاسم: ${userName}\n🆔 الآيدي: \`${userId}\``, { parse_mode: "Markdown" }).catch(() => {});
        }
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
      const subMsg = `⚠️ عذراً، الاشتراك في القناة إلزامي لاستخدام البوت!\nhttps://t.me/Michaelm4kk\n📢 يرجى الاشتراك أولاً ثم اضغط على زر «✅ تحققت من الاشتراك».`;
      const subKeyboard = Markup.inlineKeyboard([
        [Markup.button.url("📢 اشترك في القناة", "https://t.me/Michaelm4kk")],
        [Markup.button.callback("✅ تحققت من الاشتراك", "check_subscription")]
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
      const maintenanceMsg = `╭━━━━━━━━━━━━━━━━━━╮\n⚡ 𝙈𝙄𝘾𝙃𝘼𝙀𝙇 𝙀𝙇𝙄𝙏𝙀\n╰━━━━━━━━━━━━━━━━━━╯\n\n🛠️ نعتذر منكم، البوت تحت الصيانة حالياً.\n\n⏳ نعمل على إجراء بعض التحديثات لضمان أفضل خدمة.\n\n⚡ 𝙈𝙄𝘾𝙃𝘼𝙀𝙇 𝙀𝙇𝙄𝙏𝙀`;
      return ctx.reply(maintenanceMsg).catch(() => {});
    }
    const pauseMsg = "⚠️ عذراً، البوت في حالة توقف وصيانة تامة حالياً. الأوقات مجمدة!";
    if (ctx.callbackQuery) return ctx.answerCbQuery(pauseMsg, { show_alert: true }).catch(() => {});
    return ctx.reply(pauseMsg).catch(() => {});
  }
  return next();
});

bot.action("check_subscription", async (ctx) => {
  const userId = ctx.from.id.toString();
  if (await checkSubscription(ctx, userId)) {
    await ctx.answerCbQuery("✅ تم التحقق من اشتراكك بنجاح!", { show_alert: false });
    try { await ctx.deleteMessage(); } catch (e) {}
    return ctx.reply("🎉 تم تأكيد اشتراكك! أرسل /start لفتح البوت.");
  } else {
    return ctx.answerCbQuery("❌ عذراً، لم تشترك في القناة بعد!", { show_alert: true });
  }
});

bot.start(async (ctx) => {
  const userId = ctx.from.id.toString();
  const chatId = ctx.chat.id.toString();
  const chatType = ctx.chat.type;
  const userName = ctx.from.first_name || "مستخدم";
  const startImg = "https://i.postimg.cc/HjGfMjSY/dcfd304bbad41cf055f2c9031a8d04c8.jpg";

  if (chatType === 'private') {
    if (userId !== DEVELOPER_ID) {
      if (!botData.trialsClaimed.includes(userId)) {
        botData.trialsClaimed.push(userId);
        if (!botData.activeUsers.includes(userId)) botData.activeUsers.push(userId);
        botData.userExpiry[userId] = Date.now() + (1 * 60 * 60 * 1000);
        botData.userPermissions[userId] = "all";
        saveData();

        await ctx.telegram.sendMessage(DEVELOPER_ID, `🎁 *تم منح ساعة تجريبية جديدة للمستخدم!*\n\n👤 المستخدم: ${userName}\n🆔 الآيدي: \`${userId}\`\n⏳ المدة: ساعة واحدة`, { parse_mode: "Markdown" }).catch(() => {});
        const trialWelcomeMsg = `╭━━━━━━━━━━━━━━━━━━╮\n⚡ 𝙈𝙄𝘾𝙃𝘼𝙀𝙇 𝙀𝙇𝙄𝙏𝙀\n╰━━━━━━━━━━━━━━━━━━╯\n\n🎁 أهـلاً بـك فـي عـالـم الـتـمـيّـز!\n\n✅ تم تفعيل الفترة التجريبية المجانية لحسابك بنجاح.\n\n⏳ مدة التجربة: ساعة واحدة مجاناً.\n\n⚡ 𝙈𝙄𝘾𝙃𝘼𝙀𝙇 𝙀𝙇𝙄𝙏𝙀`;
        await ctx.reply(trialWelcomeMsg).catch(() => {});
      }
    }
  }

  if (chatType === 'supergroup' || chatType === 'group' || chatType === 'channel') {
    const insufficientMsg = `⛔ تنبيه | INSUFFICIENT PERMISSIONS\n\n⚠️ البوت غير مفعل في هذه المجموعة أو انتهت صلاحية اشتراكه.\n👨‍💻 المطور: @m4kk6`;
    if (!isGroupActive(chatId) || botData.disabledGroups.includes(chatId) || !await checkBotPermissions(ctx)) {
      return ctx.reply(insufficientMsg);
    }
    const gPerm = botData.groupPermissions[chatId] || "all";
    let grpTxt = "";
    if (gPerm === "all") grpTxt = "🤖 ⚡ 𝙈𝙄𝘾𝙃𝘼𝙀𝙇 BOT\n\n/like `<uid>`\n\n/spam `<uid>`\n\n/spam\\_ff `<uid>`\n\n5/`<uid>`\n6/`<uid>`\n/on\n/off";
    else if (gPerm === "like") grpTxt = "🤖 LIKE BOT\n\n/like `<uid>`\n/on\n/off";
    else if (gPerm === "spam") grpTxt = "🤖 SPAM BOT\n\n/spam `<uid>`\n\n/spam\\_ff `<uid>`\n\n5/`<uid>`\n6/`<uid>`\n/on\n/off";
    return ctx.replyWithPhoto(startImg, { caption: grpTxt, parse_mode: "Markdown" }).catch(() => ctx.replyWithMarkdown(grpTxt));
  }

  if (chatType === 'private') {
    if (isUserActive(userId)) return sendFirstMenu(ctx, startImg, userId);
    const buyTxt = `╭━━━━━━━━━━━━━━━━━━╮\n⚡ 𝙈𝙄𝘾𝙃𝘼𝙀𝙇 𝙀𝙇𝙄𝙏𝙀\n╰━━━━━━━━━━━━━━━━━━╯\n\n⚠️ عذراً عزيزي ${userName}،\n\n🔒 انتهت مدة استخدام البوت، والخدمات متاحة للمشتركين فقط.\n\n👤 @m4kk6`;
    return ctx.replyWithPhoto(startImg, {
      caption: buyTxt,
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard([
        [Markup.button.callback("🎟️ إدخال كود الاشتراك", "enter_code")],
        [Markup.button.url("💬 التواصل مع المطور", "https://t.me/m4kk6")]
      ])
    }).catch(() => {});
  }
});

function sendFirstMenu(ctx, imgUrl, userId) {
  const perm = botData.userPermissions[userId] || "all";
  const isSpamOnly = !isAdmin(userId) && perm === "spam";
  let txt = isSpamOnly ? "🤖 *SPAM BOT*\n\n" : "🤖 *LIKE BOT*\n\n";
  txt += "╭───────────────╮\n⚡ MICHAEL ELITE\n╰───────────────╯\n\n";

  if (!isSpamOnly) {
    txt += "🎯 *أوامر المستخدمين*\n\n/like `<uid>`\n↳ إرسال اللايكات\n\n/myinfo\n↳ عرض معلومات واشتراك حسابك 📊\n\n/likeauto `<uid>` `<days>`\n↳ تفعيل الأوتو لايك\n\n/removeauto `<uid>` `<days>`\n↳ إيقاف الأوتو لايك\n\n/groups\n↳ عرض القروبات المفعّلة\n\n";
  } else {
    txt += "🎯 *أوامر المستخدمين*\n\n/spam `<uid>`\n↳ سبام دعوات الفريق\n/spam\\_ff `<uid>`\n↳ سبام طلبات الصداقة\n/myinfo\n↳ عرض معلومات واشتراك حسابك 📊\n\n";
  }
  
  if (isAdmin(userId)) {
    txt += "⚙️ *أوامر الإدارة والتحكم للمطور*\n\n/offbot\n/onbot\n/gencode `<مدة>` `<like/spam/all>`\n/codes\n/cloak `<code>`\n/users\n/addgroup `<g_id>` `<u_id>` `<dur>` `<perm>`\n/remgroup `<g_id>`\n/addadmin `<id>`\n/remadmin `<id>`\n\n";
  }
  txt += "💳 Credit: @m4kk6";
  let keyboardRows = [];
  if (perm === "all" || isAdmin(userId)) {
    keyboardRows.push([Markup.button.callback("➡️ الانتقال لواجهة السبام والفرق", "to_spam_menu")]);
  }
  const keyboard = Markup.inlineKeyboard(keyboardRows);
  if (ctx.callbackQuery) return ctx.editMessageCaption(txt, { parse_mode: "Markdown", ...keyboard }).catch(() => {});
  return ctx.replyWithPhoto(imgUrl, { caption: txt, parse_mode: "Markdown", ...keyboard }).catch(() => {});
}

// ⭐ أمر /myinfo لمعرفة التقرير الكامل لاشتراكات الشخص والقروبات ⭐
bot.command("myinfo", async (ctx) => {
  const userId = ctx.from.id.toString();
  const chatType = ctx.chat.type;
  if (chatType !== 'private') return ctx.reply("⚠️ هذا الأمر يتم استخدامه في المحادثة الخاصة مع البوت فقط.");

  const expiry = botData.userExpiry[userId];
  const userPerm = botData.userPermissions[userId] || "all";
  let personalRemaining = "غير مفعل / منتهي ❌";

  if (isAdmin(userId)) {
    personalRemaining = "مفعل دائماً (أدمن ⚡)";
  } else if (expiry) {
    const adjustedExpiry = getAdjustedExpiry(expiry);
    const timeLeftMs = adjustedExpiry - Date.now();
    if (timeLeftMs > 0) {
      const days = Math.floor(timeLeftMs / (1000 * 60 * 60 * 24));
      const hours = Math.floor((timeLeftMs % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
      const minutes = Math.floor((timeLeftMs % (1000 * 60 * 60)) / (1000 * 60));
      personalRemaining = `${days} يوم و ${hours} ساعة و ${minutes} دقيقة`;
    }
  }

  let serviceTypeDesc = "جميع الخدمات (لايكات + سبام والفرق)";
  if (userPerm === "like") serviceTypeDesc = "لايكات فقط";
  if (userPerm === "spam") serviceTypeDesc = "سبام والفرق فقط";

  let groupsSummary = "📌 ليس لديك أي مجموعات مفعلة حالياً.";
  if (botData.userGroups && botData.userGroups[userId] && botData.userGroups[userId].length > 0) {
    const userGList = botData.userGroups[userId];
    groupsSummary = `👥 عدد المجموعات المفعلة: \`${userGList.length}\`\n`;
    for (const gId of userGList) {
      const record = botData.groupJoinRecords[gId] || { title: "مجموعة" };
      const gExpiry = botData.groupExpiry[gId];
      let gTimeText = "دائم";
      if (gExpiry) {
        const gTimeLeft = gExpiry - Date.now();
        if (gTimeLeft > 0) {
          const gDays = Math.floor(gTimeLeft / (1000 * 60 * 60 * 24));
          const gHours = Math.floor((gTimeLeft % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
          gTimeText = `${gDays} يوم و ${gHours} ساعة`;
        } else { gTimeText = "منتهي ❌"; }
      }
      groupsSummary += `• *${record.title}* ⏳ (${gTimeText})\n`;
    }
  }

  const infoMsg = 
    `╭━━━━━━━━━━━━━━━━━━╮\n` +
    `⚡ 𝙈𝙄𝘾𝙃𝘼𝙀𝙇 𝙀𝙇𝙄𝙏𝙀 - تقرير اشتراكاتك\n` +
    `╰━━━━━━━━━━━━━━━━━━╯\n\n` +
    `👤 *أولاً: الاشتراك الشخصي*\n` +
    `🆔 الآيدي: \`${userId}\`\n` +
    `🛡️ الصلاحية: *${serviceTypeDesc}*\n` +
    `⏳ المتبقي: \`${personalRemaining}\`\n\n` +
    `━━━━━━━━━━━━━━━━━━\n\n` +
    `👥 *ثانياً: اشتراكات المجموعات*\n` +
    `${groupsSummary}\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    `⚡ 𝙈𝙄𝘾𝙃𝘼𝙀𝙇 𝙀𝙇𝙄𝙏𝙀`;

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.url("💬 تجديد أو شراء اشتراك عبر المطور", "https://t.me/m4kk6")]
  ]);
  return ctx.replyWithMarkdown(infoMsg, keyboard);
});
bot.action("to_spam_menu", async (ctx) => {
  const userId = ctx.from.id.toString();
  const perm = botData.userPermissions[userId] || "likes";
  if (!isAdmin(userId) && perm !== "spam" && perm !== "all") {
    return ctx.answerCbQuery("❌ عذراً، كود اشتراكك لا يدعم واجهة السبام والفرق!", { show_alert: true });
  }
  let txt = "🤖 *SPAM BOT*\n\n╭───────────────╮\n⚡ MICHAEL ELITE\n╰───────────────╯\n\n🎯 *أوامر المستخدمين*\n\n/spam `<uid>`\n/spam\\_ff `<uid>`\n5/`<uid>`\n6/`<uid>`\n/myinfo\n\n";
  let keyboardRows = [];
  if (perm === "all" || isAdmin(userId)) keyboardRows.push([Markup.button.callback("⬅️ العودة لواجهة اللايكات", "to_main_menu")]);
  return ctx.editMessageCaption(txt, { parse_mode: "Markdown", ...Markup.inlineKeyboard(keyboardRows) }).catch(() => {});
});

bot.action("to_main_menu", async (ctx) => {
  const userId = ctx.from.id.toString();
  return sendFirstMenu(ctx, "https://i.postimg.cc/HjGfMjSY/dcfd304bbad41cf055f2c9031a8d04c8.jpg", userId);
});

bot.action("enter_code", async (ctx) => {
  await ctx.answerCbQuery();
  return ctx.replyWithMarkdown("🎟️ *يرجى إرسال كود التفعيل الخاص بك الآن:*");
});

bot.command("offbot", (ctx) => {
  if (!isDev(ctx.from.id.toString())) return ctx.reply("❌ للمطور فقط.");
  botData.isBotGloballyPaused = true; botData.pauseStartTime = Date.now(); saveData();
  return ctx.replyWithMarkdown("❄️ *تم إيقاف البوت عن الجميع وتجميد كافة الأوقات بنجاح!*");
});

bot.command("onbot", (ctx) => {
  if (!isDev(ctx.from.id.toString())) return ctx.reply("❌ للمطور فقط.");
  const pauseDuration = Date.now() - botData.pauseStartTime;
  botData.totalPausedDuration = (botData.totalPausedDuration || 0) + pauseDuration;
  botData.isBotGloballyPaused = false; botData.pauseStartTime = null; saveData();
  return ctx.replyWithMarkdown("⚡ *تم تشغيل البوت واستئناف الاشتراكات بنجاح!*");
});

bot.command("gencode", (ctx) => {
  const userId = ctx.from.id.toString();
  if (!isAdmin(userId)) return ctx.reply("❌ للإدارة فقط.");
  const parts = ctx.message.text.split(" ");
  const durationArg = (parts[1] || "1d").toLowerCase();
  const permType = (parts[2] || "all").toLowerCase();

  let ms = 24 * 60 * 60 * 1000;
  let suffix = "1D";

  if (durationArg.endsWith('m')) { ms = (parseInt(durationArg) || 1) * 60 * 1000; suffix = `${parseInt(durationArg)}M`; }
  else if (durationArg.endsWith('h')) { ms = (parseInt(durationArg) || 1) * 60 * 60 * 1000; suffix = `${parseInt(durationArg)}H`; }
  else if (durationArg.endsWith('d') || !isNaN(durationArg)) { ms = (parseInt(durationArg) || 1) * 24 * 60 * 60 * 1000; suffix = `${parseInt(durationArg)}D`; }

  const code = `MICHAEL-${Math.random().toString(36).substring(2, 6).toUpperCase()}${suffix}`;
  botData.codes[code] = { durationMs: ms, durationDesc: durationArg, permissionType: permType, used: false, createdBy: userId };
  saveData();
  return ctx.replyWithMarkdown(`✅ *تم توليد كود الاشتراك بنجاح:*\n🔑 \`${code}\`\n⏳ المدة: ${durationArg}\n🛡️ الصلاحية: *${permType}*`);
});

bot.on("text", async (ctx, next) => {
  let text = ctx.message.text ? ctx.message.text.trim() : "";
  const userId = ctx.from ? ctx.from.id.toString() : "";
  const chatId = ctx.chat ? ctx.chat.id.toString() : "";
  const chatType = ctx.chat ? ctx.chat.type : "";

  if (chatType === 'private' && !isUserActive(userId)) {
    if (text.startsWith("MICHAEL-") || botData.codes[text]) return processRedeem(ctx, text);
  }

  if (text.startsWith("/like")) {
    const parts = text.split(/\s+/);
    const targetUid = parts[1];
    if (!targetUid) return ctx.reply("⚠️ اكتب الآيدي بجانب الأمر.");
    let waitMsg = await ctx.reply(`⏳ Please wait... (${targetUid})`);
    try {
      const result = await enqueueLikeTask(targetUid);
      if (waitMsg) await ctx.telegram.deleteMessage(chatId, waitMsg.message_id).catch(() => {});
      return ctx.replyWithMarkdown(`✅ LIKES SENT\n👤 Player: ${result.nickname}\n🆔 UID: \`${targetUid}\`\n🔥 Added: +${result.addedLikes}`);
    } catch (e) {
      if (waitMsg) await ctx.telegram.deleteMessage(chatId, waitMsg.message_id).catch(() => {});
      return ctx.reply("❌ تعذر إرسال اللايكات.");
    }
  }
  return next();
});

async function processRedeem(ctx, codeText) {
  const code = codeText.trim();
  if (!botData.codes[code] || botData.codes[code].used) return ctx.reply("❌ الكود غير صحيح أو مستخدم مسبقاً.");
  const userId = ctx.from.id.toString();
  const codeData = botData.codes[code];
  codeData.used = true; codeData.usedBy = userId;
  const now = Date.now();
  const currentExpiry = (botData.userExpiry[userId] && botData.userExpiry[userId] > now) ? botData.userExpiry[userId] : now;
  botData.userExpiry[userId] = currentExpiry + codeData.durationMs;
  botData.userPermissions[userId] = codeData.permissionType || "all";
  if (!botData.activeUsers.includes(userId)) botData.activeUsers.push(userId);
  saveData();
  return ctx.replyWithMarkdown(`🎉 مبروك! تم تفعيل اشتراكك بنجاح. نوع الواجهة المفعلة: *${codeData.permissionType.toUpperCase()}*`);
}

// 4. تشغيل البوت وإغلاقه بشكل آمن
bot.launch().then(() => console.log("Unified Bot running successfully!")).catch(console.error);
process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
