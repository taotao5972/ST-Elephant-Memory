/**
 * Hierarchical Memory (分层记忆) — SillyTavern 扩展
 *
 * 核心思路：模仿人类记忆的「近清晰、中模糊、远待唤醒」结构。
 * MVP 只做前两层：
 *   - 近期层：最近 N 轮对话，原文完整发给模型
 *   - 中期层：更早的对话被压缩成剧情摘要，原文不再发送
 *
 * 实现机制（重要，读懂这段就读懂了整个插件）：
 *   1. 每收到一条 AI 回复(MESSAGE_RECEIVED)就数一遍"未压缩轮数"，
 *      攒够 2N 轮时，把最老的那批轮次丢给当前 LLM 压成摘要。
 *   2. 被压缩的消息【不删除】，只在 message.extra 里打一个 compressed 标记，
 *      原文永远留在聊天文件里（第二阶段做向量化还要用它）。
 *   3. 通过 manifest.json 里注册的 generate_interceptor，在每次生成请求
 *      发出前拿到"即将发送的消息数组"：把打了标记的消息从数组里剔除，
 *      再把所有摘要拼成一条消息插到最前面。
 *      注意：interceptor 里对数组本身的增删是一次性的，不影响真实聊天记录。
 *
 * 数据存储：
 *   - 全局设置（N、prompt 模板等）→ extensionSettings（跟随 ST 设置持久化）
 *   - 摘要本身 → chatMetadata（跟随每个聊天文件持久化）
 *   - 压缩标记 → 每条消息的 extra 字段（跟随聊天文件持久化）
 */

const MODULE_NAME = 'hierarchical_memory';
// 扩展安装后的挂载路径。文件夹名从当前脚本 URL 自动推导：
// 通过仓库 URL 安装时文件夹名 = 仓库名，手动安装时 = 你拷贝的文件夹名，都能对上
const FOLDER_NAME = new URL('.', import.meta.url).pathname.split('/').filter(Boolean).pop();
const TEMPLATE_PATH = `third-party/${FOLDER_NAME}`;

// 防止同一时间跑两次压缩
let compressing = false;

/** 取 SillyTavern 上下文。官方推荐每次现取，不要缓存（切聊天后引用会变） */
function ctx() {
    return SillyTavern.getContext();
}

/* ========================================================================
 * 1. 设置（全局，所有聊天共用）
 * ====================================================================== */

const defaultSettings = Object.freeze({
    enabled: true,
    // N：近期层保留的轮数。未压缩轮数攒到 2N 时触发压缩，压掉最老的 N 轮
    roundsN: 20,
    // 单段摘要的目标字数上限（写进摘要 prompt 里）
    maxWords: 200,
    // ---- 远期层（向量召回）----
    // 开关：把被压缩的原文向量化存库；每次生成前按当前输入做语义检索，召回相关原文
    vectorEnabled: true,
    // 每次最多召回几段原文
    vectorTopK: 2,
    // 相似度阈值(0~1)，低于它的结果丢弃。本地 transformers 模型建议 0.2~0.4
    vectorThreshold: 0.25,
    // embedding 来源。'transformers' = 酒馆内置本地模型，零配置；也可填 openai/cohere/ollama 等
    vectorSource: 'transformers',
    // 部分来源需要指定 embedding 模型名（如 openai 的 text-embedding-3-small）；transformers 留空
    vectorModel: '',
    // 摘要 prompt 模板。{{messages}} 会被替换成待压缩的对话原文，{{words}} 替换成字数上限
    promptTemplate: [
        '你是一个剧情记忆压缩器。请把下面这段角色扮演对话压缩成一段剧情摘要，字数不超过{{words}}字。',
        '要求：',
        '- 保留：关键事件、人物关系的变化、重要的承诺或约定、有标志性的台词（可直接引用）',
        '- 丢弃：寒暄、重复的动作神态描写、与主线无关的闲聊',
        '- 用第三人称、过去时叙述，客观、精炼、按时间顺序',
        '',
        '对话原文：',
        '{{messages}}',
        '',
        '只输出摘要正文，不要任何解释、标题或前后缀。',
    ].join('\n'),
});

/** 读取设置，缺省项自动补全（升级插件后新增的配置项也能拿到默认值） */
function getSettings() {
    const { extensionSettings } = ctx();
    if (!extensionSettings[MODULE_NAME]) {
        extensionSettings[MODULE_NAME] = structuredClone(defaultSettings);
    }
    for (const key of Object.keys(defaultSettings)) {
        if (!Object.hasOwn(extensionSettings[MODULE_NAME], key)) {
            extensionSettings[MODULE_NAME][key] = defaultSettings[key];
        }
    }
    return extensionSettings[MODULE_NAME];
}

