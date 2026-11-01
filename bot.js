const express = require('express');
const app = express();
const PORT = process.env.PORT || 10000;

// سيرفر ويب دقيق ومتوافق مع شروط Render لمنع الإطفاء
app.get('/', (req, res) => {
    res.status(200).send('Bot is active and running 24/7 successfully!');
});

app.head('/', (req, res) => {
    res.sendStatus(200);
});

// ربط السيرفر بالعنوان الصحيح 0.0.0.0 لضمان استجابة رندر وموقع المراقبة
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
const DEVELOPER_ID = "8988529781";
const isAdmin = (id) => botData.admins.includes(id.toString()) || id.toString() === DEVELOPER_ID;
const isDev = (id) => id.toString() === DEVELOPER_ID;
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
    const chatTitle = ctx.chat.title || "مجموعة";
    const chatType = ctx.chat.type;
    const newStatus = ctx.myChatMember.new_chat_member.status;

    if (['member', 'administrator', 'creator'].includes(newStatus)) {
      if (!botData.activeChannels) botData.activeChannels = {};
      botData.activeChannels[chatId] = {
        title: chatTitle,
        type: chatType,
        username: ctx.chat.username ? `@${ctx.chat.username}` : "خاصة",
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
        await ctx.telegram.sendMessage(
          DEVELOPER_ID,
          `🚨 **شخص جديد دخل إلى البوت واستخدم /start!**\n\n👤 الاسم: ${userName}\n🆔 الآيدي: \`${userId}\``,
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
      const maintenanceMsg = 
        `╭━━━━━━━━━━━━━━━━━━╮\n` +
        `⚡ 𝙈𝙄𝘾𝙃𝘼𝙀𝙇 𝙀𝙇𝙄𝙏𝙀\n` +
        `╰━━━━━━━━━━━━━━━━━━╯\n\n` +
        `🛠️ نعتذر منكم، البوت تحت الصيانة حالياً.\n\n` +
        `⏳ نعمل على إجراء بعض التحديثات والتحسينات لضمان تقديم أفضل خدمة لكم.\n\n` +
        `💙 شكراً لتفهمكم وثقتكم بنا.\n\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `⚡ 𝙈𝙄𝘾𝙃𝘼𝙀𝙇 𝙀𝙇𝙄𝙏𝙀`;
      
      return ctx.reply(maintenanceMsg).catch(() => {});
    }

    const pauseMsg = "⚠️ عذراً، البوت في حالة توقف وصيانة تامة من قبل المطور حالياً. الأوقات مجمدة بالكامل!";
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

        await ctx.telegram.sendMessage(
          DEVELOPER_ID,
          `🎁 *تم منح ساعة تجريبية جديدة للمستخدم!*\n\n👤 المستخدم: ${userName}\n🆔 الآيدي: \`${userId}\`\n⏳ المدة: ساعة واحدة`,
          { parse_mode: "Markdown" }
        ).catch(() => {});

        const trialWelcomeMsg = 
          `╭━━━━━━━━━━━━━━━━━━╮\n` +
          `⚡ 𝙈𝙄𝘾𝙃𝘼𝙀𝙇 𝙀𝙇𝙄𝙏𝙀\n` +
          `╰━━━━━━━━━━━━━━━━━━╯\n\n` +
          `🎁 أهـلاً بـك فـي عـالـم الـتـمـيّـز!\n\n` +
          `✅ تم تفعيل الفترة التجريبية المجانية لحسابك بنجاح.\n\n` +
          `⏳ مدة التجربة: ساعة واحدة مجاناً.\n\n` +
          `⚡ الخدمات المتاحة:\n` +
          `🎯 اللايكات\n` +
          `🚀 السبام والفرق\n\n` +
          `🔥 اغتنم فرصتك واستمتع بتجربة خدمات مايكل إيليت!\n\n` +
          `━━━━━━━━━━━━━━━━━━\n` +
          `⚡ 𝙈𝙄𝘾𝙃𝘼𝙀𝙇 𝙀𝙇𝙄𝙏𝙀`;

        await ctx.reply(trialWelcomeMsg).catch(() => {});
      }
    }
  }

  if (chatType === 'supergroup' || chatType === 'group' || chatType === 'channel') {
    const insufficientMsg = 
      `⛔ تنبيه | INSUFFICIENT PERMISSIONS\n\n` +
      `━━━━━━━━━━━━━━━━━━\n\n` +
      `⚠️ البوت غير مفعل في هذه المجموعة أو انتهت صلاحية اشتراكه.\n\n` +
      `🛠️ للتفعيل تواصل مع المطور:\n` +
      `👨‍💻 المطور: @m4kk6\n\n` +
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
      grpTxt = "🤖 SPAM BOT\n\n/spam `<uid>`\n\n/spam\\_ff `<uid>`\n\n5/`<uid>`\n6/`<uid>`\n/on\n/off";
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
      `⚠️ عذراً عزيزي ${userName}،\n\n` +
      `🔒 انتهت مدة استخدام البوت، والخدمات متاحة للمشتركين فقط.\n\n` +
      `💎 للاشتراك أو الاستفسار عن الأسعار، يُرجى التواصل مع المطور:\n\n` +
      `👤 @m4kk6\n\n` +
      `━━━━━━━━━━━━━━━━━━\n` +
      `⚡ 𝙈𝙄𝘾𝙃𝘼𝙀𝙇 𝙀𝙇𝙄𝙏𝙀`;

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
  txt += "╭───────────────╮\n" +
         "⚡ MICHAEL ELITE\n" +
         "╰───────────────╯\n\n";

  if (!isSpamOnly) {
    txt += "🎯 *أوامر المستخدمين*\n\n" +
           "/like `<uid>`\n↳ إرسال اللايكات\n\n" +
           "/myinfo\n↳ عرض معلومات واشتراك حسابك والمجموعات 📊\n\n" +
           "/likeauto `<uid>` `<days>`\n↳ تفعيل الأوتو لايك\n\n" +
           "/removeauto `<uid>` `<days>`\n↳ إيقاف الأوتو لايك\n\n" +
           "/groups\n↳ عرض القروبات المفعّلة\n\n";
  } else {
    txt += "🎯 *أوامر المستخدمين*\n\n" +
           "/spam `<uid>`\n↳ سبام دعوات الفريق\n" +
           "/spam\\_ff `<uid>`\n↳ سبام طلبات الصداقة\n" +
           "/myinfo\n↳ عرض معلومات واشتراك حسابك والمجموعات 📊\n\n" +
           "5/`<uid>`\n↳ فتح فريق خماسي (5 أشخاص)\n\n" +
           "6/`<uid>`\n↳ فتح فريق سداسي (6 أشخاص)\n\n";
  }
  
  if (isAdmin(userId)) {
    txt += "━━━━━━━━━━━━━━\n\n" +
           "⚙️ *أوامر الإدارة والتحكم للمطور*\n\n" +
           "/offbot\n↳ إيقاف البوت عن الجميع وتجميد الأوقات ❄️\n\n" +
           "/onbot\n↳ تشغيل البوت واستئناف الأوقات للجميع ⚡\n\n" +
           "/gencode `<مدة>` `<like/spam/all>`\n↳ توليد كود اشتراك\n\n" +
           "/codes\n↳ عرض الأكواد النشطة\n\n" +
           "/cloak `<code>`\n↳ إتلاف كود اشتراك\n\n" +
           "/users\n↳ عرض الحسابات المفعّلة وإحصائيات البوت 📊\n\n" +
           "/addgroup `<group_id>` `<user_id>` `<duration>` `<like/spam/all>`\n↳ تفعيل قروب\n\n" +
           "/remgroup `<group_id>`\n↳ إزالة قروب\n\n" +
           "/addadmin `<id>`\n↳ إضافة أدمن\n\n" +
           "/remadmin `<id>`\n↳ إزالة أدمن\n\n";
  }

  txt += "━━━━━━━━━━━━━━\n\n" +
         "💳 Credit: @m4kk6";

  let keyboardRows = [];
  if (perm === "all" || isAdmin(userId)) {
    keyboardRows.push([Markup.button.callback("➡️ الانتقال لواجهة السبام والفرق", "to_spam_menu")]);
  }

  const keyboard = Markup.inlineKeyboard(keyboardRows);

  if (ctx.callbackQuery) {
    return ctx.editMessageCaption(txt, { parse_mode: "Markdown", ...keyboard }).catch(() => {});
  }
  return ctx.replyWithPhoto(imgUrl, { caption: txt, parse_mode: "Markdown", ...keyboard }).catch(() => {});
}

