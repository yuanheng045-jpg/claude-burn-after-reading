# 阅后即焚 burn-after-reading（Claude Code 用）

[English](README.md)

Claude 看过的图片、PDF（愿意的话，还有特别长的工具输出），会从 Claude Code 的对话记录里拿掉，原处留一行说明。
之后续上这段对话时，就不会每次请求都再发一遍。

```
之前   {"type":"image","source":{"type":"base64","data":"iVBORw0KGgoAAAANSUhEUgAAB4AAAAQ4CAIAAA…  (1.2 MB)
之后   〔图 #7 已阅后即焚 · Read /home/me/shot.png · 2026-11-09 14:32 · 要再看就重新读这个文件〕
```

## 为什么要它

- **省 token。** Claude 看过的每张图，之后这段对话的每次请求都会再发一遍。每次 `--resume`、`--continue`
  续上都这样，按条续会话的应用更是每一轮都发。一张截图每次大约 1500 个输入 token。
- **隐私。** 截图、扫描件、文档会一直留在 `~/.claude/projects/…` 里，而且 Claude Code 旁边还另存了一份。
- **体积。** 几张截图就能让对话记录涨到几 MB，太大的记录续得慢，甚至续不上。

Claude Code 自己没有办法只拿掉对话里的某一张图（`/compact` 会把整段对话都压成摘要）。这个工具只做这一件事。

## 怎么做到的

1. **先告诉 Claude 编号。** 工具递回图片或 PDF 时，`PostToolUse` 钩子在旁边加一句：
   「这张图是 #7。这一轮之后它会从对话里拿掉，这里只留"图 #7"；之后还想记得图里是什么，就在回复里说一句。」
   Claude 用自己的话记下要紧的，只记一遍，不重复。
2. **对话一结束，图就拿掉。** `SessionEnd` 钩子改写对话记录：Claude 已经回应过的图和 PDF 都换成一行说明，
   写着编号、从哪来、什么时候。Claude Code 另存的那份也一起清空。Claude 还没回应的不动。
3. **下次续上就是干净的。** `claude --resume` / `--continue` 读进来的是说明，不是图。

## 安装

需要 Node.js 18.17 或更新的版本，并且在 `PATH` 里。

### 当成 Claude Code 插件装（推荐）

在 Claude Code 里输入：

```
/plugin marketplace add yuanheng045-jpg/claude-burn-after-reading
/plugin install burn-after-reading@burn-after-reading
```

两个钩子会一起装好，不用再设别的。

### 手动装

```bash
npm install -g github:yuanheng045-jpg/claude-burn-after-reading
```

再把钩子加进 `~/.claude/settings.json`（所有项目）或 `.claude/settings.json`（单个项目）：

```json
{
  "env": { "BURN_AFTER_READING_LANG": "zh" },
  "hooks": {
    "PostToolUse": [
      { "matcher": "Read|mcp__.*", "hooks": [{ "type": "command", "command": "burn-after-reading hook", "timeout": 10 }] }
    ],
    "SessionEnd": [
      { "hooks": [{ "type": "command", "command": "burn-after-reading hook", "timeout": 30 }] }
    ]
  }
}
```

不想给图编号，就去掉 `PostToolUse` 那段。

### 钩子的设置

写在同一个设置文件的 `"env"` 里：

| 变量 | 默认 | 说明 |
|---|---|---|
| `BURN_AFTER_READING_LANG` | `en` | 设成 `zh`，说明和提示就用中文 |
| `BURN_AFTER_READING_KEEP` | `0` | 最近看过的 *n* 张图 / PDF 先留着 |
| `BURN_AFTER_READING_TEXT_OVER` | 关 | 超过这么多字的文字类工具结果也截短（开头保留） |
| `BURN_AFTER_READING_LABELS` | 开 | 设成 `0` 就不给图编号 |
| `BURN_AFTER_READING_BACKUP` | 开 | 设成 `0` 就不留纯文字备份 |

## 命令行

也可以自己动手烧，比如装钩子之前的旧对话：

