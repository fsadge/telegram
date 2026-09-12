// Cloudflare Workers Telegram 双向消息转发机器人
// 无状态设计 - 不依赖内存存储，Worker重启不影响功能
// 环境变量配置 - 在Cloudflare Workers控制台中设置以下变量：
// BOT_TOKEN: Telegram Bot Token (从 @BotFather 获取)
// ADMIN_CHAT_ID: 管理员的Chat ID (可以通过发送消息给机器人获取)
// WEBHOOK_SECRET: Webhook验证密钥 (可选，用于安全验证)
// ENABLE_USER_TRACKING: 启用用户跟踪 (可选，需要绑定KV存储)
// USER_ID_SECRET: 用户ID签名密钥 (建议设置，用于防止身份伪造攻击)
// ENABLE_FORUM_MODE: 启用论坛话题模式 (可选，当管理员聊天为论坛群组时启用)
// ENABLE_CAPTCHA: 启用Emoji序列人机验证 (可选，默认开启；设为 false 可关闭)
// CAPTCHA_SECRET: 人机验证签名密钥 (可选，默认复用 USER_ID_SECRET)
// CAPTCHA_TIMEOUT_SECONDS: 人机验证限时秒数 (可选，默认 180)
// CAPTCHA_VERIFY_TTL_HOURS: 验证通过后的有效小时数 (可选，默认 720)

// 常量定义
const CONSTANTS = {
  MAX_USERS_LIMIT: 1000,
  BROADCAST_BATCH_SIZE: 10,
  BROADCAST_DELAY_MS: 100,
  API_TIMEOUT_MS: 30000,
  MAX_RETRIES: 3,
  RETRY_DELAY_MS: 1000,
  TELEGRAM_API_BASE: 'https://api.telegram.org/bot',
  DEFAULT_ICON_COLORS: [0x6FB9F0, 0xFFD67E, 0xCB86DB, 0x6EBF95, 0xFFB3BA, 0x87CEFA],
  MAX_ERROR_DISPLAY: 5,
  MAX_RECENT_USERS: 20,
  USERS_DEFAULT_PAGE_SIZE: 20,
  USERS_PAGE_SIZES: [10, 20, 50],
  // 人机验证配置
  CAPTCHA_POOL: [
    '🤼', '🎪', '🦶', '🫁', '🪵', '💌', '🎈', '🍎', '🚀', '🐱',
    '🐶', '🌸', '🍕', '🎁', '🔔', '🐟', '🌙', '🍀', '🧩', '🎩',
    '🎯', '🍭', '🦄', '🐢', '🎸', '🔑', '🌵', '🍄', '🐧', '🎃'
  ],
  CAPTCHA_GRID_SIZE: 9,
  CAPTCHA_GRID_COLUMNS: 3,
  CAPTCHA_TARGET_COUNT: 5,
  CAPTCHA_DEFAULT_TIMEOUT_SECONDS: 180,
  CAPTCHA_DEFAULT_TTL_HOURS: 720,
  CAPTCHA_DEFAULT_FAIL_WINDOW_SECONDS: 600,
  CAPTCHA_MAX_FAILURES: 5,
  CAPTCHA_LOCKOUT_SECONDS: 900
};

// 验证环境变量
function validateEnvironment(env) {
  const required = ['BOT_TOKEN', 'ADMIN_CHAT_ID'];
  const missing = required.filter(key => !env[key]);
  
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
  
  // 验证 ADMIN_CHAT_ID 格式
  if (!/^-?\d+$/.test(env.ADMIN_CHAT_ID)) {
    throw new Error('ADMIN_CHAT_ID must be a valid integer');
  }
  
  // 验证 BOT_TOKEN 格式
  if (!/^\d+:[A-Za-z0-9_-]+$/.test(env.BOT_TOKEN)) {
    throw new Error('BOT_TOKEN format is invalid');
  }
}

// 输入验证函数
function validateInput(input, type, options = {}) {
  switch (type) {
    case 'message':
      if (!input || typeof input !== 'object') {
        throw new Error('Invalid message object');
      }
      if (!input.from || !input.chat) {
        throw new Error('Message missing required fields');
      }
      break;
    
    case 'chatId':
      if (!input || !/^-?\d+$/.test(input.toString())) {
        throw new Error('Invalid chat ID format');
      }
      break;
    
    case 'text':
      if (typeof input !== 'string') {
        throw new Error('Text must be a string');
      }
      if (options.maxLength && input.length > options.maxLength) {
        throw new Error(`Text exceeds maximum length of ${options.maxLength}`);
      }
      break;
    
    case 'userId':
      if (!input || !/^\d+$/.test(input.toString())) {
        throw new Error('Invalid user ID format');
      }
      break;
    
    default:
      throw new Error(`Unknown validation type: ${type}`);
  }
}

// 增强的日志记录函数
function logError(context, error, additionalInfo = {}) {
  const logEntry = {
    timestamp: new Date().toISOString(),
    context,
    error: {
      message: error.message,
      stack: error.stack,
      name: error.name
    },
    ...additionalInfo
  };
  
  console.error('ERROR:', JSON.stringify(logEntry, null, 2));
}

function logInfo(context, message, additionalInfo = {}) {
  const logEntry = {
    timestamp: new Date().toISOString(),
    context,
    message,
    ...additionalInfo
  };
  
  console.log('INFO:', JSON.stringify(logEntry, null, 2));
}

// 重试机制
async function withRetry(operation, context, maxRetries = CONSTANTS.MAX_RETRIES) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (attempt === maxRetries) {
        logError(context, error, { attempt, maxRetries });
        throw error;
      }
      
      logInfo(context, `Attempt ${attempt} failed, retrying...`, { 
        error: error.message, 
        nextAttempt: attempt + 1 
      });
      
      await new Promise(resolve => setTimeout(resolve, CONSTANTS.RETRY_DELAY_MS * attempt));
    }
  }
}

// 检测聊天是否为论坛群组
async function isForum(chatId, botToken) {
  try {
    validateInput(chatId, 'chatId');
    
    const chat = await callTelegramAPI('getChat', { chat_id: chatId }, botToken);
    return chat.ok && chat.result.is_forum === true;
  } catch (error) {
    logError('isForum', error, { chatId });
    return false;
  }
}

// 获取论坛话题列表
async function getForumTopics(chatId, botToken) {
  try {
    validateInput(chatId, 'chatId');
    
    const topics = await callTelegramAPI('getForumTopicIconStickers', { chat_id: chatId }, botToken);
    return topics.ok ? topics.result : [];
  } catch (error) {
    logError('getForumTopics', error, { chatId });
    return [];
  }
}

// 创建论坛话题
async function createForumTopic(chatId, name, iconColor, botToken) {
  try {
    validateInput(chatId, 'chatId');
    validateInput(name, 'text', { maxLength: 128 });
    
    const result = await callTelegramAPI('createForumTopic', {
      chat_id: chatId,
      name: name,
      icon_color: iconColor || CONSTANTS.DEFAULT_ICON_COLORS[0]
    }, botToken);
    
    return result;
  } catch (error) {
    logError('createForumTopic', error, { chatId, name, iconColor });
    return { ok: false, error: error.message };
  }
}

// 从KV存储获取用户话题映射
async function getUserTopicMapping(env) {
  try {
    if (!env.USER_STORAGE) {
      return {};
    }
    
    const mapping = await env.USER_STORAGE.get('user_topic_mapping');
    const parsed = mapping ? JSON.parse(mapping) : {};
    
    // 验证数据结构
    if (typeof parsed !== 'object' || parsed === null) {
      logError('getUserTopicMapping', new Error('Invalid mapping data structure'));
      return {};
    }
    
    return parsed;
  } catch (error) {
    logError('getUserTopicMapping', error);
    return {};
  }
}

// 保存用户话题映射到KV存储
async function saveUserTopicMapping(mapping, env) {
  try {
    if (!env.USER_STORAGE) return;
    
    if (typeof mapping !== 'object' || mapping === null) {
      throw new Error('Invalid mapping data structure');
    }
    
    await env.USER_STORAGE.put('user_topic_mapping', JSON.stringify(mapping));
  } catch (error) {
    logError('saveUserTopicMapping', error);
  }
}

// 从话题ID反向查找用户ID
async function getUserIdFromTopicId(topicId, env) {
  try {
    if (!topicId || typeof topicId !== 'number') {
      throw new Error('Invalid topic ID');
    }
    
    const mapping = await getUserTopicMapping(env);
    
    for (const [userId, userTopicId] of Object.entries(mapping)) {
      if (userTopicId === topicId) {
        return userId;
      }
    }
    
    return null;
  } catch (error) {
    logError('getUserIdFromTopicId', error, { topicId });
    return null;
  }
}

// 为用户创建或获取话题
async function getOrCreateUserTopic(userId, userName, env) {
  if (env.ENABLE_FORUM_MODE !== 'true') return null;
  
  try {
    validateInput(userId, 'userId');
    validateInput(userName, 'text', { maxLength: 64 });
    
    const mapping = await getUserTopicMapping(env);
    
    // 如果用户已有话题，返回话题ID
    if (mapping[userId]) {
      return mapping[userId];
    }
    
    // 创建新话题
    const topicName = `💬 ${userName} (${userId})`;
    const randomColor = CONSTANTS.DEFAULT_ICON_COLORS[
      Math.floor(Math.random() * CONSTANTS.DEFAULT_ICON_COLORS.length)
    ];
    
    const result = await createForumTopic(env.ADMIN_CHAT_ID, topicName, randomColor, env.BOT_TOKEN);
    
    if (result.ok) {
      const topicId = result.result.message_thread_id;
      mapping[userId] = topicId;
      await saveUserTopicMapping(mapping, env);
      
      logInfo('topicCreated', 'User topic created', { userId, userName, topicId });
      return topicId;
    }
    
    logError('getOrCreateUserTopic', new Error('Failed to create topic'), { result });
    return null;
  } catch (error) {
    logError('getOrCreateUserTopic', error, { userId, userName });
    return null;
  }
}

