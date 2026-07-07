# ST-Elephant-Memory 🐘（分层记忆 / Hierarchical Memory）

> *An elephant never forgets.* 给酒馆角色一副大象的记性，花金鱼的 token。

> A SillyTavern extension that manages chat history in three tiers — recent
> messages verbatim, older scenes as LLM summaries, and distant originals in a
> vector store recalled only when semantically relevant. Cuts context tokens
> dramatically in long roleplay without the character going OOC or "forgetting".
> Uses SillyTavern's built-in vector backend (local transformers by default,
> zero config, fully offline).

在长对话 / 长 roleplay 中大幅节省上下文 token，同时不让角色"失忆"或 OOC。
模仿人类记忆的「**近清晰、中模糊、远待唤醒**」结构，分三层管理历史：

| 层 | 内容 | 机制 |
|---|---|---|
| 近期层 | 最近 N 轮对话 | 原文完整发送（记得清楚） |
| 中期层 | 较早的对话 | 压缩成剧情摘要，原文不再发送（记得大概） |
| 远期层 | 更早的摘要 | 遗忘衰减：融合成一段固定长度的"远期梗概"（越远越糊） |
| 远期层 | 被压缩的原文 | 存入向量库，仅当与当前话题语义相关时召回 1~K 段（想起才想起） |
| 事实账本 | 关系/承诺/秘密/设定 | 衰减时自动抽取沉淀，**永不遗忘**——细节可以糊，事实糊了就 OOC |

## 安装

**方式一（推荐）**：酒馆内安装。扩展面板（顶栏三个方块图标）→
**Install extension** → 粘贴本仓库地址：

```
https://github.com/taotao5972/ST-Elephant-Memory
```

**方式二**：手动。把本文件夹整个拷到
`SillyTavern/data/<你的用户名，默认 default-user>/extensions/` 下，重启酒馆
（文件夹叫什么名字都可以，插件会自动适配）。

> 要求 SillyTavern ≥ 1.12。向量召回用的是酒馆内置向量后端，
> 默认 `transformers` 本地 embedding 模型：零配置、免费、数据不出本机
> （首次触发会自动下载模型，第一次压缩会慢一点，属正常）。

## 工作原理

```
                        ┌──────────────────────────────────┐
 每次生成请求发出前      │  Prompt Interceptor（注入模块）    │
 ST 自动调用 ──────────▶│  1. 剔除已压缩的原文消息            │
                        │  2. 注入【摘要块】                  │
                        │  3. 用最后一条用户输入查向量库,      │
                        │     召回相关原文注入【记忆唤醒块】   │
                        └────────────────┬─────────────────┘
                                         ▼ 实际发送:
        【剧情摘要】+【召回原文(如有)】+【最近 N 轮原文】+【当前输入】

 ┌─────────────────┐  MESSAGE_RECEIVED  ┌───────────────────┐
 │ 监听器: 数未压缩  │ ─────────────────▶ │ 压缩: generateRaw  │
 │ 轮数,攒够2N触发  │                    │ 出摘要             │
 └─────────────────┘                    └─────┬─────────────┘
                                              ▼
      ┌───────────────────────────────────────────────────────┐
      │ 存储                                                   │
      │ · 摘要 → chatMetadata（跟聊天文件持久化）                │
      │ · 压缩标记 → message.extra（原文只标记，绝不删除！）      │
      │ · 原文块 embedding → /api/vector（按 chatId 隔离集合）   │
      │ · 全局设置 → extensionSettings                          │
      └───────────────────────────────────────────────────────┘
```

### 关键设计决策：原文只标记、不删除

被压缩的消息不会从聊天记录里删除，只在 `message.extra` 里打 `compressed`
标记，UI 里置灰 + 「已入摘要」角标。真正的"移除"发生在发送前的 Prompt
Interceptor 里（对发送数组的修改是一次性的，不碰聊天文件）。因此：
「清空记忆」可完全回滚，零破坏性；向量召回拿到的是货真价实的原文。

### 触发逻辑

设保留轮数为 N（默认 20，一轮 = 一条用户消息 + 回复）：未压缩轮数攒到
**2N** 时，把最老的 **N 轮**压成一段摘要，压完近期层正好剩 N 轮，之后每攒
N 轮再压一次。批次对齐轮边界，不会把一问一答拆开。