/* ========================================================================
 * 2. 每个聊天自己的记忆状态（存 chatMetadata，跟聊天文件走）
 * ====================================================================== */

/**
 * @returns {{ summaries: Array<{text: string, rounds: number, messageCount: number, createdAt: number}> }}
 */
function getMemoryState() {
    const { chatMetadata } = ctx();
    if (!chatMetadata[MODULE_NAME] || !Array.isArray(chatMetadata[MODULE_NAME].summaries)) {
        chatMetadata[MODULE_NAME] = { summaries: [] };
    }
    return chatMetadata[MODULE_NAME];
}

/* ========================================================================
 * 3. 消息判定小工具
 * ====================================================================== */

/** 这条消息是否已被压缩过（打过标记） */
function isCompressed(message) {
    return Boolean(message?.extra?.[MODULE_NAME]?.compressed);
}

/** 给消息打上"已压缩"标记（持久化在聊天文件里） */
function markCompressed(message) {
    if (!message.extra) message.extra = {};
    message.extra[MODULE_NAME] = { compressed: true };
}

/** 这条消息是否参与计数/压缩：跳过系统消息(/hide 隐藏的)和已压缩的 */
function isCountable(message) {
    return message && !message.is_system && !isCompressed(message);
}

/** 数一数还没被压缩的"轮数"。一轮 = 一条用户消息（及其后的回复） */
function countUncompressedRounds(chat) {
    return chat.filter((m) => isCountable(m) && m.is_user).length;
}

/* ========================================================================
 * 4. 压缩模块：挑出最老的一批轮次 → 丢给 LLM → 存摘要 → 打标记
 * ====================================================================== */

/**
 * 从聊天开头挑出最老的 roundsToCompress 轮未压缩消息。
 * 会对齐到"轮边界"：批次结束后，下一条未压缩消息一定是用户消息，
 * 避免把一问一答拆到两个批次里。
 * @returns {object[]} 被选中的消息对象数组（引用，不是拷贝）
 */
function pickOldestRounds(chat, roundsToCompress) {
    const batch = [];
    let userSeen = 0;
    for (const message of chat) {
        if (!isCountable(message)) continue;
        if (message.is_user) {
            // 已凑够轮数，且到了下一轮的开头 → 收工
            if (userSeen >= roundsToCompress) break;
            userSeen++;
        }
        batch.push(message);
    }
    return batch;
}

/** 把一批消息拼成给 LLM 看的对话原文 */
function batchToTranscript(batch) {
    return batch.map((m) => `${m.name}: ${m.mes}`).join('\n\n');
}

/**
 * 压缩主流程。
 * @param {number} roundsToCompress 要压掉的轮数
 * @param {boolean} silent 自动触发时为 true（只在失败时打扰用户）
 */
async function compressOldestRounds(roundsToCompress, silent = true) {
    if (compressing) return;
    compressing = true;
    try {
        const settings = getSettings();
        const { chat, generateRaw, saveMetadata } = ctx();

        const batch = pickOldestRounds(chat, roundsToCompress);
        if (batch.length === 0) return;

        // 1) 组装摘要 prompt
        // 用函数形式的 replace，避免对话原文里出现 $& 之类字符被 replace 误解析
        const transcript = batchToTranscript(batch);
        const prompt = settings.promptTemplate
            .replace('{{messages}}', () => transcript)
            .replace('{{words}}', () => String(settings.maxWords));

        if (!silent) toastr.info(`正在压缩最早的 ${roundsToCompress} 轮对话…`, '分层记忆');
        console.log(`[${MODULE_NAME}] compressing ${batch.length} messages (${roundsToCompress} rounds)`);

        // 2) 用当前选中的 LLM 后台生成摘要（generateRaw 不携带聊天上下文，完全由我们控制 prompt）
        const summary = (await generateRaw({ prompt }))?.trim();
        if (!summary) throw new Error('模型返回了空摘要');

        // 3) 摘要入库（chatMetadata，跟聊天文件持久化）
        const state = getMemoryState();
        state.summaries.push({
            text: summary,
            rounds: roundsToCompress,
            messageCount: batch.length,
            createdAt: Date.now(),
        });
        await saveMetadata();

        // 4) 给原文打"已压缩"标记并保存聊天文件。
        //    原文不删除：UI 里仍可见（置灰），向量召回也要用它
        batch.forEach(markCompressed);
        await ctx().saveChat?.();

        // 5) 远期层：被压缩的原文入向量库（失败只降级，不影响压缩结果）
        await vectorizeMessages(batch);

        refreshCompressedStyling();
        updateStatusLine();
        if (!silent) toastr.success(`已压缩 ${batch.length} 条消息为 1 段摘要`, '分层记忆');
        console.log(`[${MODULE_NAME}] done. summary: ${summary.slice(0, 80)}…`);
    } catch (error) {
        console.error(`[${MODULE_NAME}] compression failed:`, error);
        toastr.error(`摘要生成失败：${error.message ?? error}`, '分层记忆');
    } finally {
        compressing = false;
    }
}