// 生成用户ID的HMAC签名
async function generateUserIdSignature(userId, secret) {
  try {
    validateInput(userId, 'userId');
    
    if (!secret) {
      // 如果没有配置密钥，使用简单的哈希作为后备
      const data = new TextEncoder().encode(`user:${userId}:fallback`);
      const hashBuffer = await crypto.subtle.digest('SHA-256', data);
      const hashArray = Array.from(new Uint8Array(hashBuffer));
      return hashArray.map(b => b.toString(16).padStart(2, '0')).join('').substring(0, 16);
    }
    
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );
    
    const data = new TextEncoder().encode(`user:${userId}`);
    const signature = await crypto.subtle.sign('HMAC', key, data);
    const signatureArray = Array.from(new Uint8Array(signature));
    return signatureArray.map(b => b.toString(16).padStart(2, '0')).join('').substring(0, 16);
  } catch (error) {
    logError('generateUserIdSignature', error, { userId });
    throw error;
  }
}

// 验证用户ID签名
async function verifyUserIdSignature(userId, signature, secret) {
  try {
    const expectedSignature = await generateUserIdSignature(userId, secret);
    return signature === expectedSignature;
  } catch (error) {
    logError('verifyUserIdSignature', error, { userId, signature });
    return false;
  }
}

// 创建安全的用户标识符（可点击链接）
async function createSecureUserTag(userId, secret, username = null) {
  try {
    const signature = await generateUserIdSignature(userId, secret);
    
    if (username) {
      // 对于有username的用户，使用@username格式，但保留签名用于验证
      return `[@${username} (${userId}:${signature})](https://t.me/${username})`;
    } else {
      // 对于没有username的用户，使用user ID深度链接
      return `[👤 USER:${userId}:${signature}](tg://user?id=${userId})`;
    }
  } catch (error) {
    logError('createSecureUserTag', error, { userId });
    
    if (username) {
      // 降级处理，使用简单的@username链接
      return `[@${username}](https://t.me/${username})`;
    } else {
      // 降级处理，仍然可点击但没有签名验证
      return `[👤 USER:${userId}](tg://user?id=${userId})`;
    }
  }
}

// 从消息中安全提取用户Chat ID的辅助函数
async function extractUserChatId(messageText, secret) {
  try {
    if (!messageText || typeof messageText !== 'string') return null;
    
    // 新的username链接格式：[@username (userId:signature)](https://t.me/username)
    const usernameMatch = messageText.match(/\[@\w+ \((\d+):([a-f0-9]{16})\)\]\(https:\/\/t\.me\/\w+\)/);
    if (usernameMatch) {
      const userId = usernameMatch[1];
      const signature = usernameMatch[2];
      
      // 验证签名
      const isValid = await verifyUserIdSignature(userId, signature, secret);
      if (isValid) {
        return userId;
      } else {
        logError('extractUserChatId', new Error('Invalid signature'), { userId, signature });
        return null;
      }
    }
    
    // 兼容username链接格式（无签名）：[@username](https://t.me/username)
    const legacyUsernameMatch = messageText.match(/\[@(\w+)\]\(https:\/\/t\.me\/\w+\)/);
    if (legacyUsernameMatch && !usernameMatch) {
      logInfo('extractUserChatId', 'Using legacy username format, cannot extract user ID from username only');
      return null; // 无法从username反向获取user ID
    }
    
    // 新的可点击链接格式：[👤 USER:id:signature](tg://user?id=id)
    const clickableLinkMatch = messageText.match(/\[👤 USER:(\d+):([a-f0-9]{16})\]\(tg:\/\/user\?id=\d+\)/);
    if (clickableLinkMatch) {
      const userId = clickableLinkMatch[1];
      const signature = clickableLinkMatch[2];
      
      // 验证签名
      const isValid = await verifyUserIdSignature(userId, signature, secret);
      if (isValid) {
        return userId;
      } else {
        logError('extractUserChatId', new Error('Invalid signature'), { userId, signature });
        return null;
      }
    }
    
    // 兼容旧的可点击链接格式（无签名）：[👤 USER:id](tg://user?id=id)
    const legacyClickableMatch = messageText.match(/\[👤 USER:(\d+)\]\(tg:\/\/user\?id=\d+\)/);
    if (legacyClickableMatch && !clickableLinkMatch) {
      logInfo('extractUserChatId', 'Using legacy clickable format', { userId: legacyClickableMatch[1] });
      return legacyClickableMatch[1];
    }
    
    // 兼容旧的方括号格式：[USER:id:signature]
    const secureMatch = messageText.match(/\[USER:(\d+):([a-f0-9]{16})\]/);
    if (secureMatch) {
      const userId = secureMatch[1];
      const signature = secureMatch[2];
      
      // 验证签名
      const isValid = await verifyUserIdSignature(userId, signature, secret);
      if (isValid) {
        return userId;
      } else {
        logError('extractUserChatId', new Error('Invalid signature'), { userId, signature });
        return null;
      }
    }
    
    // 兼容最旧格式：[USER:id]（逐步淘汰，仅在没有新格式时使用）
    const legacyMatch = messageText.match(/\[USER:(\d+)\](?![:\w])/);
    if (legacyMatch && !secureMatch && !clickableLinkMatch && !legacyClickableMatch && !usernameMatch) {
      logInfo('extractUserChatId', 'Using legacy format', { userId: legacyMatch[1] });
      return legacyMatch[1];
    }
    
    return null;
  } catch (error) {
    logError('extractUserChatId', error, { messageText });
    return null;
  }
}

// 解析群发命令的目标用户
function parsePostTargets(commandText) {
  if (!commandText) return { userIds: [], message: '' }
  
  const parts = commandText.split(' ')
  if (parts.length < 2) return { userIds: [], message: '' }
  
  const targetsStr = parts[0]
  const message = parts.slice(1).join(' ')
  
  // 处理特殊关键词
  if (targetsStr === 'all') {
    return { userIds: 'all', message }
  }
  
  // 解析用户ID列表（逗号分隔）
  const userIds = targetsStr.split(',')
    .map(id => id.trim())
    .filter(id => /^\d+$/.test(id))
  
  return { userIds, message }
}

// 从KV存储获取用户列表
async function getUsersFromKV(env) {
  try {
    if (!env.USER_STORAGE) {
      logInfo('getUsersFromKV', 'KV storage not configured');
      return [];
    }
    
    const usersData = await env.USER_STORAGE.get('user_list');
    if (!usersData) return [];
    
    const users = JSON.parse(usersData);
    
    // 验证数据结构
    if (!Array.isArray(users)) {
      logError('getUsersFromKV', new Error('Invalid users data structure'));
      return [];
    }
    
    return users;
  } catch (error) {
    logError('getUsersFromKV', error);
    return [];
  }
}

// 向KV存储添加用户
async function addUserToKV(chatId, userInfo, env) {
  try {
    if (!env.USER_STORAGE) return;
    
    validateInput(chatId, 'chatId');
    validateInput(userInfo.userName, 'text', { maxLength: 100 });
    validateInput(userInfo.userId, 'userId');
    
    const users = await getUsersFromKV(env);
    const existingIndex = users.findIndex(u => u.chatId === chatId);
    
    const userData = {
      chatId,
      userName: userInfo.userName,
      username: userInfo.username, // 保存原始username
      userId: userInfo.userId,
      lastActive: new Date().toISOString()
    };
    
    if (existingIndex >= 0) {
      users[existingIndex] = userData;
    } else {
      users.push(userData);
    }
    
    // 保持最多指定数量的用户记录
    if (users.length > CONSTANTS.MAX_USERS_LIMIT) {
      users.sort((a, b) => new Date(b.lastActive).getTime() - new Date(a.lastActive).getTime());
      users.splice(CONSTANTS.MAX_USERS_LIMIT);
    }
    
    await env.USER_STORAGE.put('user_list', JSON.stringify(users));
    logInfo('addUserToKV', 'User added/updated', { chatId, userName: userInfo.userName });
  } catch (error) {
    logError('addUserToKV', error, { chatId, userInfo });
  }
}

// 改进的群发媒体消息发送函数
async function sendMediaBroadcastToUser(userChatId, adminChatId, messageId, broadcastMessage, botToken) {
  // 构建广播前缀（使用纯文本格式，避免Markdown解析问题）
  const broadcastPrefix = '📢 管理员广播:';
  
  try {
    const escapedBroadcastMessage = escapeMarkdown(broadcastMessage);
    const fullCaption = `${broadcastPrefix}\n\n${escapedBroadcastMessage}`;
    
    // 检查caption长度限制（Telegram限制为1024字符）
    const finalCaption = fullCaption.length > 1024 
      ? `${broadcastPrefix}\n\n${escapedBroadcastMessage.substring(0, 1024 - broadcastPrefix.length - 4)}...`
      : fullCaption;
    
    // 尝试发送带caption的媒体消息
    const result = await copyMessage(userChatId, adminChatId, messageId, botToken, {
      caption: finalCaption
    });
    
    // 如果成功，直接返回
    if (result.ok) {
      return result;
    }
    
    // 如果失败（可能是文件类型不支持caption），则分别发送
    logInfo('sendMediaBroadcastToUser', 'Caption failed, sending separately', { 
      error: result.description,
      userChatId 
    });
    
    // 先发送广播前缀和内容
    await sendMessage(userChatId, fullCaption, botToken);
    
    // 再发送原始媒体（不带caption）
    return await copyMessage(userChatId, adminChatId, messageId, botToken);
    
  } catch (error) {
    logError('sendMediaBroadcastToUser', error, { userChatId, messageId });
    
    // 最后的fallback：只发送文本提示
    try {
      const escapedBroadcastMessage = escapeMarkdown(broadcastMessage);
      await sendMessage(userChatId, `${broadcastPrefix}\n\n${escapedBroadcastMessage}\n\n📎 管理员还发送了一个文件`, botToken);
      return await copyMessage(userChatId, adminChatId, messageId, botToken);
    } catch (fallbackError) {
      logError('sendMediaBroadcastToUser', fallbackError, { userChatId, messageId, stage: 'fallback' });
      throw fallbackError;
    }
  }
}