```bash
burn-after-reading --latest --dry-run       # 当前文件夹对应项目里最新的那段对话，先看看会烧掉什么
burn-after-reading --all                    # 这个项目的所有对话
burn-after-reading 0f0f0f0f-1111-4222-8333-444444444444
burn-after-reading ~/.claude/projects/-home-me-app/0f0f0f0f-….jsonl --keep 2 --text-over 20000
```

不安装也能用：`npx github:yuanheng045-jpg/claude-burn-after-reading --latest --dry-run`。

| 选项 | 说明 |
|---|---|
| `-n, --dry-run` | 只看会烧掉什么，不改文件 |
| `--keep <n>` | 最近看过的 *n* 张图 / PDF 先留着 |
| `--text-over <字数>` | 超过这么多字的文字类工具结果也截短 |
| `--lang <en\|zh>` | 说明用什么语言 |
| `--no-backup` | 不留纯文字备份 |
| `--force` | 对话在 Claude Code 里开着也照烧 |
| `--json` | 输出给程序读的报告 |
| `-q, --quiet` | 只在出问题时说话 |

退出码：`0` 完成或无事可做，`1` 出错，`2` 拒绝（对话开着，或烧的时候文件被改了）。

## 它保证什么

- **只烧 Claude 回应过的。** Claude 在图后面回过话，才算看过。Claude Code 自己写的 API 报错（过载、额度用完之类）不算回话。
- **不碰开着的对话。** 命令行会查 Claude Code 自己记的"正在运行的对话"，开着的就不烧。钩子在对话关掉的那一刻跑；
  如果同一段对话还在另一个窗口开着，就等那个窗口也关了再烧。（开着的对话在内存里，改了文件它也看不到。）
- **只拿掉数据本身。** 行数和顺序、每个 id 和链接、工具调用和结果的配对、你和 Claude 写的每一个字，都原样不动。
  每一行改完都先核对一遍，对不上的那一行原样留着，并在报告里写明。没改的行逐字节原样写回。
- **写入是安全的。** 先写临时文件，`fsync`，再原子替换，保留原来的文件权限。烧的过程中文件被改了，就什么都不写。
- **有备份，但不带图。** 每段对话保留最近三次烧之前的版本，放在 `~/.claude/burn-after-reading/backups/`，保存 30 天，
  里面的图和 PDF 数据都拿掉了：够你撤销失误，但不会留下你本来想删的东西。
- **跑几遍都一样。** 第二遍什么都不会改。
- **拿真的 Claude Code 测过。** 除了单元测试，测试还会驱动真的 Claude Code（测过 2.1.281 和 2.1.319），
  对接一个本地的假 API，不用账号也不联网：烧过的对话能正常续上，续上后的请求里是说明，没有图。CI 里也跑这一套。

## 做不到的

- **下次读进来才生效。** Claude Code 把开着的对话放在内存里，所以一段一直开着的长对话里，图会留到下次续上（或压缩）。
  按条执行 `claude -p --resume` 的应用，从下一条起就生效。
- **提示缓存会重建一次。** 改了前面的消息，下一次请求要从第一个烧掉的地方开始重建缓存。在对话结束时烧，
  一般是停了一阵之后，那时缓存通常已经过期了。
- **对话记录的格式没有官方文档**，而且每个版本都可能变。这个工具只改它认得的部分；
  如果在它不认得的记录里发现图片数据，它会提醒你，那时请来提个 issue。
- 跟着消息一起发来的图（SDK 应用的发法，测过）也会烧，只是没有编号，说明里写"用户发来的"。
  在交互式终端里直接粘贴的图，测试还没覆盖到。

## 给开发者

如果你的应用让 Claude Code 进程一直开着（stream-json 输入），先停进程、烧、再续上：

```js
import { burnFile } from 'claude-burn-after-reading'   // npm i github:yuanheng045-jpg/claude-burn-after-reading

const report = burnFile(transcriptPath, { keep: 0, lang: 'zh' })   // { burned, skipped, bytesBefore, bytesAfter, … }
```

`burnLines(lines, options)` 做同样的事，但不碰文件。

## 类似的工具

[cozempic](https://github.com/Ruya-AI/cozempic) 用很多种策略修剪 Claude Code 的上下文，图片是其中一种。
burn-after-reading 只做一件事：Claude 看过的，在安全的时候自动拿掉。

## 许可证

MIT