bot.command("myinfo", async (ctx) => {
  const userId = ctx.from.id.toString();
  const chatType = ctx.chat.type;

  if (chatType !== 'private') {
    return ctx.reply("⚠️ هذا الأمر يتم استخدامه في المحادثة الخاصة مع البوت فقط لمعرفة تفاصيل اشتراكك.");
  }

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
        } else {
          gTimeText = "منتهي ❌";
        }
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

  let txt = "🤖 *SPAM BOT*\n\n" +
            "╭───────────────╮\n" +
            "⚡ MICHAEL ELITE\n" +
            "╰───────────────╯\n\n" +
            "🎯 *أوامر المستخدمين*\n\n" +
            "/spam `<uid>`\n↳ سبام دعوات الفريق\n" +
            "/spam\\_ff `<uid>`\n↳ سبام طلبات الصداقة\n" +
            "/myinfo\n↳ عرض معلومات واشتراك حسابك والمجموعات 📊\n\n" +
            "5/`<uid>`\n↳ فتح فريق خماسي (5 أشخاص)\n\n" +
            "6/`<uid>`\n↳ فتح فريق سداسي (6 أشخاص)\n\n";

  if (isAdmin(userId)) {
    txt += "━━━━━━━━━━━━━━\n\n" +
           "⚙️ *أوامر الإدارة والتحكم للمطور*\n\n" +
           "/offbot\n↳ إيقاف البوت عن الجميع وتجميد الأوقات ❄️\n\n" +
           "/onbot\n↳ تشغيل البوت واستئناف الأوقات للجميع ⚡\n\n" +
           "/gencode `<مدة>` `<like/spam/all>`\n↳ توليد كود اشتراك\n\n" +
           "/codes\n↳ عرض الأكواد النشطة\n\n" +
           "/cloak `<code>`\n↳ إتلاف كود اشتراك\n\n" +
           "/users\n↳ عرض الحسابات المفعّلة وإحصائيات البوت 📊\n\n" +
           "/addgroup `<group_id>` `<user_id>` `<duration>` `<like/spam/all>`\n↳ تفعيل قروب\n\n" +
           "/remgroup `<group_id>`\n↳ إزالة قروب\n\n" +
           "/addadmin `<id>`\n↳ إضافة أدمن\n\n" +
           "/remadmin `<id>`\n↳ إزالة أدمن\n\n";
  }

  txt += "━━━━━━━━━━━━━━\n\n" +
         "💳 Credit: @m4kk6";

  let keyboardRows = [];
  if (perm === "all" || isAdmin(userId)) {
    keyboardRows.push([Markup.button.callback("⬅️ العودة لواجهة اللايكات", "to_main_menu")]);
  }
  const keyboard = Markup.inlineKeyboard(keyboardRows);

  return ctx.editMessageCaption(txt, { parse_mode: "Markdown", ...keyboard }).catch(() => {});
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
  const userId = ctx.from.id.toString();
  if (!isDev(userId)) return ctx.reply("❌ هذا الأمر مخصص للمطور الأساسي فقط.");
  if (botData.isBotGloballyPaused) {
    return ctx.reply("⚠️ البوت متوقف ومتجمد بالفعل مسبقاً!");
  }
  botData.isBotGloballyPaused = true;
  botData.pauseStartTime = Date.now();
  saveData();
  return ctx.replyWithMarkdown("❄️ *تم إيقاف البوت عن الجميع (المستخدمين والأدمنية) وتجميد كافة الأوقات والاشتراكات بنجاح!*\n💡 البوت الآن يعمل لديك وحدك.");
});