// 群发消息功能
async function broadcastMessage(userIds, message, env, isMedia = false, mediaOptions = {}) {
  const results = { success: 0, failed: 0, errors: [] };
  
  try {
    validateInput(message, 'text', { maxLength: 4096 });
    
    // 获取实际的用户ID列表
    let targetUserIds = [];
    if (userIds === 'all') {
      const users = await getUsersFromKV(env);
      targetUserIds = users.map(u => u.chatId);
      if (targetUserIds.length === 0) {
        return { 
          success: 0, 
          failed: 1, 
          errors: ['未找到可广播的用户，请确保已启用用户跟踪功能'] 
        };
      }
    } else {
      targetUserIds = Array.isArray(userIds) ? userIds : [userIds];
    }
    
    if (targetUserIds.length === 0) {
      return { success: 0, failed: 1, errors: ['未指定有效的用户ID'] };
    }
    
    // 验证所有用户ID
    const validUserIds = targetUserIds.filter(id => {
      try {
        validateInput(id, 'chatId');
        return true;
      } catch (error) {
        results.errors.push(`无效的用户ID: ${id}`);
        results.failed++;
        return false;
      }
    });
    
    logInfo('broadcastMessage', 'Starting broadcast', { 
      totalUsers: validUserIds.length, 
      isMedia, 
      messageLength: message.length 
    });
    
    // 限制并发数量以避免API限制
    for (let i = 0; i < validUserIds.length; i += CONSTANTS.BROADCAST_BATCH_SIZE) {
      const batch = validUserIds.slice(i, i + CONSTANTS.BROADCAST_BATCH_SIZE);
      
      const promises = batch.map(async (chatId) => {
        try {
          if (isMedia) {
            await sendMediaBroadcastToUser(chatId, env.ADMIN_CHAT_ID, mediaOptions.messageId, message, env.BOT_TOKEN);
          } else {
            // 转义广播消息中的特殊字符
            const escapedMessage = escapeMarkdown(message);
            await sendMessage(chatId, `📢 *管理员广播:*\n\n${escapedMessage}`, env.BOT_TOKEN);
          }
          results.success++;
        } catch (error) {
          results.failed++;
          results.errors.push(`用户 ${chatId}: ${error.message}`);
          logError('broadcastMessage', error, { chatId, isMedia });
        }
      });
      
      await Promise.allSettled(promises);
      
      // 添加短暂延迟以避免触发速率限制
      if (i + CONSTANTS.BROADCAST_BATCH_SIZE < validUserIds.length) {
        await new Promise(resolve => setTimeout(resolve, CONSTANTS.BROADCAST_DELAY_MS));
      }
    }
    
    logInfo('broadcastMessage', 'Broadcast completed', { 
      success: results.success, 
      failed: results.failed, 
      errorCount: results.errors.length 
    });
    
    return results;
  } catch (error) {
    logError('broadcastMessage', error, { userIds, message, isMedia });
    return { success: 0, failed: 1, errors: [error.message] };
  }
}