## 配置项

| 项 | 默认 | 说明 |
|---|---|---|
| 启用 | 开 | 总开关：关掉后不压缩也不注入 |
| N 保留轮数 | 20 | 近期层窗口；攒到 2N 触发压缩 |
| 摘要字数上限 | 200 | 写进摘要 prompt |
| 摘要 prompt 模板 | 见面板 | `{{messages}}`=原文，`{{words}}`=字数上限 |
| 遗忘衰减 | 开 | 摘要超阈值时归档最老的进梗概，同步更新事实账本 |
| 衰减阈值 / 批量 | 10 / 5 | 摘要超过 10 段时，归档最老 5 段 |
| 梗概字数上限 | 300 | 梗概是"一段"常驻文本，每次衰减融合刷新，不无限增长 |
| 向量召回 | 开 | 关掉则只有近期层+摘要层 |
| 召回段数 topK | 2 | 每次最多召回几段原文 |
| 相似度阈值 | 0.25 | 0~1，低于阈值不召回；本地模型建议 0.2~0.4 |
| Embedding 来源 | transformers | 也可填 openai / cohere / ollama 等（见酒馆向量后端支持列表） |
| Embedding 模型名 | 空 | transformers 留空；openai 等需填，如 `text-embedding-3-small` |

面板按钮：**立即压缩**（马上把 N 轮之外全部压掉）、**查看/编辑摘要**
（可手改保存）、**重建向量库**（把已压缩消息重新入库，升级插件后补录用）、
**清空记忆**（删摘要 + 解除标记 + 清向量库，完全恢复原状）。

## 验证它在干活

1. 把 N 临时调成 2，聊满 4 轮 → 最早 2 轮置灰、状态行出现「摘要 1 段」。
2. 浏览器 Console（建议 Chrome）贴入下面代码，直接看"即将发送的消息列表"：

```js
const c = structuredClone(SillyTavern.getContext().chat);
await hierarchicalMemoryInterceptor(c);
console.table(c.map(m => ({ name: m.name, mes: m.mes.slice(0, 50) })));
```

   合格标准：第一行是 `Memory` 摘要块；聊到与被压缩剧情相关的话题时，
   会多出一行【记忆唤醒】块；置灰原文不在表中。
3. 点 AI 消息上的提示词分解图标，看 Chat History 的 token 占比变小。

## 文件结构

```
├── manifest.json    # 元数据；注册 generate_interceptor 注入钩子
├── index.js         # 全部逻辑：设置/存储/压缩/向量/注入/UI（分节中文注释）
├── settings.html    # 设置面板模板（Handlebars）
├── style.css        # 置灰样式 + 面板样式
├── LICENSE          # MIT
└── README.md
```

## 路线图

- [x] v0.1 近期层 + 摘要层（MVP）
- [x] v0.2 远期层：向量召回（复用 ST 内置 /api/vector）
- [x] v0.3 遗忘衰减 + 事实账本；召回查询优化、分支聊天向量自动补录、生成避让、token 估算
- [ ] 群聊适配与测试
- [ ] 摘要生成支持指定独立的小模型（省钱）

## 已知边界

- 摘要与衰减用当前选中的 LLM（`generateRaw`）生成；API 未连接时失败并提示，不影响正常聊天。
- 向量层任何失败都只降级为"无召回"，绝不阻断生成；interceptor 内部报错会被吞掉并打日志。
- 衰减解析失败（模型没按标记输出）会整体放弃本次衰减，摘要原样保留，不丢数据。
- 手动 `/hide` 的消息（`is_system=true`）不参与计数和压缩，与 ST 原生行为一致。
- 换 embedding 来源/模型后，旧向量集合不通用，点一次「重建向量库」即可。
- **回溯剧情注意**：删掉最近的消息重写剧情后，摘要/账本里可能还记着被删掉的事件
  （"未来记忆"），用「查看/编辑记忆」手动删掉对应内容即可。
- 衰减只做一层（摘要→梗概），不递归——反复摘要自己的摘要会像复印复印件一样失真。

## License

MIT
