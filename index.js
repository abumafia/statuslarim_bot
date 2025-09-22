const { Telegraf, Markup, Scenes, session } = require('telegraf');
const { MongoClient, ObjectId } = require('mongodb');
require('dotenv').config();
const express = require("express");

const bot = new Telegraf(process.env.BOT_TOKEN);
let db;
const app = express();

// Botni Express bilan birlashtirish
app.use(bot.webhookCallback("/webhook"));

// Render uchun asosiy route
app.get("/", (req, res) => {
  res.send("Bot is running 🚀");
});

// Webhook endpointini o‘rnatish
bot.telegram.setWebhook("https://statuslarim-bot.onrender.com/webhook");

// MongoDB ulanish
async function connectDB() {
    const client = new MongoClient(process.env.MONGODB_URI);
    await client.connect();
    db = client.db('telegram_mini_blog');
    console.log('MongoDB ga ulandik');
}

// Modellar
const users = () => db.collection('users');
const posts = () => db.collection('posts');
const subscriptions = () => db.collection('subscriptions');

// Yangi foydalanuvchi qo'shish
async function ensureUser(ctx) {
    const userId = ctx.from.id;
    const user = await users().findOne({ userId });
    
    if (!user) {
        await users().insertOne({
            userId,
            username: ctx.from.username,
            firstName: ctx.from.first_name,
            lastName: ctx.from.last_name,
            createdAt: new Date(),
            postCount: 0
        });
    }
    return userId;
}

// Post yaratish sahna
const createPostScene = new Scenes.BaseScene('createPost');
createPostScene.enter((ctx) => ctx.reply('Yangi post matnini yuboring:'));
createPostScene.on('text', async (ctx) => {
    const userId = await ensureUser(ctx);
    const postText = ctx.message.text;
    
    await posts().insertOne({
        userId,
        text: postText,
        likes: 0,
        likedBy: [],
        createdAt: new Date()
    });
    
    await users().updateOne(
        { userId },
        { $inc: { postCount: 1 } }
    );
    
    await ctx.reply('Post muvaffaqiyatli joylandi!');
    ctx.scene.leave();
});
createPostScene.on('message', (ctx) => ctx.reply('Faqat matnli postlar qo\'llab-quvvatlanadi.'));

// Sahnalarni ro'yxatdan o'tkazish
const stage = new Scenes.Stage([createPostScene]);
bot.use(session());
bot.use(stage.middleware());

// Asosiy menyu
bot.start(async (ctx) => {
    await ensureUser(ctx);
    await ctx.reply(
        'Xush kelibsiz! Mini Blog botiga.\n\n' +
        'Buyruqlar:\n' +
        '/post - Yangi post yaratish\n' +
        '/feed - Postlarni ko\'rish\n' +
        '/profile - Profilni ko\'rish\n' +
        '/stats - Bot statistikasi',
        Markup.keyboard([
            ['📝 Post', '📰 Feed'],
            ['👤 Profil', '📊 Statistika']
        ]).resize()
    );
});

// Yangi post yaratish
bot.command('post', (ctx) => ctx.scene.enter('createPost'));
bot.hears('📝 Post', (ctx) => ctx.scene.enter('createPost'));

// Feed postlari
bot.command('feed', async (ctx) => {
    await showRandomPost(ctx);
});
bot.hears('📰 Feed', async (ctx) => {
    await showRandomPost(ctx);
});

// Tasodifiy post ko'rsatish
async function showRandomPost(ctx) {
    const allPosts = await posts().find().toArray();
    
    if (allPosts.length === 0) {
        return ctx.reply('Hali hech qanday post yo\'q.');
    }
    
    const randomPost = allPosts[Math.floor(Math.random() * allPosts.length)];
    const postUser = await users().findOne({ userId: randomPost.userId });
    
    const likes = randomPost.likes || 0;
    const likeButton = Markup.button.callback(`❤️ ${likes}`, `like_${randomPost._id}`);
    const profileButton = Markup.button.callback('👤 Profilga o\'tish', `profile_${postUser.userId}`);
    
    await ctx.reply(
        `📝 Post #${randomPost._id.toString().slice(-6)}\n\n` +
        `${randomPost.text}\n\n` +
        `👤: ${postUser.firstName} (@${postUser.username || 'noma\'lum'})\n` +
        `📅: ${randomPost.createdAt.toLocaleDateString()}`,
        Markup.inlineKeyboard([
            [likeButton],
            [profileButton]
        ])
    );
}