// 统一的Telegram API调用函数
async function callTelegramAPI(method, params, botToken) {
  const url = `${CONSTANTS.TELEGRAM_API_BASE}${botToken}/${method}`;
  
  try {
    validateInput(method, 'text', { maxLength: 100 });
    
    const response = await withRetry(async () => {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), CONSTANTS.API_TIMEOUT_MS);
      
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(params),
          signal: controller.signal
        });
        
        clearTimeout(timeoutId);
        return response;
      } catch (error) {
        clearTimeout(timeoutId);
        throw error;
      }
    }, `callTelegramAPI-${method}`);

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Telegram API error: ${response.status} ${response.statusText} - ${errorText}`);
    }

    const result = await response.json();
    
    // 验证返回数据结构
    if (typeof result !== 'object' || !result.hasOwnProperty('ok')) {
      throw new Error('Invalid API response format');
    }
    
    return result;
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error(`Telegram API timeout for ${method}`);
    }
    logError('callTelegramAPI', error, { method, params: Object.keys(params) });
    throw error;
  }
}

// 转义 Telegram Markdown 特殊字符
function escapeMarkdown(text) {
  if (typeof text !== 'string') {
    return text;
  }
  
  // 仅针对 Telegram 旧版 Markdown 必需字符进行转义，避免破坏 URL（如 https://baidu.com）
  // 必需转义: _ * [ ] `
  return text.replace(/[_*\[\]`]/g, '\\$&');
}

// 发送消息
async function sendMessage(chatId, text, botToken, options = {}) {
  try {
    validateInput(chatId, 'chatId');
    validateInput(text, 'text', { maxLength: 4096 });
    
    const params = {
      chat_id: chatId,
      text: text,
      parse_mode: options.parse_mode || 'Markdown',
      disable_web_page_preview: options.disable_web_page_preview !== undefined ? options.disable_web_page_preview : true,
      ...options
    };
    
    return await callTelegramAPI('sendMessage', params, botToken);
  } catch (error) {
    logError('sendMessage', error, { chatId, textLength: text?.length });
    throw error;
  }
}

// 复制消息
async function copyMessage(chatId, fromChatId, messageId, botToken, options = {}) {
  try {
    validateInput(chatId, 'chatId');
    validateInput(fromChatId, 'chatId');
    
    if (!messageId || typeof messageId !== 'number') {
      throw new Error('Invalid message ID');
    }
    
    const params = {
      chat_id: chatId,
      from_chat_id: fromChatId,
      message_id: messageId,
      parse_mode: options.parse_mode || 'Markdown',
      disable_web_page_preview: options.disable_web_page_preview !== undefined ? options.disable_web_page_preview : true,
      ...options
    };
    
    return await callTelegramAPI('copyMessage', params, botToken);
  } catch (error) {
    logError('copyMessage', error, { chatId, fromChatId, messageId });
    throw error;
  }
}

// 设置Webhook
async function setWebhook(url, botToken, secret = '') {
  const params = {
    url: url,
    secret_token: secret
  }
  return await callTelegramAPI('setWebhook', params, botToken)
}

// 获取机器人信息
async function getMe(botToken) {
  return await callTelegramAPI('getMe', {}, botToken)
}

// 编辑消息文本
async function editMessageText(chatId, messageId, text, botToken, options = {}) {
  try {
    validateInput(chatId, 'chatId');
    validateInput(text, 'text', { maxLength: 4096 });
    
    const params = {
      chat_id: chatId,
      message_id: messageId,
      text: text,
      parse_mode: options.parse_mode || 'Markdown',
      disable_web_page_preview: options.disable_web_page_preview !== undefined ? options.disable_web_page_preview : true,
      reply_markup: options.reply_markup || undefined
    };
    
    return await callTelegramAPI('editMessageText', params, botToken);
  } catch (error) {
    logError('editMessageText', error, { chatId, messageId, textLength: text?.length });
    throw error;
  }
}

// 回答回调查询（用于内联按钮加载状态）
async function answerCallbackQuery(callbackQueryId, botToken, text = '', showAlert = false) {
  try {
    const params = {
      callback_query_id: callbackQueryId,
      text,
      show_alert: !!showAlert
    };
    return await callTelegramAPI('answerCallbackQuery', params, botToken);
  } catch (error) {
    logError('answerCallbackQuery', error, { callbackQueryId });
    // 不再向外抛出，避免阻断主要流程
    return { ok: false, description: error.message };
  }
}

// ==================== 人机验证（Emoji 序列点击验证） ====================
// 形式：9宫格 Emoji 内联按钮 + 5 个目标序列，要求在限时内按序列依次点击；
//       点击方向随机为「从左往右」或「从右往左」，仅私聊可用。
// 实现要点：
//   1. 题库、目标序列与签名全部由随机 nonce 派生，回调数据自带签名与过期时间，天然无状态；
//   2. 验证结果与失败次数写入 KV（USER_STORAGE），未绑定时降级为实例内存并在日志中告警；
//   3. 连续点错达上限后触发冷却锁定，避免脚本暴力尝试。

const CAPTCHA_CALLBACK_PREFIX = 'cv';
const CAPTCHA_TOKEN_VERSION = 1;
const CAPTCHA_NONCE_BYTES = 6;
const CAPTCHA_MAC_BYTES = 8;
const CAPTCHA_SEAT_REFRESH = 'r';

// 未绑定 KV 时的降级存储（仅在同一 Worker 实例内有效，重启即失效）
const CAPTCHA_MEMORY_STORE = new Map();
let captchaMemoryFallbackWarned = false;

function isCaptchaEnabled(env) {
  const raw = env && env.ENABLE_CAPTCHA;
  if (raw === undefined || raw === null || raw === '') return true; // 默认开启
  const value = String(raw).trim().toLowerCase();
  return !['false', '0', 'off', 'no', 'disabled'].includes(value);
}

function getCaptchaSecret(env) {
  return String(
    (env && (env.CAPTCHA_SECRET || env.USER_ID_SECRET || env.WEBHOOK_SECRET || env.BOT_TOKEN)) ||
    'cftgsx-captcha-secret'
  );
}

function getCaptchaTimeoutSeconds(env) {
  const value = parseInt(env && env.CAPTCHA_TIMEOUT_SECONDS, 10);
  return Number.isFinite(value) && value >= 30 && value <= 3600
    ? value
    : CONSTANTS.CAPTCHA_DEFAULT_TIMEOUT_SECONDS;
}

function getCaptchaTtlSeconds(env) {
  const hours = parseFloat(env && env.CAPTCHA_VERIFY_TTL_HOURS);
  const validHours = Number.isFinite(hours) && hours > 0 && hours <= 8760
    ? hours
    : CONSTANTS.CAPTCHA_DEFAULT_TTL_HOURS;
  return Math.round(validHours * 3600);
}

function captchaKey(chatId, kind) {
  return `captcha:${kind}:${chatId}`;
}

// KV 优先、内存降级的轻量存储
async function captchaStoreGet(key, env) {
  if (env && env.USER_STORAGE) {
    try {
      const raw = await env.USER_STORAGE.get(key);
      return raw ? JSON.parse(raw) : null;
    } catch (error) {
      logError('captchaStoreGet', error, { key });
      return null;
    }
  }

  if (!captchaMemoryFallbackWarned) {
    captchaMemoryFallbackWarned = true;
    logInfo('captchaStoreGet', '未绑定 KV(USER_STORAGE)，人机验证状态将仅保存在当前实例内存中');
  }

  const entry = CAPTCHA_MEMORY_STORE.get(key);
  if (!entry) return null;
  if (entry.expireAt <= Date.now()) {
    CAPTCHA_MEMORY_STORE.delete(key);
    return null;
  }
  return entry.value;
}

async function captchaStorePut(key, value, ttlSeconds, env) {
  const ttl = Math.max(60, Math.round(ttlSeconds));

  if (env && env.USER_STORAGE) {
    try {
      await env.USER_STORAGE.put(key, JSON.stringify(value), { expirationTtl: ttl });
      return true;
    } catch (error) {
      logError('captchaStorePut', error, { key });
      return false;
    }
  }

  CAPTCHA_MEMORY_STORE.set(key, { value, expireAt: Date.now() + ttl * 1000 });
  return true;
}

async function captchaStoreDelete(key, env) {
  if (env && env.USER_STORAGE) {
    try {
      await env.USER_STORAGE.delete(key);
    } catch (error) {
      logError('captchaStoreDelete', error, { key });
    }
    return;
  }
  CAPTCHA_MEMORY_STORE.delete(key);
}

function bytesToBase64Url(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlToBytes(text) {
  const normalized = String(text).replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

async function captchaHmac(secret, messageBytes) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, messageBytes);
  return new Uint8Array(signature);
}

// 由 nonce 派生任意长度的确定性随机流，保证同一 nonce 重建出同一套题目
async function captchaRandomBytes(secret, nonceBytes, label, length) {
  const labelBytes = new TextEncoder().encode(label);
  const base = new Uint8Array(nonceBytes.length + 1 + labelBytes.length);
  base.set(nonceBytes, 0);
  base[nonceBytes.length] = 0x7c; // '|'
  base.set(labelBytes, nonceBytes.length + 1);

  const output = new Uint8Array(length);
  let offset = 0;
  let counter = 0;

  while (offset < length) {
    const message = new Uint8Array(base.length + 1);
    message.set(base, 0);
    message[base.length] = counter & 0xff;
    const block = await captchaHmac(secret, message);
    const take = Math.min(block.length, length - offset);
    output.set(block.subarray(0, take), offset);
    offset += take;
    counter += 1;
  }

  return output;
}

function captchaPickDistinct(values, randomBytes, count) {
  const pool = values.slice();
  const picked = [];
  let cursor = 0;

  while (picked.length < count && pool.length > 0) {
    const high = randomBytes[cursor % randomBytes.length];
    const low = randomBytes[(cursor + 1) % randomBytes.length];
    cursor += 2;
    const index = (((high << 8) | low) % pool.length);
    picked.push(pool.splice(index, 1)[0]);
  }

  return picked;
}

async function deriveCaptchaChallenge(secret, nonceBytes) {
  const layoutRandom = await captchaRandomBytes(secret, nonceBytes, 'layout', 64);
  const layout = captchaPickDistinct(CONSTANTS.CAPTCHA_POOL, layoutRandom, CONSTANTS.CAPTCHA_GRID_SIZE);

  const targetRandom = await captchaRandomBytes(secret, nonceBytes, 'targets', 64);
  const targets = captchaPickDistinct(
    layout,
    targetRandom,
    Math.min(CONSTANTS.CAPTCHA_TARGET_COUNT, layout.length)
  );

  // 点击方向随机：从左往右 或 从右往左（同样由 nonce 派生，保证无状态可重建）
  const directionRandom = await captchaRandomBytes(secret, nonceBytes, 'direction', 1);
  const direction = directionRandom[0] % 2 === 0 ? 'ltr' : 'rtl';

  return { layout, targets, direction };
}

async function buildCaptchaToken(secret, { issuedAt, step, nonceBytes }) {
  const payload = new Uint8Array(1 + 4 + 1 + nonceBytes.length);
  payload[0] = CAPTCHA_TOKEN_VERSION;
  payload[1] = (issuedAt >>> 24) & 0xff;
  payload[2] = (issuedAt >>> 16) & 0xff;
  payload[3] = (issuedAt >>> 8) & 0xff;
  payload[4] = issuedAt & 0xff;
  payload[5] = step & 0xff;
  payload.set(nonceBytes, 6);

  const mac = await captchaHmac(secret, payload);
  const full = new Uint8Array(payload.length + CAPTCHA_MAC_BYTES);
  full.set(payload, 0);
  full.set(mac.subarray(0, CAPTCHA_MAC_BYTES), payload.length);
  return bytesToBase64Url(full);
}

async function parseCaptchaToken(secret, token) {
  try {
    const bytes = base64UrlToBytes(token);
    const payloadLength = 1 + 4 + 1 + CAPTCHA_NONCE_BYTES;
    if (bytes.length !== payloadLength + CAPTCHA_MAC_BYTES) return null;
    if (bytes[0] !== CAPTCHA_TOKEN_VERSION) return null;

    const payload = bytes.subarray(0, payloadLength);
    const providedMac = bytes.subarray(payloadLength);
    const expectedMac = (await captchaHmac(secret, payload)).subarray(0, CAPTCHA_MAC_BYTES);

    let diff = 0;
    for (let i = 0; i < CAPTCHA_MAC_BYTES; i++) {
      diff |= providedMac[i] ^ expectedMac[i];
    }
    if (diff !== 0) return null;

    const issuedAt = ((payload[1] << 24) | (payload[2] << 16) | (payload[3] << 8) | payload[4]) >>> 0;
    return { issuedAt, step: payload[5], nonceBytes: payload.subarray(6, 6 + CAPTCHA_NONCE_BYTES) };
  } catch (error) {
    logError('parseCaptchaToken', error);
    return null;
  }
}

function buildCaptchaText(env, targets, step, direction = 'ltr') {
  const timeout = getCaptchaTimeoutSeconds(env);
  // 从右往左时，展示顺序与点击顺序相反（最右边的目标最先点）
  const displayed = direction === 'rtl' ? targets.slice().reverse() : targets;
  const sequence = displayed.map((emoji, index) => {
    const done = direction === 'rtl' ? index >= displayed.length - step : index < step;
    return done ? '✅' : emoji;
  }).join(' ');
  const arrowText = direction === 'rtl' ? '从右往左' : '从左往右';

  let text = `🤖 *人机验证*\n请在 ${timeout} 秒内按照下面目标序列${arrowText}依次点击：\n\n${sequence}`;
  if (step > 0) {
    text += `\n\n进度: ${step}/${targets.length}，请继续点击下一个目标。`;
  }
  return text;
}

function buildCaptchaKeyboard(layout, token) {
  const columns = CONSTANTS.CAPTCHA_GRID_COLUMNS;
  const inline_keyboard = [];

  for (let index = 0; index < layout.length; index += columns) {
    inline_keyboard.push(layout.slice(index, index + columns).map((emoji, offset) => ({
      text: emoji,
      callback_data: `${CAPTCHA_CALLBACK_PREFIX}:${index + offset}:${token}`
    })));
  }

  inline_keyboard.push([{
    text: '🔄 换一题',
    callback_data: `${CAPTCHA_CALLBACK_PREFIX}:${CAPTCHA_SEAT_REFRESH}:${token}`
  }]);

  return { inline_keyboard };
}

async function isCaptchaVerified(chatId, env) {
  const state = await captchaStoreGet(captchaKey(chatId, 'ok'), env);
  return !!(state && typeof state.until === 'number' && state.until > Date.now());
}

async function markCaptchaVerified(chatId, env, userInfo = null) {
  const ttl = getCaptchaTtlSeconds(env);
  const until = Date.now() + ttl * 1000;

  await captchaStorePut(captchaKey(chatId, 'ok'), {
    at: new Date().toISOString(),
    until,
    userName: userInfo ? userInfo.userName : undefined
  }, ttl, env);

  await captchaStoreDelete(captchaKey(chatId, 'fail'), env);
  logInfo('markCaptchaVerified', 'Captcha passed', { chatId, ttlHours: getCaptchaTtlSeconds(env) / 3600 });
  return until;
}

// 供管理员使用：清除某个用户/聊天的验证状态、失败计数与冷却锁定
async function resetCaptchaState(chatId, env) {
  await captchaStoreDelete(captchaKey(chatId, 'ok'), env);
  await captchaStoreDelete(captchaKey(chatId, 'fail'), env);
  await captchaStoreDelete(captchaKey(chatId, 'lock'), env);
}

async function getCaptchaLockRemainingMs(chatId, env) {
  const until = await captchaStoreGet(captchaKey(chatId, 'lock'), env);
  if (typeof until !== 'number') return 0;
  return Math.max(0, until - Date.now());
}

async function registerCaptchaFailure(chatId, env) {
  const key = captchaKey(chatId, 'fail');
  const state = await captchaStoreGet(key, env);
  const count = ((state && state.count) || 0) + 1;

  if (count >= CONSTANTS.CAPTCHA_MAX_FAILURES) {
    await captchaStorePut(key, { count: 0 }, CONSTANTS.CAPTCHA_DEFAULT_FAIL_WINDOW_SECONDS, env);
    await captchaStorePut(
      captchaKey(chatId, 'lock'),
      Date.now() + CONSTANTS.CAPTCHA_LOCKOUT_SECONDS * 1000,
      CONSTANTS.CAPTCHA_LOCKOUT_SECONDS,
      env
    );
    return { locked: true, remaining: 0, lockoutMinutes: Math.ceil(CONSTANTS.CAPTCHA_LOCKOUT_SECONDS / 60) };
  }

  await captchaStorePut(key, { count }, CONSTANTS.CAPTCHA_DEFAULT_FAIL_WINDOW_SECONDS, env);
  return { locked: false, remaining: CONSTANTS.CAPTCHA_MAX_FAILURES - count };
}

async function createCaptchaChallenge(env) {
  const secret = getCaptchaSecret(env);
  const nonceBytes = crypto.getRandomValues(new Uint8Array(CAPTCHA_NONCE_BYTES));
  const issuedAt = Math.floor(Date.now() / 1000) % 4294967296;
  const token = await buildCaptchaToken(secret, { issuedAt, step: 0, nonceBytes });
  const { layout, targets, direction } = await deriveCaptchaChallenge(secret, nonceBytes);

  return {
    issuedAt,
    nonceBytes,
    layout,
    targets,
    direction,
    text: buildCaptchaText(env, targets, 0, direction),
    reply_markup: buildCaptchaKeyboard(layout, token)
  };
}

async function sendCaptchaChallenge(chatId, env, intro = null) {
  const lockRemainingMs = await getCaptchaLockRemainingMs(chatId, env);
  if (lockRemainingMs > 0) {
    const minutes = Math.max(1, Math.ceil(lockRemainingMs / 60000));
    await sendMessage(chatId, `⏳ 验证尝试次数过多，请 ${minutes} 分钟后再发送 /verify 重新验证。`, env.BOT_TOKEN);
    return null;
  }

  const challenge = await createCaptchaChallenge(env);
  const text = intro ? `${intro}\n\n${challenge.text}` : challenge.text;
  const result = await sendMessage(chatId, text, env.BOT_TOKEN, { reply_markup: challenge.reply_markup });
  logInfo('sendCaptchaChallenge', 'Captcha challenge sent', { chatId, targets: challenge.targets });
  return result;
}

async function safeEditCaptchaMessage(chatId, messageId, text, env, replyMarkup = null) {
  try {
    return await editMessageText(chatId, messageId, text, env.BOT_TOKEN, replyMarkup ? { reply_markup: replyMarkup } : {});
  } catch (error) {
    logError('safeEditCaptchaMessage', error, { chatId, messageId });
    return { ok: false };
  }
}

const CAPTCHA_EXPIRED_TEXT = '⏰ *验证已超时*\n\n请发送 /verify 重新获取验证。';
const CAPTCHA_PASSED_TEXT = '✅ *验证通过*\n\n现在可以直接发送消息给管理员了。';
const CAPTCHA_FAILED_TEXT = '❌ *验证未通过*\n\n请按新的验证消息重新点击。';

// 处理人机验证按钮回调：cv:<座位号 或 r>:<token>
async function handleCaptchaCallbackQuery(callbackQuery, env) {
  const callbackQueryId = callbackQuery.id;
  const chat = (callbackQuery.message && callbackQuery.message.chat) || null;
  const chatId = chat && chat.id;
  const messageId = callbackQuery.message && callbackQuery.message.message_id;
  const userId = callbackQuery.from && callbackQuery.from.id;

  if (!chatId || !messageId) {
    await answerCallbackQuery(callbackQueryId, env.BOT_TOKEN, '无法定位消息', true);
    return;
  }

  // 人机验证只在私聊中进行：群组/频道内的按钮（含被转发出去的验证消息）一律拒绝
  const isGroupChat = !!chat.type && chat.type !== 'private';
  if (isGroupChat || String(userId) !== String(chatId)) {
    logInfo('handleCaptchaCallbackQuery', 'Rejected captcha click outside private chat', {
      chatId,
      chatType: chat.type,
      userId
    });
    await answerCallbackQuery(callbackQueryId, env.BOT_TOKEN, '请在私聊中完成验证', true);
    return;
  }

  const parts = String(callbackQuery.data || '').split(':');
  const seat = parts[1] || '';
  const token = parts[2] || '';
  const secret = getCaptchaSecret(env);
  const parsed = await parseCaptchaToken(secret, token);

  if (!parsed) {
    await answerCallbackQuery(callbackQueryId, env.BOT_TOKEN, '⚠️ 验证数据无效，请发送 /verify 重新验证', true);
    return;
  }

  const nowSeconds = Math.floor(Date.now() / 1000) % 4294967296;
  if (nowSeconds - parsed.issuedAt > getCaptchaTimeoutSeconds(env)) {
    await answerCallbackQuery(callbackQueryId, env.BOT_TOKEN, '⏰ 验证已超时，请发送 /verify 重新验证', true);
    await safeEditCaptchaMessage(chatId, messageId, CAPTCHA_EXPIRED_TEXT, env, { inline_keyboard: [] });
    return;
  }

  if ((await getCaptchaLockRemainingMs(chatId, env)) > 0) {
    await answerCallbackQuery(callbackQueryId, env.BOT_TOKEN, '⏳ 尝试次数过多，请稍后再试', true);
    return;
  }

  if (seat === CAPTCHA_SEAT_REFRESH) {
    const challenge = await createCaptchaChallenge(env);
    await answerCallbackQuery(callbackQueryId, env.BOT_TOKEN, '🔄 已更换题目');
    await safeEditCaptchaMessage(chatId, messageId, challenge.text, env, challenge.reply_markup);
    return;
  }

  const { layout, targets, direction } = await deriveCaptchaChallenge(secret, parsed.nonceBytes);
  const seatIndex = parseInt(seat, 10);
  const expected = targets[parsed.step];

  if (!Number.isInteger(seatIndex) || seatIndex < 0 || seatIndex >= layout.length || !expected) {
    await answerCallbackQuery(callbackQueryId, env.BOT_TOKEN, '⚠️ 验证数据异常，请发送 /verify 重新验证', true);
    return;
  }

  if (layout[seatIndex] === expected) {
    const nextStep = parsed.step + 1;

    if (nextStep >= targets.length) {
      const userInfo = {
        userName: (callbackQuery.from && (callbackQuery.from.username || callbackQuery.from.first_name)) || 'Unknown',
        userId,
        chatId
      };
      await markCaptchaVerified(chatId, env, userInfo);
      await answerCallbackQuery(callbackQueryId, env.BOT_TOKEN, '✅ 验证通过');
      await safeEditCaptchaMessage(chatId, messageId, CAPTCHA_PASSED_TEXT, env, { inline_keyboard: [] });

      if (env.ENABLE_USER_TRACKING === 'true') {
        await addUserToKV(chatId, {
          ...userInfo,
          username: (callbackQuery.from && callbackQuery.from.username) || null,
          lastActive: new Date().toISOString()
        }, env);
      }

      await sendMessage(chatId, '👋 你好！我是消息转发机器人。\n\n请发送你的消息，我会转发给管理员并尽快回复你。', env.BOT_TOKEN);
      return;
    }

    const nextToken = await buildCaptchaToken(secret, {
      issuedAt: parsed.issuedAt,
      step: nextStep,
      nonceBytes: parsed.nonceBytes
    });

    await answerCallbackQuery(callbackQueryId, env.BOT_TOKEN, `✅ 正确，还剩 ${targets.length - nextStep} 个`);
    await safeEditCaptchaMessage(
      chatId,
      messageId,
      buildCaptchaText(env, targets, nextStep, direction),
      env,
      buildCaptchaKeyboard(layout, nextToken)
    );
    return;
  }

  const failure = await registerCaptchaFailure(chatId, env);

  if (failure.locked) {
    await answerCallbackQuery(
      callbackQueryId,
      env.BOT_TOKEN,
      `❌ 连续答错 ${CONSTANTS.CAPTCHA_MAX_FAILURES} 次，请 ${failure.lockoutMinutes} 分钟后再试`,
      true
    );
    await safeEditCaptchaMessage(
      chatId,
      messageId,
      `🔒 *验证已锁定*\n\n错误次数过多，请 ${failure.lockoutMinutes} 分钟后再发送 /verify 重新验证。`,
      env,
      { inline_keyboard: [] }
    );
    return;
  }

  await answerCallbackQuery(callbackQueryId, env.BOT_TOKEN, `❌ 顺序错误，还有 ${failure.remaining} 次机会`, true);
  await safeEditCaptchaMessage(chatId, messageId, CAPTCHA_FAILED_TEXT, env, { inline_keyboard: [] });
  await sendCaptchaChallenge(chatId, env);
}

// 未通过验证的用户：只允许触发验证，其余消息一律拦截
async function handleUnverifiedUserMessage(message, userInfo, env) {
  const text = (message.text || '').trim();
  const lockRemainingMs = await getCaptchaLockRemainingMs(userInfo.chatId, env);

  if (lockRemainingMs > 0) {
    const minutes = Math.max(1, Math.ceil(lockRemainingMs / 60000));
    await sendMessage(
      userInfo.chatId,
      `⏳ 验证尝试次数过多，请 ${minutes} 分钟后再发送 /verify 重新验证。`,
      env.BOT_TOKEN
    );
    return;
  }

  if (text === '/start' || text.startsWith('/start ') || text === '/verify') {
    await sendCaptchaChallenge(userInfo.chatId, env);
    return;
  }

  await sendMessage(
    userInfo.chatId,
    '⚠️ 请先完成人机验证。\n\n请点击上方验证消息中的按钮，或发送 /verify 重新获取验证。',
    env.BOT_TOKEN
  );
}

// 生成 /users 分页文本与内联键盘
function buildUsersPage(users, page, pageSize) {
  const total = users.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const currentPage = Math.min(Math.max(1, page), totalPages);
  const start = (currentPage - 1) * pageSize;
  const end = Math.min(start + pageSize, total);
  
  const list = users.slice(start, end).map((user, idx) => {
    const lastActive = new Date(user.lastActive).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
    const escapedName = escapeMarkdown(user.userName || 'Unknown');
    const displayIndex = start + idx + 1;
    return `${displayIndex}. ${escapedName}\n   ID: \`${user.chatId}\`\n   最后活跃: ${lastActive}`;
  }).join('\n\n');
  
  const header = `👥 *用户列表*  (第 ${currentPage}/${totalPages} 页 · 共 ${total} 人)`;
  const body = list || '_暂无数据_';
  const text = `${header}\n\n${body}`;
  
  // 构建分页按钮
  const pageSizes = CONSTANTS.USERS_PAGE_SIZES || [10, 20, 50];
  const sizeRow = pageSizes.map((size) => ({
    text: size === pageSize ? `·${size}` : `${size}`,
    callback_data: `users:p=${currentPage},s=${size}`
  }));

  const inline_keyboard = [];
  const navRow = [];
  if (currentPage > 1) {
    navRow.push({ text: '◀️ 上一页', callback_data: `users:p=${currentPage - 1},s=${pageSize}` });
  }
  if (currentPage < totalPages) {
    navRow.push({ text: '下一页 ▶️', callback_data: `users:p=${currentPage + 1},s=${pageSize}` });
  }
  if (navRow.length > 0) inline_keyboard.push(navRow);
  inline_keyboard.push(sizeRow);
  
  return { text, reply_markup: { inline_keyboard }, page: currentPage, pageSize };
}