/**
 * 监听器入口：每当 AI 回复入库(MESSAGE_RECEIVED)就检查是否该压缩。
 * 触发条件：未压缩轮数 ≥ 2N。压掉最老的 (未压缩轮数 - N) 轮，
 * 压完后近期层正好剩 N 轮原文。
 */
async function maybeAutoCompress() {
    const settings = getSettings();
    if (!settings.enabled || compressing) return;

    const { chat } = ctx();
    const rounds = countUncompressedRounds(chat);
    const N = Math.max(1, Number(settings.roundsN) || 20);

    updateStatusLine();
    if (rounds >= N * 2) {
        await compressOldestRounds(rounds - N, true);
    }
}

/* ========================================================================
 * 4.5 远期层：向量记忆（复用 SillyTavern 服务端内置向量库 /api/vector/*）
 *
 * 原理：压缩发生时，把被压缩的每条原文作为一个块，交给酒馆服务端做
 * embedding 并存入本聊天专属的向量集合（默认用本地 transformers 模型，
 * 零配置、数据不出本机）。每次生成前，用"最后一条用户消息"做语义检索，
 * 召回最相关的 1~K 段原文，插到摘要块之后——"想起才想起"。
 *
 * 向量层的任何失败都只降级（少了召回而已），绝不影响压缩和正常聊天。
 * ====================================================================== */

/** 简单字符串哈希（用于给向量条目生成稳定 ID，与 ST 内置扩展做法一致） */
function getStringHash(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        hash = ((hash << 5) - hash) + str.charCodeAt(i);
        hash |= 0; // 收敛到 32 位整数
    }
    return hash;
}

/** 本聊天专属的向量集合 ID（跟 chatId 走，换聊天不串库） */
function getCollectionId() {
    return `hm_${Math.abs(getStringHash(String(ctx().chatId)))}`;
}

/** 组装 /api/vector 请求体的公共字段（来源 + 可选模型名） */
function vectorBody(extra = {}) {
    const settings = getSettings();
    const body = { source: settings.vectorSource || 'transformers', ...extra };
    if (settings.vectorModel) body.model = settings.vectorModel;
    return body;
}