// Like bosish
bot.action(/like_(.+)/, async (ctx) => {
    const postId = ctx.match[1];
    const userId = ctx.from.id;
    
    const post = await posts().findOne({ _id: new ObjectId(postId) });
    
    if (!post) {
        return ctx.answerCbQuery('Post topilmadi!');
    }
    
    if (post.likedBy.includes(userId)) {
        return ctx.answerCbQuery('Siz allaqachon like bosgansiz!');
    }
    
    await posts().updateOne(
        { _id: new ObjectId(postId) },
        { 
            $inc: { likes: 1 },
            $push: { likedBy: userId }
        }
    );
    
    await ctx.answerCbQuery('Like qo\'shildi!');
    
    // Yangilangan post ma'lumotlari
    const updatedPost = await posts().findOne({ _id: new ObjectId(postId) });
    const postUser = await users().findOne({ userId: updatedPost.userId });
    
    const likeButton = Markup.button.callback(`❤️ ${updatedPost.likes}`, `like_${postId}`);
    const profileButton = Markup.button.callback('👤 Profilga o\'tish', `profile_${postUser.userId}`);
    
    await ctx.editMessageReplyMarkup({
        inline_keyboard: [
            [likeButton],
            [profileButton]
        ]
    });
});

// Profil ko'rish
bot.command('profile', async (ctx) => {
    await showProfile(ctx, ctx.from.id, true);
});
bot.hears('👤 Profil', async (ctx) => {
    await showProfile(ctx, ctx.from.id, true);
});

// Profilga o'tish inline tugmasi
bot.action(/profile_(\d+)/, async (ctx) => {
    const targetUserId = parseInt(ctx.match[1]);
    await showProfile(ctx, targetUserId, false);
});

// Profil ko'rsatish
async function showProfile(ctx, userId, isOwnProfile) {
    const user = await users().findOne({ userId });
    if (!user) return ctx.reply('Foydalanuvchi topilmadi.');
    
    // Obunachilar soni
    const subscribersCount = await subscriptions().countDocuments({ targetId: userId });
    // Obuna bo'lganlar soni
    const subscriptionsCount = await subscriptions().countDocuments({ subscriberId: userId });
    
    // Foydalanuvchi postlari
    const userPosts = await posts().find({ userId }).sort({ createdAt: -1 }).limit(5).toArray();
    
    let profileText = `👤 ${user.firstName} ${user.lastName || ''}\n`;
    profileText += `📧 @${user.username || 'noma\'lum'}\n\n`;
    profileText += `📊 Statistika:\n`;
    profileText += `📝 Postlar: ${user.postCount || 0}\n`;
    profileText += `👥 Obunachilar: ${subscribersCount}\n`;
    profileText += `📋 Obunalar: ${subscriptionsCount}\n\n`;
    profileText += `📅 Ro'yxatdan o'tgan: ${user.createdAt.toLocaleDateString()}`;
    
    const keyboard = [];
    
    // Agar o'z profili bo'lmasa, obuna tugmalarini qo'shish
    if (!isOwnProfile && ctx.from.id !== userId) {
        const isSubscribed = await subscriptions().findOne({
            subscriberId: ctx.from.id,
            targetId: userId
        });
        
        if (isSubscribed) {
            keyboard.push([Markup.button.callback('❌ Obunani bekor qilish', `unsubscribe_${userId}`)]);
        } else {
            keyboard.push([Markup.button.callback('✅ Obuna bo\'lish', `subscribe_${userId}`)]);
        }
    }
    
    // O'z profili bo'lsa, postlar ro'yxati
    if (isOwnProfile && userPosts.length > 0) {
        profileText += `\n\n📝 So'nggi postlar:\n`;
        userPosts.forEach((post, index) => {
            profileText += `${index + 1}. ${post.text.slice(0, 50)}${post.text.length > 50 ? '...' : ''}\n`;
            profileText += `   ❤️ ${post.likes} | 📅 ${post.createdAt.toLocaleDateString()}\n\n`;
        });
        
        keyboard.push([Markup.button.callback('🔄 Yangi post yaratish', 'create_post')]);
    }
    
    // Feedga qaytish tugmasi
    keyboard.push([Markup.button.callback('📰 Feedga qaytish', 'back_to_feed')]);
    
    // Agar callback query bo'lsa, messageni tahrirlash
    if (ctx.callbackQuery) {
        await ctx.editMessageText(profileText, Markup.inlineKeyboard(keyboard));
        await ctx.answerCbQuery();
    } else {
        await ctx.reply(profileText, Markup.inlineKeyboard(keyboard));
    }
}