function parseUsersCallbackData(data) {
  // 格式: users:p=2,s=20
  const defaults = { page: 1, pageSize: CONSTANTS.USERS_DEFAULT_PAGE_SIZE || 20 };
  if (!data || !data.startsWith('users:')) return defaults;
  try {
    const payload = data.substring('users:'.length);
    const pairs = payload.split(',');
    const map = {};
    for (const pair of pairs) {
      const [k, v] = pair.split('=');
      if (k && v) map[k.trim()] = v.trim();
    }
    const page = parseInt(map.p || map.page || defaults.page, 10) || defaults.page;
    const pageSize = parseInt(map.s || map.pageSize || defaults.pageSize, 10) || defaults.pageSize;
    return { page, pageSize };
  } catch {
    return defaults;
  }
}

// 创建格式化的用户信息
function createUserInfo(message) {
  const { from, chat } = message
  const displayName = from.username || from.first_name || 'Unknown'
  const username = from.username || null // 单独保存username
  const userId = from.id
  const chatId = chat.id
  const time = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })
  
  // 为Markdown渲染转义动态文本，避免解析错误
  const escapedDisplayName = escapeMarkdown(displayName)
  const escapedUsernameForHeader = username ? escapeMarkdown(`@${username}`) : ''

  return {
    userName: displayName,
    username: username, // 原始username，可能为null
    userId,
    chatId,
    time,
    header: `📩 *来自用户: ${escapedDisplayName}*\n🆔 ID: \`${userId}\`${username ? `\n👤 用户名: ${escapedUsernameForHeader}` : ''}\n⏰ 时间: ${time}\n────────────────────`
  }
}