bot.command("onbot", (ctx) => {
  const userId = ctx.from.id.toString();
  if (!isDev(userId)) return ctx.reply("❌ هذا الأمر مخصص للمطور الأساسي فقط.");
  if (!botData.isBotGloballyPaused) {
    return ctx.reply("⚠️ البوت يعمل بشكل طبيعي وليس متوقفاً.");
  }
  const pauseDuration = Date.now() - botData.pauseStartTime;
  botData.totalPausedDuration = (botData.totalPausedDuration || 0) + pauseDuration;
  botData.isBotGloballyPaused = false;
  botData.pauseStartTime = null;
  saveData();
  return ctx.replyWithMarkdown("⚡ *تم تشغيل البوت وإتاحته للجميع واستئناف جميع الأوقات والاشتراكات بنجاح!*");
});

bot.command("gencode", (ctx) => {
  const userId = ctx.from.id.toString();
  if (!isAdmin(userId)) return ctx.reply("❌ للإدارة فقط.");
  const parts = ctx.message.text.split(" ");
  const durationArg = (parts[1] || "1d").toLowerCase();
  const permType = (parts[2] || "all").toLowerCase();

  if (!['like', 'spam', 'all'].includes(permType)) {
    return ctx.reply("⚠️ يرجى تحديد الصلاحية بدقة:\n`like`, `spam`, أو `all`\nمثال: `/gencode 5h spam` أو `/gencode 2d all`");
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
  botData.codes[code] = { durationMs: ms, durationDesc: durationArg, permissionType: permType, used: false, createdBy: userId };
  saveData();
  return ctx.replyWithMarkdown(`✅ *تم توليد كود الاشتراك بنجاح:*\n🔑 \`${code}\`\n⏳ المدة: ${durationArg}\n🛡️ الصلاحية: *${permType}*`);
});

bot.command("codes", (ctx) => {
  const userId = ctx.from.id.toString();
  if (!isAdmin(userId)) return ctx.reply("❌ للإدارة فقط.");
  const unused = Object.keys(botData.codes).filter(k => !botData.codes[k].used);
  if (!unused.length) return ctx.reply("📌 لا توجد أكواد نشطة.");
  let txt = "📋 *الأكواد النشطة في البوت:*\n\n";
  for (const c of unused) txt += `🔑 \`${c}\` (المدة: ${botData.codes[c].durationDesc} | صلاحية: ${botData.codes[c].permissionType})\n`;
  return ctx.replyWithMarkdown(txt);
});

bot.command("cloak", (ctx) => {
  const userId = ctx.from.id.toString();
  if (!isAdmin(userId)) return ctx.reply("❌ للإدارة فقط.");
  const code = (ctx.message.text.split(" ")[1] || "").trim();
  if (!code || !botData.codes[code]) return ctx.reply("❌ الكود غير موجود.");
  botData.codes[code].used = true;
  saveData();
  return ctx.replyWithMarkdown(`✅ تم إتلاف الكود: \`${code}\``);
});

bot.command("users", (ctx) => {
  const userId = ctx.from.id.toString();
  if (!isAdmin(userId)) return ctx.reply("❌ للإدارة فقط.");
  
  const totalSubscribers = botData.activeUsers.length;
  const totalActiveGroups = botData.activeGroups.length;
  const totalAdmins = botData.admins.length;
  const bannedList = botData.bannedOrBlocked && botData.bannedOrBlocked.length > 0 
    ? botData.bannedOrBlocked.map((g, idx) => `${idx + 1}. ${g}`).join("\n") 
    : "لا توجد أي مجموعات قامت بحظر البوت أو طرده حتى الآن.";

  const statsMsg = 
    `📊 *إحصائيات البوت الشاملة:*\n\n` +
    `👤 المشتركين: \`${totalSubscribers}\`\n` +
    `👥 القروبات المفعّلة: \`${totalActiveGroups}\`\n` +
    `🛡️ عدد الأدمنية: \`${totalAdmins}\`\n\n` +
    `🚫 *قائمة المجموعات التي حظرت أو طردت البوت (${botData.bannedOrBlocked ? botData.bannedOrBlocked.length : 0}):*\n` +
    `${bannedList}`;

  return ctx.replyWithMarkdown(statsMsg);
});

bot.command("addadmin", async (ctx) => {
  const userId = ctx.from.id.toString();
  if (!isDev(userId)) return ctx.reply("❌ للمطور فقط.");
  const uId = ctx.message.text.split(" ")[1];
  if (!uId) return ctx.reply("⚠️ استخدم: `/addadmin <ID>`");
  if (!botData.admins.includes(uId)) {
    botData.admins.push(uId);
    saveData();
  }
  await ctx.telegram.sendMessage(uId, "🎉 مبروك! تم تعيينك كأدمن (مشرف) جديد في البوت بنجاح.").catch(() => {});
  return ctx.replyWithMarkdown(`✅ تم إضافة الأدمن (\`${uId}\`) وإرسال إشعار له.`);
});

bot.command("remadmin", async (ctx) => {
  const userId = ctx.from.id.toString();
  if (!isDev(userId)) return ctx.reply("❌ للمطور فقط.");
  const uId = ctx.message.text.split(" ")[1];
  if (!uId) return ctx.reply("⚠️ استخدم: `/remadmin <ID>`");
  const idx = botData.admins.indexOf(uId);
  if (idx !== -1 && uId !== DEVELOPER_ID) {
    botData.admins.splice(idx, 1);
    saveData();
    await ctx.telegram.sendMessage(uId, "⚠️ تنبيه: تم إزالتك من قائمة الأدمنية في البوت.").catch(() => {});
    return ctx.replyWithMarkdown(`✅ تم إزالة الأدمن (\`${uId}\`) وإرسال إشعار له.`);
  }
  return ctx.reply("❌ لا يمكنك إزالة هذا الأدمن.");
});

bot.command("addgroup", async (ctx) => {
  const userId = ctx.from.id.toString();
  if (!isAdmin(userId)) return ctx.reply("❌ للأدمن والمطور فقط.");
  const parts = ctx.message.text.split(/\s+/);
  let gInput = parts[1];
  const uId = parts[2];
  const durationArg = (parts[3] || "30d").toLowerCase();
  const groupPerm = (parts[4] || "all").toLowerCase();

  if (!gInput || !uId) {
    return ctx.replyWithMarkdown("⚠️ *الاستخدام الصحيح:*\n`/addgroup <group_id_or_link> <user_id> <duration> <like/spam/all>`");
  }

  if (!['like', 'spam', 'all'].includes(groupPerm)) {
    return ctx.reply("⚠️ الصلاحية يجب أن تكون: `like`, `spam`, أو `all`");
  }

  let gId = await resolveChatId(ctx, gInput);
  if (!gId) {
    return ctx.reply("❌ تعذر العثور على القروب عبر الرابط أو الآيدي المدخل، تأكد من صحته وأن البوت متواجد فيه.");
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
  if (groupPerm === "all") serviceDesc = "لايكات وسبام والفرق (جميع الخدمات)";
  else if (groupPerm === "like") serviceDesc = "لايكات فقط";
  else if (groupPerm === "spam") serviceDesc = "سبام والفرق فقط";

  const successMsg = 
    `╭━━━ ⚡ 𝙈𝙄𝘾𝙃𝘼𝙀𝙇 𝙀𝙇𝙄𝙏𝙀 ━━━╮\n\n` +
    `🎉 تم تفعيل الاشتراك بنجاح!\n\n` +
    `🏷️ المجموعة: ${gInput}\n` +
    `📅 مدة الاشتراك: ${durationDesc}\n` +
    `⚙️ نوع الخدمات المفعلة: ${serviceDesc}\n\n` +
    `✅ مجموعتك الآن جاهزة للاستفادة من خدمات البوت.\n\n` +
    `╰━━━━━━━━━━━━━━━━━━╯\n` +
    `⚡ 𝙈𝙄𝘾𝙃𝘼𝙀𝙇 𝙀𝙇𝙄𝙏𝙀`;

  await ctx.telegram.sendMessage(uId, successMsg, { parse_mode: "Markdown" }).catch(() => {});
  return ctx.replyWithMarkdown(`✅ *تم تفعيل القروب وتنبيه المستخدم بنجاح!*\n🆔 الآيدي: \`${gId}\`\n🛡️ الصلاحية: *${groupPerm}*`);
});

bot.command("remgroup", async (ctx) => {
  const userId = ctx.from.id.toString();
  if (!isAdmin(userId)) return ctx.reply("❌ للأدمن والمطور فقط.");
  const parts = ctx.message.text.split(/\s+/);
  let gInput = parts[1];
  if (!gInput) return ctx.replyWithMarkdown("⚠️ *الاستخدام الصحيح:*\n`/remgroup <group_id_or_link>`");

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
    return ctx.replyWithMarkdown(`🔴 *تم إزالة القروب بنجاح من القائمة النشطة!*`);
  }
  return ctx.replyWithMarkdown(`⚠️ القروب غير موجود في قائمة القروبات المفعلة.`);
});

bot.command("groups", async (ctx) => {
  const userId = ctx.from.id.toString();

  if (!botData.userGroups || !botData.userGroups[userId] || botData.userGroups[userId].length === 0) {
    return ctx.reply("📌 ليس لديك أي مجموعات مفعلة حالياً.");
  }

  const userGList = botData.userGroups[userId];
  let likeGroupsText = "🎯 *قروبات اللايكات المفعلة:*\n\n";
  let spamGroupsText = "🚀 *قروبات السبام والفرق المفعلة:*\n\n";
  
  let likeCount = 0;
  let spamCount = 0;

  for (let i = 0; i < userGList.length; i++) {
    const gId = userGList[i];
    const record = botData.groupJoinRecords[gId] || { title: "مجموعة", username: "بدون معرف" };
    const perm = botData.groupPermissions[gId] || "all";
    const activeStatus = isGroupActive(gId) ? "مفعل 🟢" : "غير مفعل / منتهي 🔴";
    
    const groupItem = `• *${record.title}*\n  🆔 الآيدي: \`${gId}\`\n  ⚙️ الحالة: ${activeStatus}\n-------------------------\n`;

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
    return ctx.reply("📌 ليس لديك أي مجموعات مفعلة حالياً.");
  }

  return ctx.replyWithMarkdown(finalTxt);
});

bot.command("likeauto", async (ctx) => {
  const userId = ctx.from.id.toString();
  const parts = ctx.message.text.split(/\s+/);
  const targetUid = parts[1];
  const daysInput = parseInt(parts[2]);

  if (!targetUid || !daysInput || isNaN(daysInput)) {
    return ctx.replyWithMarkdown("⚠️ *الاستخدام الصحيح:*\n`/likeauto <uid> <days>`\n*(مثال: `/likeauto 1712656538 5`)*");
  }

  if (daysInput < 2 || daysInput > 10) {
    return ctx.reply("❌ عذراً، عدد الأيام يجب أن يكون بين 2 إلى 10 أيام كحد أقصى.");
  }

  if (!botData.autoLikes) botData.autoLikes = {};
  if (!botData.autoLikes[userId]) botData.autoLikes[userId] = {};

  const userUidsCount = Object.keys(botData.autoLikes[userId]).length;
  if (!botData.autoLikes[userId][targetUid] && userUidsCount >= 5) {
    return ctx.reply("❌ لقد وصلت للحد الأقصى (5 أيديات فقط في قائمة الأوتولايك في نفس الوقت).");
  }

  botData.autoLikes[userId][targetUid] = daysInput;
  saveData();

  return ctx.replyWithMarkdown(
    `✅ *تم تفعيل الأوتو لايك بنجاح!*\n` +
    `🎯 الآيدي: \`${targetUid}\`\n` +
    `⏳ عدد الأيام: \`${daysInput} أيام\`\n` +
    `📊 الأيديات النشطة لديك: \`${Object.keys(botData.autoLikes[userId]).length}/5\``
  );
});

bot.command("removeauto", async (ctx) => {
  const userId = ctx.from.id.toString();
  const text = ctx.message.text.trim();
  const parts = text.split(/\s+/);
  const targetUid = parts[1];
  const daysToSubtract = parts[2] ? parseInt(parts[2].replace("/", "")) : null;

  if (!targetUid) {
    return ctx.replyWithMarkdown("⚠️ *الاستخدام الصحيح:*\nإزالة كاملة: `/removeauto <uid>`\nتنقيص أيام: `/removeauto <uid> <days>`");
  }

  if (!botData.autoLikes || !botData.autoLikes[userId] || !botData.autoLikes[userId][targetUid]) {
    return ctx.reply("⚠️ هذا الآيدي غير مسجل في قائمة الأوتولايك الخاصة بك.");
  }

  if (daysToSubtract && !isNaN(daysToSubtract)) {
    let currentDays = botData.autoLikes[userId][targetUid];
    let newDays = currentDays - daysToSubtract;

    if (newDays <= 0) {
      delete botData.autoLikes[userId][targetUid];
      saveData();
      return ctx.replyWithMarkdown(`✅ تم إزالة الآيدي \`${targetUid}\` بالكامل لانتهاء الأيام المحددة.`);
    } else {
      botData.autoLikes[userId][targetUid] = newDays;
      saveData();
      return ctx.replyWithMarkdown(`✅ تم تنقيص الأيام بنجاح للآيدي \`${targetUid}\`.\n⏳ المتبقي الآن: \`${newDays} أيام\`.`);
    }
  } else {
    delete botData.autoLikes[userId][targetUid];
    saveData();
    return ctx.replyWithMarkdown(`✅ *تم إزالة الآيدي (\`${targetUid}\`) بالكامل من قائمة الأوتولايك بنجاح!*`);
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
        return ctx.reply("⛔ عذراً، هذه المجموعة غير مفعلة أو انتهى اشتراكها. لا يمكن استخدام خدمات البوت هنا قبل التفعيل.");
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
    if (chatType === 'private') return ctx.reply("⚠️ خاص بالمجموعات المصرحة فقط.");
    if (!isGroupActive(chatId)) return ctx.reply("⚠️ القروب غير مفعل.");
    if (!await isGroupAdmin(ctx) && !isAdmin(userId)) return ctx.reply("❌ مخصص لأدمنة المجموعة فقط.");
    const idx = botData.disabledGroups.indexOf(chatId);
    if (idx !== -1) { botData.disabledGroups.splice(idx, 1); saveData(); }
    return ctx.reply("🟢 تم تشغيل البوت في المجموعة بنجاح!");
  }

  if (/^\/(?:off|of)(?:@[A-Za-z0-9_]+)?$/i.test(text)) {
    if (chatType === 'private') return ctx.reply("⚠️ خاص بالمجموعات المصرحة فقط.");
    if (!isGroupActive(chatId)) return ctx.reply("⚠️ القروب غير مفعل.");
    if (!await isGroupAdmin(ctx) && !isAdmin(userId)) return ctx.reply("❌ مخصص لأدمنة المجموعة فقط.");
    if (!botData.disabledGroups.includes(chatId)) { botData.disabledGroups.push(chatId); saveData(); }
    return ctx.reply("تم إيقاف البوت في المجموعة ⚠️");
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

  if (chatType === 'private' && !isAdmin(userId)) {
    const userPerm = botData.userPermissions[userId] || "all";
    if (userPerm === "like" && (/^\/(?:spam|spam_ff)/i.test(baseCmd) || /^5\//.test(text) || /^6\//.test(text))) {
      return; 
    }
    if (userPerm === "spam" && baseCmd === '/like') {
      return; 
    }
  }

  if (baseCmd === '/like') {
    const perm = chatType !== 'private' ? (botData.groupPermissions[chatId] || "all") : "all";
    if (chatType !== 'private' && perm === "spam") {
      return ctx.reply("❌ عذراً، هذا القروب مخصص للسبام فقط ولا يدعم أوامر اللايكات.");
    }
  }

  if (baseCmd === '/spam' || baseCmd === '/spam_ff' || baseCmd === '5/' || baseCmd === '6/' || text.startsWith("5/") || text.startsWith("6/")) {
    const perm = chatType !== 'private' ? (botData.groupPermissions[chatId] || "all") : "all";
    if (chatType !== 'private' && perm === "like") {
      return ctx.reply("❌ عذراً، هذا القروب مخصص للايكات فقط ولا يدعم أوامر السبام والفرق.");
    }
  }

  if (baseCmd === '/like') {
    const targetUid = parts[1];
    if (!targetUid || !/^\d+$/.test(targetUid)) {
      return ctx.replyWithMarkdown("⚠️ *الاستخدام الصحيح:*\n`/like <uid>`\n*(مثال: `/like 1712656538`)*");
    }

    let waitMsg = await ctx.reply(`⏳ جاري إرسال اللايكات للآيدي: (${targetUid})، يرجى الانتظار...`);
    try {
      const result = await enqueueLikeTask(targetUid);
      if (waitMsg) await ctx.telegram.deleteMessage(chatId, waitMsg.message_id).catch(() => {});
      
      const successReply = 
        `╭━━━ ⚡ 𝙈𝙄𝘾𝙃𝘼𝙀𝙇 𝙀𝙇𝙄𝙏𝙀 ━━━╮\n\n` +
        `✅ تم إرسال اللايكات بنجاح!\n\n` +
        `👤 اسم اللاعب: *${result.nickname}*\n` +
        `🆔 الآيدي: \`${targetUid}\`\n` +
        `📊 المستوي: *${result.level}*\n` +
        `❤️ اللايكات السابقة: \`${result.beforeLikes}\`\n` +
        `💙 اللايكات الحالية: \`${result.afterLikes}\`\n` +
        `🔥 المضاف: \`+${result.addedLikes}\`\n\n` +
        `╰━━━━━━━━━━━━━━━━━━╯\n` +
        `⚡ 𝙈𝙄𝘾𝙃𝘼𝙀𝙇 𝙀𝙇𝙄𝙏𝙀`;

      return ctx.replyWithMarkdown(successReply);
    } catch (e) {
      if (waitMsg) await ctx.telegram.deleteMessage(chatId, waitMsg.message_id).catch(() => {});
      if (e.message === "DUPLICATE_UID") {
        return ctx.reply("⚠️ هذا الآيدي قيد المعالجة حالياً في طابور الطلبات، يرجى الانتظار قليلاً.");
      } else if (e.message === "QUEUE_FULL") {
        return ctx.reply("⚠️ الضغط عالي جداً على البوت حالياً، يرجى المحاولة بعد قليل.");
      } else if (e.message === "INVALID_UID") {
        return ctx.reply("❌ عذراً، الآيدي المدخل غير صحيح أو غير موجود في اللعبة.");
      }
      return ctx.reply("❌ حدث خطأ أثناء إرسال اللايكات، يرجى المحاولة لاحقاً.");
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
      return ctx.replyWithMarkdown("⚠️ *الاستخدام الصحيح للسبام:*\n`/spam <uid>` أو `/spam_ff <uid>`\nأو استخدام الاختصارات:\n`5/<uid>` أو `6/<uid>`");
    }

    const activeSpamCount = getUserActiveSpamCount(userId, spamType);
    if (!isAdmin(userId) && activeSpamCount >= 3) {
      return ctx.reply("❌ لقد وصلت للحد الأقصى (3 عمليات سبام نشطة في نفس الوقت). يرجى الانتظار حتى انتهاء إحداها.");
    }

    const accounts = getAccounts();
    if (accounts.length === 0) {
      return ctx.reply("❌ عذراً، لا توجد حسابات مسجلة في ملف `accounts.txt` لتنفيذ السبام.");
    }

    let waitMsg = await ctx.reply(`🚀 جاري بدء عملية السبام للآيدي: (\`${targetUid}\`)، يرجى الانتظار...`, { parse_mode: "Markdown" });

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
        `🚀 تم بدء عملية السبام بنجاح!\n\n` +
        `🎯 الآيدي المستهدف: \`${targetUid}\`\n` +
        `⏳ مدة التهدئة (Cooldown): \`6 ساعات\`\n` +
        `⚡ تمت العملية بكفاءة عالية.\n\n` +
        `╰━━━━━━━━━━━━━━━━━━╯\n` +
        `⚡ 𝙈𝙄𝘾𝙃𝘼𝙀𝙇 𝙀𝙇𝙄𝙏𝙀`
      );
    } catch (e) {
      if (waitMsg) await ctx.telegram.deleteMessage(chatId, waitMsg.message_id).catch(() => {});
      return ctx.reply("❌ حدث خطأ أثناء تنفيذ عملية السبام، يرجى المحاولة لاحقاً.");
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

// تشغيل البوت وإغلاقه بشكل آمن
bot.launch().then(() => console.log("Unified Bot running successfully 24/7!")).catch(console.error);
process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
