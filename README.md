# SakikoQQBot

基于 Node.js 的 QQ 私聊机器人，通过 NapCatQQ 收发消息，使用兼容 OpenAI 接口的语言模型生成回复。角色设定为《BanG Dream!》中的丰川祥子，支持角色扮演、中文和日语对话，以及本地管理后台。

## 功能

- **角色对话**：根据用户选择的角色调整回复方式，包含角色关系、敏感话题和冷静期设定。
- **聊天模式**：支持现实对话与网络聊天两种模式，网络聊天模式会分段发送回复。
- **语言切换**：支持中文和日语，默认直接将用户原文交给模型，也可启用逐条翻译。
- **主动搭话**：在运行机器本地时间 10:00–22:00 每天安排 1–2 次随机搭话；最近一小时有互动则跳过，上次主动消息未获回复则暂停随机搭话。不会因未回复定时催问。
- **本地管理后台**：查看连接状态、实时消息、聊天历史和冷静期，并向指定好友发起聊天。
- **对话任务管理**：同一用户的回复按顺序生成和发送，不同用户互不阻塞；重置、切换设置或撤回消息时会取消相关的未完成任务。

## 运行要求

- Node.js 22 或以上
- 已登录并开启正向 WebSocket 服务的 [NapCatQQ](https://github.com/NapNeko/NapCatQQ)
- 兼容 OpenAI 接口的语言模型 API，以及对应的 API Key 和模型名称

## 安装与配置

```bash
git clone https://github.com/Obliv1onis/sakiko-bot.git
cd sakiko-bot
npm install
```

复制环境变量模板：

```bash
# macOS / Linux
cp .env.example .env
```

```powershell
# Windows PowerShell
Copy-Item .env.example .env
```

Windows CMD 可使用 `copy .env.example .env`。

编辑 `.env`，填写以下配置：

| 环境变量 | 说明 |
| --- | --- |
| `NAPCAT_WS_URL` | NapCat 正向 WebSocket 地址，例如 `ws://127.0.0.1:3001` |
| `NAPCAT_ACCESS_TOKEN` | NapCat 配置的访问令牌，未设置时留空 |
| `OPENAI_API_KEY` | 模型服务的 API Key |
| `OPENAI_BASE_URL` | 模型服务的 API 地址，以服务商文档为准 |
| `OPENAI_MODEL` | 模型名称，以服务商文档为准 |
| `MASTER_QQ` | 管理员 QQ 号，用于管理员指令鉴权和主动搭话调度 |
| `TRANSLATE_USER_MESSAGES` | 设为 `1` 时启用逐条翻译，默认 `0`；启用后每轮会增加一次模型调用 |

`.env.example` 提供了 DeepSeek 的配置示例，也可以替换为其他兼容服务。API Key、API 地址和模型名称需要对应同一家服务的有效配置。

`.env` 已被 `.gitignore` 排除。请将密钥保存在 `.env` 中，不要写入代码或提交到公开仓库。

## 启动

先确认 NapCat 已登录 QQ，并且 WebSocket 地址、端口和访问令牌与 `.env` 一致，然后运行：

```bash
npm start
```

启动后，本地管理后台地址为 **http://127.0.0.1:3000**。后台仅监听本机地址；其中的 QQ Online / QQ Offline 表示与 NapCat 的连接状态。

## 聊天指令

在 QQ 私聊中发送以下指令：

| 指令 | 说明 |
| --- | --- |
| `!help` | 查看指令列表 |
| `!role <名字>` | 切换用户扮演的角色，支持 `soyo`、`anon`、`taki`、`tomori`、`rana`、`umiri`、`nyamu`、`uika`、`mutsumi` |
| `!restart` | 清空自己的对话历史，并停止尚未完成的回复 |
| `!online 0/1` | 切换现实对话模式（`0`）或网络聊天模式（`1`） |
| `!lang jp/cn` | 切换日语（`jp`）或中文（`cn`） |

以下指令仅限 `MASTER_QQ` 指定的管理员使用：

| 指令 | 说明 |
| --- | --- |
| `!rename <名字>` | 修改机器人 QQ 昵称 |
| `!q [QQ号]` | 向指定好友主动搭话；不填 QQ 号时向管理员本人搭话 |
| `!allowrestart 0/1` | 禁止（`0`）或允许（`1`）普通用户使用 `!restart`，默认允许 |

## 运行说明

- 聊天历史、角色设置和调度计划保存在内存中，重启进程后会重置。
- `!restart` 和角色切换会清空消息缓冲，并取消旧的生成与发送任务。语言和聊天模式切换会取消未完成任务，但保留已有历史。
- 撤回缓冲中或模型生成期间的消息，会移除对应内容并取消过时回复。
- 上下文按最近 15 轮和 24,000 字符预算裁剪，优先保留最新完整轮次；单个最新轮次超出预算时仍保留，以免丢失当前问题。这是字符预算，并非模型 token 上限。
- 敏感话题结合指向和语境判断，短确认句按上下文承接；告别兜底仅匹配完整告别语，避免数字或话题引用误触发。
- 模型请求超时为 60 秒，失败最多自动重试一次。回复在收到 NapCat 的发送确认后才写入历史。
- 普通聊天停顿不会触发“还在吗”；管理员手动搭话仍可主动发起，重置或切换角色会清除等待回应状态。
- 随机搭话按运行机器的本地时区调度，不补发错过的时间点；冷静期内不会主动搭话。
- 支持私聊戳一戳通知、常见 QQ 表情名称、表情包文字摘要、@提及、窗口抖动、骰子和猜拳；兼容结构化消息与 CQ 码。群内戳一戳和机器人自己发起的戳一戳不会触发私聊回复。
- 图片、语音、视频、文件、引用和合并转发会标注类型。当前没有视觉识别、语音转写或引用原文拉取；分享卡片只提取提供的标题和摘要。未知表情保留 ID，不猜测含义。直接输入的 `[戳一戳]`、`[狗头]` 等由模型结合上下文理解。
- 消息格式依据 [NapCat 消息文档](https://napneko.github.io/develop/msg) 和 [事件文档](https://napneko.github.io/develop/event)。

### 另外打开 QQ 客户端

如果需要在 NapCat 运行期间另外打开 QQ 客户端，可以尝试以下命令。实际是否可用取决于本机的 QQ 版本和安装方式。

```bash
# macOS
open -n /Applications/QQ.app
```

```bat
:: Windows CMD，路径按实际安装位置修改
start "" "C:\Program Files\Tencent\QQNT\QQ.exe"
```

## 更新

先停止机器人，再拉取更新并安装依赖：

```bash
git pull
npm install
npm start
```

如果修改过项目文件，请先保存或提交本地改动，并在更新时处理可能出现的合并冲突。

## 检查与测试

```bash
npm run check
npm test
npm audit --omit=dev
```

测试使用模拟的模型和 NapCat，不读取真实 `.env`，也不会发送 QQ 消息。

## 许可与说明

代码使用 [GPL-3.0-only](LICENSE) 许可证。

本项目基于《BanG Dream! It's MyGO!!!!!》与《Ave Mujica - The Die is Cast》的角色设定进行同人创作，仅供学习交流与个人娱乐使用，与官方及版权方无关联。相关角色与作品的权利归各自版权方所有。