/** 调用酒馆服务端向量接口。getRequestHeaders() 会带上 CSRF token */
async function vectorApi(endpoint, body) {
    const response = await fetch(`/api/vector/${endpoint}`, {
        method: 'POST',
        headers: ctx().getRequestHeaders(),
        body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`/api/vector/${endpoint} → HTTP ${response.status}`);
    const contentType = response.headers.get('content-type') ?? '';
    return contentType.includes('application/json') ? response.json() : null;
}

/** 把一条消息变成向量库里的文本块 */
function messageToChunk(message) {
    return `${message.name}: ${message.mes}`;
}

/**
 * 把一批（刚被压缩的）消息写入向量库。
 * 先取已有 hash 列表做去重，避免重复入库。
 */
async function vectorizeMessages(batch) {
    const settings = getSettings();
    if (!settings.vectorEnabled) return;
    try {
        const collectionId = getCollectionId();
        const existing = new Set((await vectorApi('list', vectorBody({ collectionId }))) ?? []);
        const items = batch
            .map(messageToChunk)
            .filter((text) => text.trim().length >= 10) // 太短的块没有检索价值
            .map((text, index) => ({ hash: getStringHash(text), text, index }))
            .filter((item) => !existing.has(item.hash));
        if (items.length === 0) return;
        await vectorApi('insert', vectorBody({ collectionId, items }));
        console.log(`[${MODULE_NAME}] vectorized ${items.length} chunks → ${collectionId}`);
    } catch (error) {
        // 向量化失败不阻断压缩流程（首次使用 transformers 时服务端要先下载模型，可能较慢）
        console.error(`[${MODULE_NAME}] vectorize failed (recall degraded):`, error);
        toastr.warning('向量化失败，本批原文暂不可召回（详见 Console）', '分层记忆');
    }
}

/**
 * 按查询文本召回最相关的原文块。
 * @returns {Promise<string[]>} 召回的原文块（可能为空数组）
 */
async function recallRelatedChunks(queryText) {
    const settings = getSettings();
    if (!settings.vectorEnabled || !queryText?.trim()) return [];
    try {
        const result = await vectorApi('query', vectorBody({
            collectionId: getCollectionId(),
            searchText: queryText,
            topK: Math.max(1, Number(settings.vectorTopK) || 2),
            threshold: Math.min(1, Math.max(0, Number(settings.vectorThreshold) || 0.25)),
        }));
        // 服务端返回 { metadata: [{hash, text, index}], hashes }，metadata 已按阈值过滤
        return (result?.metadata ?? []).map((m) => String(m.text));
    } catch (error) {
        console.error(`[${MODULE_NAME}] recall failed (skipped):`, error);
        return [];
    }
}

/** 重建当前聊天的向量库：清空集合，把所有已压缩消息重新入库（升级插件后补录用） */
async function rebuildVectorIndex() {
    const { chat } = ctx();
    const compressed = chat.filter(isCompressed);
    if (compressed.length === 0) {
        toastr.info('本聊天还没有已压缩的消息，无需重建', '分层记忆');
        return;
    }
    try {
        await vectorApi('purge', { collectionId: getCollectionId() });
        await vectorizeMessages(compressed);
        toastr.success(`已重建向量库：${compressed.length} 条已压缩消息入库`, '分层记忆');
    } catch (error) {
        console.error(`[${MODULE_NAME}] rebuild failed:`, error);
        toastr.error(`重建失败：${error.message ?? error}`, '分层记忆');
    }
}

/* ========================================================================
 * 5. 注入模块：Prompt Interceptor（在 manifest.json 里注册的全局函数）
 *
 * 每次生成请求发出前被 ST 调用。参数 chat 是"即将用于组 prompt 的消息数组"：
 *   - 对数组本身 splice/unshift 只影响本次请求，不改真实聊天记录
 *   - 但数组里的消息对象是共享引用，改对象属性会写进真实记录（我们不改）
 * 最终发出的上下文 =
 *   【所有摘要】+【向量召回的原文片段(如有)】+【未压缩的近期原文】+【当前输入】
 * ====================================================================== */
globalThis.hierarchicalMemoryInterceptor = async function (chat, _contextSize, _abort, type) {
    try {
        const settings = getSettings();
        if (!settings.enabled) return;

        // 0) 先记下"最后一条用户消息"，作为向量召回的查询文本（要在剔除前取）
        const lastUserMessage = [...chat].reverse().find((m) => m.is_user && !m.is_system);

        // 1) 把已压缩的原文从"待发送数组"里剔除（倒序遍历避免 splice 移位）
        for (let i = chat.length - 1; i >= 0; i--) {
            if (isCompressed(chat[i])) chat.splice(i, 1);
        }

        const state = getMemoryState();
        const injected = [];

        // 2) 中期层：把所有摘要拼成一条"记忆消息"
        if (state.summaries.length > 0) {
            const block =
                '【剧情记忆摘要 · 由旧到新】以下是本次对话更早剧情的压缩记忆，请视为已发生的事实并保持一致：\n'
                + state.summaries.map((s, i) => `${i + 1}. ${s.text}`).join('\n');
            injected.push({
                name: 'Memory',
                is_user: false,
                is_system: false, // is_system=true 会被组 prompt 时排除，所以必须是 false
                send_date: Date.now(),
                mes: block,
                extra: { [MODULE_NAME]: { injected: true } },
            });
        }

        // 3) 远期层：按当前输入语义检索，召回相关的过往原文（想起才想起）
        //    只有存在摘要（= 有东西被压缩过）时才值得查
        if (state.summaries.length > 0 && lastUserMessage) {
            const chunks = await recallRelatedChunks(lastUserMessage.mes);
            if (chunks.length > 0) {
                const recallBlock =
                    '【记忆唤醒】以下是与当前话题语义相关的过往对话原文片段（补充细节用，以剧情摘要为准）：\n'
                    + chunks.map((text) => `· ${text}`).join('\n');
                injected.push({
                    name: 'Memory',
                    is_user: false,
                    is_system: false,
                    send_date: Date.now(),
                    mes: recallBlock,
                    extra: { [MODULE_NAME]: { injected: true } },
                });
                console.debug(`[${MODULE_NAME}] recalled ${chunks.length} chunks`);
            }
        }

        // 4) 一起插到最前面：摘要在先，召回原文随后
        if (injected.length > 0) chat.splice(0, 0, ...injected);
        console.debug(`[${MODULE_NAME}] interceptor(${type ?? 'n/a'}): summaries=${state.summaries.length}, injected=${injected.length}`);
    } catch (error) {
        // interceptor 出错绝不能拦住正常生成
        console.error(`[${MODULE_NAME}] interceptor error:`, error);
    }
};

/* ========================================================================
 * 6. UI：已压缩消息置灰 + 设置面板
 * ====================================================================== */

/** 给聊天窗口里已压缩的消息加 CSS 类（半透明 + 角标），让用户一眼看出哪些已进入摘要层 */
function refreshCompressedStyling() {
    const { chat } = ctx();
    $('#chat .mes').removeClass('hm-compressed');
    chat.forEach((message, index) => {
        if (isCompressed(message)) {
            $(`#chat .mes[mesid="${index}"]`).addClass('hm-compressed');
        }
    });
}

/** 更新设置面板里的状态行 */
function updateStatusLine() {
    const el = $('#hm_status');
    if (!el.length) return;
    try {
        const { chat } = ctx();
        const state = getMemoryState();
        const compressedCount = chat.filter(isCompressed).length;
        el.text(
            `摘要 ${state.summaries.length} 段 · 已压缩 ${compressedCount} 条消息 · `
            + `未压缩 ${countUncompressedRounds(chat)} 轮`,
        );
    } catch {
        el.text('（未加载聊天）');
    }
}

/** 「查看/编辑摘要」弹窗：一个大文本框，段与段之间用 --- 分隔，改完保存回 chatMetadata */
async function showSummaryEditor() {
    const { Popup, POPUP_TYPE, saveMetadata } = ctx();
    const state = getMemoryState();
    const SEP = '\n\n---\n\n';
    const initial = state.summaries.map((s) => s.text).join(SEP);

    let edited = initial;
    const html = document.createElement('div');
    html.innerHTML = `
        <h3>剧情记忆摘要（由旧到新，段落间用 --- 分隔）</h3>
        <textarea id="hm_edit_area" class="text_pole" rows="16" style="width:100%;"></textarea>`;
    html.querySelector('#hm_edit_area').value = initial;
    html.querySelector('#hm_edit_area').addEventListener('input', (e) => { edited = e.target.value; });

    const popup = new Popup(html, POPUP_TYPE.TEXT, '', { wide: true, okButton: '保存', cancelButton: '取消' });
    const result = await popup.show();

    if (result && edited !== initial) {
        const texts = edited.split(/\n\s*---\s*\n/).map((t) => t.trim()).filter(Boolean);
        // 尽量保留原条目的元信息；多出来/对不上的按新条目处理
        state.summaries = texts.map((text, i) => ({
            ...(state.summaries[i] ?? { rounds: 0, messageCount: 0, createdAt: Date.now() }),
            text,
        }));
        await saveMetadata();
        updateStatusLine();
        toastr.success('摘要已保存', '分层记忆');
    }
}

/** 清空当前聊天的所有摘要，并解除所有消息的压缩标记（完全回滚到原始状态） */
async function clearMemory() {
    const { Popup, chat, saveMetadata } = ctx();
    const ok = await Popup.show.confirm('分层记忆', '清空本聊天的所有摘要，并恢复全部原文进入上下文？');
    if (!ok) return;

    getMemoryState().summaries = [];
    chat.forEach((message) => {
        if (message.extra?.[MODULE_NAME]) delete message.extra[MODULE_NAME];
    });
    await saveMetadata();
    await ctx().saveChat?.();
    // 同步清掉本聊天的向量库（失败不要紧，集合是按 chatId 隔离的）
    try {
        await vectorApi('purge', { collectionId: getCollectionId() });
    } catch (error) {
        console.warn(`[${MODULE_NAME}] vector purge failed:`, error);
    }
    refreshCompressedStyling();
    updateStatusLine();
    toastr.success('已清空摘要并恢复原文', '分层记忆');
}

/** 手动触发：立即把"最近 N 轮"之外的所有内容压掉 */
async function compressNow() {
    const settings = getSettings();
    const rounds = countUncompressedRounds(ctx().chat);
    const N = Math.max(1, Number(settings.roundsN) || 20);
    if (rounds <= N) {
        toastr.info(`未压缩对话只有 ${rounds} 轮，不超过保留窗口 N=${N}，无需压缩`, '分层记忆');
        return;
    }
    await compressOldestRounds(rounds - N, false);
}

/** 加载设置面板 HTML 并绑定控件 */
async function initSettingsUi() {
    const { renderExtensionTemplateAsync, saveSettingsDebounced } = ctx();
    const settings = getSettings();

    const html = await renderExtensionTemplateAsync(TEMPLATE_PATH, 'settings');
    $('#extensions_settings2').append(html);

    // 初始值
    $('#hm_enabled').prop('checked', settings.enabled);
    $('#hm_rounds_n').val(settings.roundsN);
    $('#hm_max_words').val(settings.maxWords);
    $('#hm_prompt').val(settings.promptTemplate);

    // 双向绑定
    $('#hm_enabled').on('change', function () {
        getSettings().enabled = $(this).prop('checked');
        saveSettingsDebounced();
    });
    $('#hm_rounds_n').on('input', function () {
        getSettings().roundsN = Math.max(1, Number($(this).val()) || 20);
        saveSettingsDebounced();
        updateStatusLine();
    });
    $('#hm_max_words').on('input', function () {
        getSettings().maxWords = Math.max(20, Number($(this).val()) || 200);
        saveSettingsDebounced();
    });
    $('#hm_prompt').on('input', function () {
        getSettings().promptTemplate = String($(this).val());
        saveSettingsDebounced();
    });
    $('#hm_prompt_reset').on('click', function () {
        getSettings().promptTemplate = defaultSettings.promptTemplate;
        $('#hm_prompt').val(defaultSettings.promptTemplate);
        saveSettingsDebounced();
        toastr.info('已恢复默认摘要 prompt', '分层记忆');
    });

    // ---- 向量召回设置 ----
    $('#hm_vector_enabled').prop('checked', settings.vectorEnabled);
    $('#hm_vector_topk').val(settings.vectorTopK);
    $('#hm_vector_threshold').val(settings.vectorThreshold);
    $('#hm_vector_source').val(settings.vectorSource);
    $('#hm_vector_model').val(settings.vectorModel);

    $('#hm_vector_enabled').on('change', function () {
        getSettings().vectorEnabled = $(this).prop('checked');
        saveSettingsDebounced();
    });
    $('#hm_vector_topk').on('input', function () {
        getSettings().vectorTopK = Math.max(1, Number($(this).val()) || 2);
        saveSettingsDebounced();
    });
    $('#hm_vector_threshold').on('input', function () {
        getSettings().vectorThreshold = Math.min(1, Math.max(0, Number($(this).val()) || 0.25));
        saveSettingsDebounced();
    });
    $('#hm_vector_source').on('input', function () {
        getSettings().vectorSource = String($(this).val()).trim() || 'transformers';
        saveSettingsDebounced();
    });
    $('#hm_vector_model').on('input', function () {
        getSettings().vectorModel = String($(this).val()).trim();
        saveSettingsDebounced();
    });

    // 操作按钮
    $('#hm_compress_now').on('click', () => compressNow());
    $('#hm_view_summaries').on('click', () => showSummaryEditor());
    $('#hm_rebuild_vectors').on('click', () => rebuildVectorIndex());
    $('#hm_clear').on('click', () => clearMemory());

    updateStatusLine();
}

/* ========================================================================
 * 7. 入口：绑定事件
 * ====================================================================== */
jQuery(async () => {
    const { eventSource, event_types } = ctx();

    await initSettingsUi();

    // AI 回复入库后：检查是否攒够了、该压缩了（稍微延迟，避开渲染高峰）
    eventSource.on(event_types.MESSAGE_RECEIVED, () => {
        setTimeout(() => maybeAutoCompress(), 800);
    });

    // 切换聊天后：重新渲染置灰样式、刷新状态行
    eventSource.on(event_types.CHAT_CHANGED, () => {
        setTimeout(() => {
            refreshCompressedStyling();
            updateStatusLine();
        }, 300);
    });

    // 用户删除/编辑消息后刷新一下计数
    eventSource.on(event_types.MESSAGE_DELETED, () => updateStatusLine());
    eventSource.on(event_types.MESSAGE_EDITED, () => updateStatusLine());

    console.log(`[${MODULE_NAME}] loaded`);
});