// 改进的媒体消息发送函数
async function sendMediaReplyToUser(userChatId, adminChatId, messageId, originalCaption, botToken) {
  try {
    // 构建回复前缀（使用纯文本格式，避免Markdown解析问题）
    const replyPrefix = '💬 管理员回复:';
    const escapedCaption = originalCaption ? escapeMarkdown(originalCaption) : ''
    const fullCaption = escapedCaption 
      ? `${replyPrefix}\n\n${escapedCaption}` 
      : replyPrefix;
    
    // 检查caption长度限制（Telegram限制为1024字符）
    const finalCaption = fullCaption.length > 1024 
      ? `${replyPrefix}\n\n${escapedCaption.substring(0, 1024 - replyPrefix.length - 4)}...`
      : fullCaption;
    
    // 尝试发送带caption的媒体消息
    const result = await copyMessage(userChatId, adminChatId, messageId, botToken, {
      caption: finalCaption
    });
    
    // 如果成功，直接返回
    if (result.ok) {
      return result;
    }
    
    // 如果失败（可能是文件类型不支持caption），则分别发送
    logInfo('sendMediaReplyToUser', 'Caption failed, sending separately', { 
      error: result.description,
      userChatId 
    });
    
    // 先发送回复前缀文本
    await sendMessage(userChatId, replyPrefix, botToken);
    
    // 再发送原始媒体（不带caption）
    return await copyMessage(userChatId, adminChatId, messageId, botToken);
    
  } catch (error) {
    logError('sendMediaReplyToUser', error, { userChatId, messageId });
    
    // 最后的fallback：只发送文本提示
    try {
      await sendMessage(userChatId, '💬 管理员发送了一个文件', botToken);
      return await copyMessage(userChatId, adminChatId, messageId, botToken);
    } catch (fallbackError) {
      logError('sendMediaReplyToUser', fallbackError, { userChatId, messageId, stage: 'fallback' });
      throw fallbackError;
    }
  }
}

// 处理用户消息
async function handleUserMessage(message, env) {
  const userInfo = createUserInfo(message)
  
  try {
    // 忽略其他机器人账号推送的内容，减少垃圾消息
    if (message.from.is_bot) {
      logInfo('handleUserMessage', 'Ignored message from bot', { userId: userInfo.userId })
      return
    }

    // 人机验证闸门：未通过验证前，任何消息都不会转发给管理员
    if (isCaptchaEnabled(env) && !(await isCaptchaVerified(userInfo.chatId, env))) {
      await handleUnverifiedUserMessage(message, userInfo, env)
      return
    }

    // 自动跟踪用户（如果启用）
    if (env.ENABLE_USER_TRACKING === 'true') {
      await addUserToKV(userInfo.chatId, userInfo, env)
    }
    
    // 发送欢迎消息给新用户
    if (message.text === '/start') {
      await sendMessage(
        userInfo.chatId, 
        `👋 你好！我是消息转发机器人。\n\n请发送你的消息，我会转发给管理员并尽快回复你。`, 
        env.BOT_TOKEN
      )
      return
    }

    // 创建包含用户信息的转发消息
    const secureUserTag = await createSecureUserTag(userInfo.chatId, env.USER_ID_SECRET, userInfo.username)
    let forwardResult
    
    // 论坛话题模式支持
    let messageOptions = {}
    if (env.ENABLE_FORUM_MODE === 'true') {
      const isForumChat = await isForum(env.ADMIN_CHAT_ID, env.BOT_TOKEN)
      if (isForumChat) {
        const topicId = await getOrCreateUserTopic(userInfo.userId, userInfo.userName, env)
        if (topicId) {
          messageOptions.message_thread_id = topicId
        }
      }
    }
    
    if (message.text) {
      // 文本消息
      const escapedUserText = escapeMarkdown(message.text)
      const forwardText = env.ENABLE_FORUM_MODE === 'true' && messageOptions.message_thread_id
        ? `📝 *新消息:*\n${escapedUserText}\n\n📍 *来源:* ${secureUserTag}`
        : `${userInfo.header}\n📝 *消息内容:*\n${escapedUserText}\n\n📍 *来源:* ${secureUserTag}`
      
      forwardResult = await sendMessage(env.ADMIN_CHAT_ID, forwardText, env.BOT_TOKEN, messageOptions)
    } else {
      // 媒体消息
      const escapedCaption = message.caption ? escapeMarkdown(message.caption) : '';
      
      // 根据消息类型确定媒体类型标识
      let mediaType = '📷 图片/文件';
      if (message.photo) mediaType = '📷 图片';
      else if (message.video) mediaType = '🎬 视频';
      else if (message.document) mediaType = '📄 文档';
      else if (message.voice) mediaType = '🎵 语音';
      else if (message.audio) mediaType = '🎵 音频';
      else if (message.video_note) mediaType = '🎥 视频消息';
      else if (message.sticker) mediaType = '🎭 贴纸';
      else if (message.animation) mediaType = '🎬 动画';
      
      const caption = env.ENABLE_FORUM_MODE === 'true' && messageOptions.message_thread_id
        ? `📝 *新消息:*${escapedCaption ? `\n${escapedCaption}` : `\n${mediaType}`}\n\n📍 *来源:* ${secureUserTag}`
        : `${userInfo.header}\n${escapedCaption ? `📝 *说明:* ${escapedCaption}\n\n` : ''}📍 *来源:* ${secureUserTag}`
      
      forwardResult = await copyMessage(env.ADMIN_CHAT_ID, userInfo.chatId, message.message_id, env.BOT_TOKEN, {
        ...messageOptions,
        caption
      })
    }

    if (forwardResult.ok) {
      console.log(`消息转发成功: 用户 ${userInfo.userName} -> 管理员${messageOptions.message_thread_id ? ' (话题 ' + messageOptions.message_thread_id + ')' : ''}`)
      
      // 给用户发送确认消息
      await sendMessage(userInfo.chatId, `✅ 你的消息已发送给管理员，请耐心等待回复。`, env.BOT_TOKEN)
    }
  } catch (error) {
    console.error('处理用户消息错误:', error)
    try {
      await sendMessage(userInfo.chatId, `❌ 抱歉，消息发送失败，请稍后再试。`, env.BOT_TOKEN)
    } catch (sendError) {
      console.error('发送错误消息失败:', sendError)
    }
  }
}