// Obuna bo'lish inline tugmasi
bot.action(/subscribe_(\d+)/, async (ctx) => {
    const targetUserId = parseInt(ctx.match[1]);
    const subscriberId = ctx.from.id;
    
    if (targetUserId === subscriberId) {
        return ctx.answerCbQuery('O\'zingizga obuna bo\'la olmaysiz!');
    }
    
    const existingSub = await subscriptions().findOne({
        subscriberId,
        targetId: targetUserId
    });
    
    if (existingSub) {
        return ctx.answerCbQuery('Siz allaqachon obuna bo\'lgansiz!');
    }
    
    await subscriptions().insertOne({
        subscriberId,
        targetId: targetUserId,
        createdAt: new Date()
    });
    
    await ctx.answerCbQuery('Obuna bo\'lish muvaffaqiyatli!');
    
    // Profilni yangilash
    await showProfile(ctx, targetUserId, false);
});

// Obunani bekor qilish inline tugmasi
bot.action(/unsubscribe_(\d+)/, async (ctx) => {
    const targetUserId = parseInt(ctx.match[1]);
    const subscriberId = ctx.from.id;
    
    await subscriptions().deleteOne({
        subscriberId,
        targetId: targetUserId
    });
    
    await ctx.answerCbQuery('Obuna bekor qilindi!');
    
    // Profilni yangilash
    await showProfile(ctx, targetUserId, false);
});

// Yangi post yaratish inline tugmasi
bot.action('create_post', (ctx) => {
    ctx.scene.enter('createPost');
    ctx.answerCbQuery('Post yaratish rejimiga o\'tildi');
});

// Feedga qaytish
bot.action('back_to_feed', async (ctx) => {
    await showRandomPost(ctx);
    await ctx.answerCbQuery();
});

// Boshqa foydalanuvchi profiliga o'tish
bot.command('user', async (ctx) => {
    const username = ctx.message.text.split(' ')[1];
    
    if (!username) {
        return ctx.reply('Foydalanuvchi profiliga o\'tish uchun: /user @username');
    }
    
    const targetUser = await users().findOne({ username: username.replace('@', '') });
    if (!targetUser) {
        return ctx.reply('Foydalanuvchi topilmadi.');
    }
    
    await showProfile(ctx, targetUser.userId, false);
});

// Statistika
bot.command('stats', async (ctx) => {
    const totalUsers = await users().countDocuments();
    const totalPosts = await posts().countDocuments();
    const totalLikes = await posts().aggregate([
        { $group: { _id: null, total: { $sum: '$likes' } } }
    ]).toArray();
    
    const likesCount = totalLikes.length > 0 ? totalLikes[0].total : 0;
    
    ctx.reply(
        `📊 Bot statistikasi:\n\n` +
        `👥 Jami foydalanuvchilar: ${totalUsers}\n` +
        `📝 Jami postlar: ${totalPosts}\n` +
        `❤️ Jami layklar: ${likesCount}`
    );
});

// Statistika
bot.hears('📊 Statistika', async (ctx) => {
    const totalUsers = await users().countDocuments();
    const totalPosts = await posts().countDocuments();
    
    ctx.reply(
        `📊 Bot statistikasi:\n\n` +
        `👥 Jami foydalanuvchilar: ${totalUsers}\n` +
        `📝 Jami postlar: ${totalPosts}`
    );
});

// Xatoliklar
bot.catch((err, ctx) => {
    console.error(`Xato: ${err}`);
    ctx.reply('Xatolik yuz berdi!');
});

// Render uchun portni ochish
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server ${PORT}-portda ishlayapti`);
});