// 处理管理员消息
async function handleAdminMessage(message, env) {
  try {
    // 管理员命令处理
    if (message.text === '/start') {
      const userTrackingStatus = env.ENABLE_USER_TRACKING === 'true' ? '🟢 已启用' : '🔴 未启用'
      const forumModeStatus = env.ENABLE_FORUM_MODE === 'true' ? '🟢 已启用' : '🔴 未启用'
      const isForumChat = env.ENABLE_FORUM_MODE === 'true' ? await isForum(env.ADMIN_CHAT_ID, env.BOT_TOKEN) : false
      const captchaStatus = isCaptchaEnabled(env) ? '🟢 已启用' : '🔴 未启用'
      
      await sendMessage(env.ADMIN_CHAT_ID, 
        `🔧 *管理员面板*\n\n👋 欢迎使用消息转发机器人管理面板！\n\n📋 *可用命令:*\n• \`/status\` - 查看机器人状态\n• \`/help\` - 显示帮助信息\n• \`/post\` - 群发消息功能\n• \`/users\` - 查看用户列表（需启用用户跟踪）\n• \`/reset\` - 重置指定用户的人机验证\n\n💡 *使用说明:*\n• 直接回复用户消息即可回复给对应用户\n• 使用 /post 命令进行消息群发\n• 论坛模式下，每个用户有独立话题\n\n📊 *系统状态:*\n• 用户跟踪: ${userTrackingStatus}\n• 论坛模式: ${forumModeStatus}${isForumChat ? ' ✅ 已检测到论坛群组' : ''}\n• 人机验证: ${captchaStatus}\n\n🤖 机器人已就绪，等待用户消息...`, 
        env.BOT_TOKEN, 
        { message_thread_id: message.message_thread_id }
      )
      return
    }

    if (message.text === '/status') {
      const userCount = env.ENABLE_USER_TRACKING === 'true' 
        ? (await getUsersFromKV(env)).length 
        : '未启用跟踪'
      
      const captchaStatus = isCaptchaEnabled(env)
        ? (env.USER_STORAGE ? '🟢 已启用 (KV持久化)' : '🟡 已启用 (仅内存，建议绑定KV)')
        : '🔴 未启用'
      const forumModeStatus = env.ENABLE_FORUM_MODE === 'true' ? '🟢 已启用' : '🔴 未启用'
      const isForumChat = env.ENABLE_FORUM_MODE === 'true' ? await isForum(env.ADMIN_CHAT_ID, env.BOT_TOKEN) : false
      
      let topicCount = 0
      if (env.ENABLE_FORUM_MODE === 'true') {
        const mapping = await getUserTopicMapping(env)
        topicCount = Object.keys(mapping).length
      }
      
      await sendMessage(env.ADMIN_CHAT_ID, 
        `📊 *机器人状态*\n\n🟢 状态: 运行中\n🔄 模式: 无状态转发\n👥 已跟踪用户: ${userCount}\n🛡️ 人机验证: ${captchaStatus}\n🗣️ 论坛模式: ${forumModeStatus}${isForumChat ? ' (论坛群组)' : ''}\n📝 用户话题: ${topicCount}\n⏰ 查询时间: ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`, 
        env.BOT_TOKEN, 
        { message_thread_id: message.message_thread_id }
      )
      return
    }

    if (message.text === '/help') {
      const forumHelp = env.ENABLE_FORUM_MODE === 'true' ? 
        `\n\n🗣️ *论坛模式:*\n• 每个用户有独立话题\n• 在话题中直接发送消息即可回复用户\n• 支持话题内的媒体消息回复` : ''
      const captchaHelp = isCaptchaEnabled(env) ?
        `\n\n🛡️ *人机验证:*\n• 用户首次发消息需在 ${getCaptchaTimeoutSeconds(env)} 秒内按顺序点击 Emoji 完成验证\n• 未通过验证的消息不会转发给管理员（有效 ${getCaptchaTtlSeconds(env) / 3600} 小时）\n• \`/reset 用户ID\` - 重置指定用户的验证状态与失败锁定` :
        `\n\n🛡️ *人机验证:* 已关闭（ENABLE_CAPTCHA=false）`
      
      await sendMessage(env.ADMIN_CHAT_ID, 
        `❓ *帮助信息*\n\n🔄 *回复用户:*\n直接回复用户的消息即可发送回复给对应用户\n\n📢 *群发消息:*\n• \`/post all 消息内容\` - 向所有用户群发（需启用用户跟踪）\n• \`/post 123,456,789 消息内容\` - 向指定用户群发\n• 回复媒体消息并使用 /post 命令可群发媒体\n\n👥 *用户管理:*\n• \`/users\` - 查看已跟踪的用户列表\n\n📝 *消息格式:*\n• 支持文本、图片、文件等各种消息类型\n• 支持Markdown格式${forumHelp}${captchaHelp}\n\n⚙️ *命令列表:*\n• \`/start\` - 显示欢迎信息\n• \`/status\` - 查看机器人状态\n• \`/help\` - 显示此帮助信息\n• \`/post\` - 群发消息功能\n• \`/users\` - 查看用户列表\n• \`/reset\` - 重置用户人机验证状态`, 
        env.BOT_TOKEN, 
        { message_thread_id: message.message_thread_id }
      )
      return
    }

    if (message.text && message.text.startsWith('/post')) {
      const commandText = message.text.substring(5).trim()
      
      if (!commandText) {
        await sendMessage(env.ADMIN_CHAT_ID, 
          `📢 *群发功能使用说明*\n\n🎯 *命令格式:*\n• \`/post all 消息内容\` - 向所有用户群发\n• \`/post 123,456,789 消息内容\` - 向指定用户群发\n\n💡 *示例:*\n• \`/post all 系统维护通知：今晚22:00-23:00进行维护\`\n• \`/post 123456789,987654321 您好，这是一条测试消息\`\n\n📎 *群发媒体:*\n回复包含图片/文件的消息，然后使用 /post 命令\n\n⚠️ *注意:*\n• 使用 'all' 需要启用用户跟踪功能\n• 手动指定用户ID时，请用英文逗号分隔\n• 群发会自动限速以避免API限制`, 
          env.BOT_TOKEN, 
          { 
            reply_to_message_id: message.message_id,
            message_thread_id: message.message_thread_id
          }
        )
        return
      }

      const { userIds, message: postMessage } = parsePostTargets(commandText)
      
      if (!postMessage) {
        await sendMessage(env.ADMIN_CHAT_ID, 
          `❌ 请提供要群发的消息内容`, 
          env.BOT_TOKEN, 
          { 
            reply_to_message_id: message.message_id,
            message_thread_id: message.message_thread_id
          }
        )
        return
      }

      if (userIds === 'all' && env.ENABLE_USER_TRACKING !== 'true') {
        await sendMessage(env.ADMIN_CHAT_ID, 
          `❌ 使用 'all' 群发需要启用用户跟踪功能\n\n请设置环境变量 \`ENABLE_USER_TRACKING=true\` 并绑定KV存储`, 
          env.BOT_TOKEN, 
          { 
            reply_to_message_id: message.message_id,
            message_thread_id: message.message_thread_id
          }
        )
        return
      }

      if (Array.isArray(userIds) && userIds.length === 0) {
        await sendMessage(env.ADMIN_CHAT_ID, 
          `❌ 未找到有效的用户ID\n\n请检查格式: \`/post 123,456,789 消息内容\``, 
          env.BOT_TOKEN, 
          { 
            reply_to_message_id: message.message_id,
            message_thread_id: message.message_thread_id
          }
        )
        return
      }

      // 发送确认消息
      const targetCount = userIds === 'all' ? (await getUsersFromKV(env)).length : userIds.length
      await sendMessage(env.ADMIN_CHAT_ID, 
        `🚀 开始群发消息...\n\n📊 目标用户数: ${targetCount}\n⏳ 请稍候...`, 
        env.BOT_TOKEN, 
        { 
          reply_to_message_id: message.message_id,
          message_thread_id: message.message_thread_id
        }
      )

      // 执行群发
      const results = await broadcastMessage(userIds, postMessage, env)
      
      // 发送结果报告
      const reportText = `📊 *群发完成报告*\n\n✅ 成功: ${results.success}\n❌ 失败: ${results.failed}\n\n${results.errors.length > 0 ? `🔍 *错误详情:*\n${results.errors.slice(0, CONSTANTS.MAX_ERROR_DISPLAY).join('\n')}${results.errors.length > CONSTANTS.MAX_ERROR_DISPLAY ? `\n... 还有 ${results.errors.length - CONSTANTS.MAX_ERROR_DISPLAY} 个错误` : ''}` : '🎉 全部发送成功！'}`
      
      await sendMessage(env.ADMIN_CHAT_ID, reportText, env.BOT_TOKEN, { 
        message_thread_id: message.message_thread_id 
      })
      return
    }

    if (message.text === '/users') {
      if (env.ENABLE_USER_TRACKING !== 'true') {
        await sendMessage(env.ADMIN_CHAT_ID, 
          `❌ 用户跟踪功能未启用\n\n请设置环境变量 \`ENABLE_USER_TRACKING=true\` 并绑定KV存储`, 
          env.BOT_TOKEN, 
          { message_thread_id: message.message_thread_id }
        )
        return
      }

      const users = await getUsersFromKV(env)
      if (users.length === 0) {
        await sendMessage(env.ADMIN_CHAT_ID, 
          `📭 暂无用户记录\n\n用户首次发送消息后会自动记录`, 
          env.BOT_TOKEN, 
          { message_thread_id: message.message_thread_id }
        )
        return
      }

      // 排序（最近活跃优先）
      users.sort((a, b) => new Date(b.lastActive).getTime() - new Date(a.lastActive).getTime())
      const pageSize = CONSTANTS.USERS_DEFAULT_PAGE_SIZE || 20
      const { text, reply_markup } = buildUsersPage(users, 1, pageSize)
      await sendMessage(env.ADMIN_CHAT_ID, text, env.BOT_TOKEN, { 
        message_thread_id: message.message_thread_id,
        reply_markup
      })
      return
    }

    if (message.text && message.text.startsWith('/reset')) {
      const targetChatId = message.text.substring('/reset'.length).trim()

      if (!/^\d+$/.test(targetChatId)) {
        await sendMessage(env.ADMIN_CHAT_ID,
          `🔓 *重置用户人机验证*\n\n🎯 *用法:*\n\`/reset 用户ID\`\n\n💡 *示例:*\n\`/reset 123456789\`\n\n执行后会清除该用户的验证状态、失败次数与冷却锁定，用户下次发消息需重新完成验证。`,
          env.BOT_TOKEN,
          { message_thread_id: message.message_thread_id }
        )
        return
      }

      await resetCaptchaState(targetChatId, env)
      await sendMessage(env.ADMIN_CHAT_ID,
        `✅ 已重置用户 \`${targetChatId}\` 的人机验证状态\n\n该用户下次发送消息时需要重新完成验证。`,
        env.BOT_TOKEN,
        { message_thread_id: message.message_thread_id }
      )
      return
    }

    // 处理回复消息（支持群发媒体）
    if (message.reply_to_message) {
      const repliedMessage = message.reply_to_message
      
      // 检查是否是群发媒体命令（确保不是回复用户消息）
      const hasUserTag = repliedMessage.text?.includes('[USER:') || repliedMessage.caption?.includes('[USER:')
      if (message.text && message.text.startsWith('/post') && !hasUserTag) {
        const commandText = message.text.substring(5).trim()
        const { userIds, message: postMessage } = parsePostTargets(commandText)
        
        if (!postMessage) {
          await sendMessage(env.ADMIN_CHAT_ID, 
            `❌ 请提供要群发的消息内容`, 
            env.BOT_TOKEN, 
            { 
              reply_to_message_id: message.message_id,
              message_thread_id: message.message_thread_id
            }
          )
          return
        }

        // 群发媒体消息
        const targetCount = userIds === 'all' ? (await getUsersFromKV(env)).length : userIds.length
        await sendMessage(env.ADMIN_CHAT_ID, 
          `🚀 开始群发媒体消息...\n\n📊 目标用户数: ${targetCount}`, 
          env.BOT_TOKEN, 
          { 
            reply_to_message_id: message.message_id,
            message_thread_id: message.message_thread_id
          }
        )

        const results = await broadcastMessage(userIds, postMessage, env, true, { 
          messageId: repliedMessage.message_id 
        })
        
        const reportText = `📊 *媒体群发完成*\n\n✅ 成功: ${results.success}\n❌ 失败: ${results.failed}`
        await sendMessage(env.ADMIN_CHAT_ID, reportText, env.BOT_TOKEN, { 
          message_thread_id: message.message_thread_id 
        })
        return
      }
      
      // 普通回复处理
      let userChatId = await extractUserChatId(repliedMessage.text || repliedMessage.caption, env.USER_ID_SECRET)

      // 如果在论坛模式下且没有找到用户标识，尝试从话题ID查找
      if (!userChatId && env.ENABLE_FORUM_MODE === 'true' && message.message_thread_id) {
        userChatId = await getUserIdFromTopicId(message.message_thread_id, env)
        console.log(`从话题ID ${message.message_thread_id} 找到用户: ${userChatId}`)
      }

      if (!userChatId) {
        const helpText = env.ENABLE_FORUM_MODE === 'true' 
          ? `⚠️ 无法识别用户信息。请确保:\n• 回复带有用户标识的转发消息\n• 或在对应用户的话题中直接回复`
          : `⚠️ 无法识别用户信息。请回复带有用户标识的转发消息。`
        
        await sendMessage(env.ADMIN_CHAT_ID, helpText, env.BOT_TOKEN, { 
          reply_to_message_id: message.message_id,
          message_thread_id: message.message_thread_id
        })
        return
      }

      // 发送回复给用户
      let replyResult
      if (message.text) {
        // 转义管理员消息中的特殊字符以避免 Markdown 解析错误
        const escapedText = escapeMarkdown(message.text);
        replyResult = await sendMessage(userChatId, `💬 *管理员回复:*\n\n${escapedText}`, env.BOT_TOKEN)
      } else {
        // 使用改进的媒体消息发送函数
        replyResult = await sendMediaReplyToUser(userChatId, env.ADMIN_CHAT_ID, message.message_id, message.caption, env.BOT_TOKEN)
      }

      if (replyResult.ok) {
        await sendMessage(env.ADMIN_CHAT_ID, 
          `✅ 回复已发送给用户 (ID: ${userChatId})`, 
          env.BOT_TOKEN, 
          { 
            reply_to_message_id: message.message_id,
            message_thread_id: message.message_thread_id
          }
        )
        console.log(`回复发送成功: 管理员 -> 用户 ${userChatId}`)
      } else {
        await sendMessage(env.ADMIN_CHAT_ID, 
          `❌ 回复发送失败: ${replyResult.description || '未知错误'}`, 
          env.BOT_TOKEN, 
          { 
            reply_to_message_id: message.message_id,
            message_thread_id: message.message_thread_id
          }
        )
      }
    } else if (env.ENABLE_FORUM_MODE === 'true' && message.message_thread_id) {
      // 检查是否是系统消息（如创建话题、编辑话题等）
      const isSystemMessage = message.forum_topic_created || 
                             message.forum_topic_edited || 
                             message.forum_topic_closed || 
                             message.forum_topic_reopened ||
                             !message.text && !message.photo && !message.document && !message.video && !message.audio && !message.voice && !message.sticker
      
      if (isSystemMessage) {
        console.log(`忽略系统消息: 话题 ${message.message_thread_id}`)
        return
      }
      
      // 处理论坛话题中的直接消息（非回复）
      const userChatId = await getUserIdFromTopicId(message.message_thread_id, env)
      
      if (userChatId) {
        // 发送消息给用户
        let replyResult
        if (message.text) {
          // 转义管理员消息中的特殊字符以避免 Markdown 解析错误
          const escapedText = escapeMarkdown(message.text);
          replyResult = await sendMessage(userChatId, `💬 *管理员回复:*\n\n${escapedText}`, env.BOT_TOKEN)
        } else {
          // 使用改进的媒体消息发送函数
          replyResult = await sendMediaReplyToUser(userChatId, env.ADMIN_CHAT_ID, message.message_id, message.caption, env.BOT_TOKEN)
        }

        if (replyResult.ok) {
          await sendMessage(env.ADMIN_CHAT_ID, 
            `✅ 消息已发送给用户 (ID: ${userChatId})`, 
            env.BOT_TOKEN, 
            { 
              reply_to_message_id: message.message_id,
              message_thread_id: message.message_thread_id
            }
          )
          console.log(`消息发送成功: 管理员 -> 用户 ${userChatId}`)
        } else {
          await sendMessage(env.ADMIN_CHAT_ID, 
            `❌ 消息发送失败: ${replyResult.description || '未知错误'}`, 
            env.BOT_TOKEN, 
            { 
              reply_to_message_id: message.message_id,
              message_thread_id: message.message_thread_id
            }
          )
        }
      } else {
        // 只有在真正无法识别用户且不是系统消息时才显示警告
        await sendMessage(env.ADMIN_CHAT_ID, 
          `⚠️ 无法识别此话题对应的用户。请确保话题是由用户消息自动创建的。`, 
          env.BOT_TOKEN, 
          { 
            reply_to_message_id: message.message_id,
            message_thread_id: message.message_thread_id
          }
        )
      }
    } else {
      // 普通消息（非回复）
      await sendMessage(env.ADMIN_CHAT_ID, 
        `💡 *提示:* 请回复具体的用户消息来发送回复，或使用群发命令。\n\n📢 群发: \`/post all 消息内容\`\n❓ 帮助: \`/help\``, 
        env.BOT_TOKEN, 
        { 
          reply_to_message_id: message.message_id,
          message_thread_id: message.message_thread_id
        }
      )
    }
  } catch (error) {
    console.error('处理管理员消息错误:', error)
    try {
      const escapedErrorMessage = escapeMarkdown(error.message);
      await sendMessage(env.ADMIN_CHAT_ID, `❌ 处理消息时发生错误: ${escapedErrorMessage}`, env.BOT_TOKEN, { 
        message_thread_id: message.message_thread_id 
      })
    } catch (sendError) {
      console.error('发送错误消息失败:', sendError)
    }
  }
}

// 群组/频道内的非管理员消息：人机验证无法在群内完成，因此不转发，仅引导私聊
async function handleGroupChatMessage(message, env) {
  const text = (message.text || '').trim()

  if (text === '/start' || text.startsWith('/start ') || text === '/verify' || text === '/help') {
    try {
      await sendMessage(
        message.chat.id,
        '👤 请私聊机器人发送消息。\n\n人机验证需要在私聊中完成，群组内的消息不会被转发给管理员。',
        env.BOT_TOKEN,
        {
          reply_to_message_id: message.message_id,
          message_thread_id: message.message_thread_id
        }
      )
    } catch (error) {
      logError('handleGroupChatMessage', error, { chatId: message.chat.id })
    }
  }

  logInfo('handleGroupChatMessage', 'Ignored message from non-private chat', {
    chatId: message.chat.id,
    chatType: message.chat.type
  })
}

// 处理消息
async function handleMessage(message, env) {
  // 输入验证
  if (!message || !message.from || !message.chat) {
    console.error('无效的消息格式')
    return
  }

  const chatId = message.chat.id
  const userId = message.from.id
  const userName = message.from.username || message.from.first_name || 'Unknown'
  const isAdmin = chatId.toString() === env.ADMIN_CHAT_ID.toString()
  const chatType = message.chat.type
  const isPrivateChat = chatType === 'private' || (!chatType && chatId > 0)

  console.log(`收到消息: 来自 ${userName} (${userId}) 在聊天 ${chatId}`)

  if (isAdmin) {
    await handleAdminMessage(message, env)
  } else if (!isPrivateChat && isCaptchaEnabled(env)) {
    // 群组/频道内无法完成人机验证，因此不转发，仅引导用户私聊机器人
    await handleGroupChatMessage(message, env)
  } else {
    await handleUserMessage(message, env)
  }
}

// 处理 /users 的分页回调
async function handleUsersCallbackQuery(callbackQuery, env) {
  try {
    const message = callbackQuery.message;
    const fromChatId = message?.chat?.id;
    const messageId = message?.message_id;
    if (!fromChatId || !messageId) {
      await answerCallbackQuery(callbackQuery.id, env.BOT_TOKEN, '无法定位消息');
      return;
    }

    const { page, pageSize } = parseUsersCallbackData(callbackQuery.data);
    const users = await getUsersFromKV(env);
    users.sort((a, b) => new Date(b.lastActive).getTime() - new Date(a.lastActive).getTime());
    const { text, reply_markup } = buildUsersPage(users, page, pageSize);

    await editMessageText(fromChatId, messageId, text, env.BOT_TOKEN, { reply_markup });
    await answerCallbackQuery(callbackQuery.id, env.BOT_TOKEN);
  } catch (error) {
    logError('handleUsersCallbackQuery', error);
    await answerCallbackQuery(callbackQuery.id, env.BOT_TOKEN, '更新失败', true);
  }
}

// 处理Webhook消息
async function handleWebhook(request, env, ctx) {
  try {
    // 验证Webhook密钥（如果设置了）
    if (env.WEBHOOK_SECRET) {
      const secretToken = request.headers.get('X-Telegram-Bot-Api-Secret-Token')
      if (secretToken !== env.WEBHOOK_SECRET) {
        return new Response('Unauthorized', { status: 401 })
      }
    }

    const update = await request.json()
    
    if (update.message) {
      // 使用 ctx.waitUntil 进行后台消息处理，不阻塞响应
      ctx.waitUntil(handleMessage(update.message, env))
    } else if (update.callback_query) {
      // 内联按钮回调处理：人机验证 + /users 分页
      const cq = update.callback_query;
      const data = cq.data || '';
      if (data.startsWith(`${CAPTCHA_CALLBACK_PREFIX}:`)) {
        ctx.waitUntil(handleCaptchaCallbackQuery(cq, env));
      } else if (data.startsWith('users:')) {
        ctx.waitUntil(handleUsersCallbackQuery(cq, env));
      }
    }

    return new Response('OK', { status: 200 })
  } catch (error) {
    console.error('Webhook处理错误:', error)
    
    // 使用 ctx.waitUntil 进行后台错误记录
    ctx.waitUntil(
      (async () => {
        try {
          const escapedErrorMessage = escapeMarkdown(error.message);
          await sendMessage(env.ADMIN_CHAT_ID, `🚨 Bot错误: ${escapedErrorMessage}`, env.BOT_TOKEN);
        } catch (err) {
          console.error('发送错误通知失败:', err);
        }
      })()
    )
    
    return new Response('Internal Server Error', { status: 500 })
  }
}

// 处理HTTP请求
async function handleRequest(request, env, ctx) {
  try {
    // 环境变量验证
    validateEnvironment(env);
  } catch (error) {
    logError('handleRequest', error);
    return new Response(`Configuration error: ${error.message}`, { status: 500 });
  }

  const url = new URL(request.url)

  try {
    // 路由处理
    switch (true) {
      case request.method === 'POST' && url.pathname === '/webhook':
        return await handleWebhook(request, env, ctx)
        
      case request.method === 'GET' && url.pathname === '/setWebhook':
        const webhookUrl = `${url.origin}/webhook`
        const result = await setWebhook(webhookUrl, env.BOT_TOKEN, env.WEBHOOK_SECRET || '')
        return new Response(JSON.stringify(result, null, 2), {
          headers: { 'Content-Type': 'application/json' }
        })
        
      case request.method === 'GET' && url.pathname === '/me':
        const botInfo = await getMe(env.BOT_TOKEN)
        return new Response(JSON.stringify(botInfo, null, 2), {
          headers: { 'Content-Type': 'application/json' }
        })
        
      case request.method === 'GET' && url.pathname === '/':
        return new Response('Telegram Bot is running!', { status: 200 })
        
      default:
        return new Response('Not Found', { status: 404 })
    }
  } catch (error) {
    console.error('请求处理错误:', error)
    
    // 后台错误记录
    ctx.waitUntil(
      (async () => {
        try {
          const escapedErrorMessage = escapeMarkdown(error.message);
          await sendMessage(env.ADMIN_CHAT_ID, `🚨 系统错误: ${escapedErrorMessage}`, env.BOT_TOKEN);
        } catch (err) {
          console.error('发送系统错误通知失败:', err);
        }
      })()
    )
    
    return new Response('Internal Server Error', { status: 500 })
  }
}

// 导出处理函数（Cloudflare Workers需要）
export default {
  async fetch(request, env, ctx) {
    return handleRequest(request, env, ctx)
  }
} 
