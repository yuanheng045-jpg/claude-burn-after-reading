# 阅后即焚 burn-after-reading

[English](README.md)

**Claude 看过的图片和 PDF，会在对话结束时自动从对话记录里拿掉，原处只留一行说明。**
给 [Claude Code](https://claude.com/claude-code) 用。

```
之前   一张截图（1.2 MB 的图片数据）
之后   〔图 #7 已阅后即焚 · Read /home/me/shot.png · 2026-11-09 14:32 · 要再看就重新读这个文件〕
```

## 它能帮你什么

**1. 省 token：用订阅省额度，用 API 省钱**
Claude Code 每发一条消息，都会把这段对话从头到尾再发一遍，包括里面所有的图。
一张截图大约占 1500 个 token，烧掉之后只剩一行说明，大约 30 个。
比如你回到一段看过 10 张截图的对话，接着又聊了 100 条，就少发了大约 150 万个 token。
（重复发送的部分大多走 Claude 的提示缓存，价钱大约只有十分之一，所以真正省下的钱或额度比这个数小；省下的空间，也就是第 2 条，不打折。）

**2. 对话能聊得更久**
图会占对话的空间。空间满了，Claude Code 就会把前面的内容压成摘要，细节就丢了。
图拿掉以后，空间更宽裕，压缩来得更晚。

**3. 隐私**
截图、证件照、扫描件这类东西，Claude Code 会在电脑里存好几份，而且一直留着：对话记录里一份，看过它的「子代理」（Claude 叫来帮忙的分身）的记录里一份，临时文件夹里还有一份。
它会把这些都删掉。你选了存档的，会作为普通文件（没有加密）放在 `~/.claude/burn-after-reading/archive/`，留 30 天；完全不想留的照片，把「跟着消息发来的图」设成销毁就行。

**4. 文件更小，续得更稳**
几张截图就能让对话记录涨到几 MB。文件小了，续上对话更快，也不容易因为太大而失败。

## 怎么装（两步）

**第 1 步：确认电脑上有 Node.js**

打开终端（Windows 叫「命令提示符」或「PowerShell」，Mac 叫「终端」），输入下面这行，再按回车：

```
node --version
```

- 出现 `v18` 或更大的数字（比如 `v22.11.0`）：没问题，去第 2 步。
- 提示找不到命令：去 [nodejs.org](https://nodejs.org) 下载左边那个 LTS 版本，像装普通软件一样装好，再回到这一步试一次。

**第 2 步：在 Claude Code 里输入两行**

打开 Claude Code，输入第一行，按回车；等它说成功了，再输入第二行，按回车：

```
/plugin marketplace add yuanheng045-jpg/claude-burn-after-reading
```
```
/plugin install burn-after-reading@burn-after-reading
```

装好了，不用再设置别的。从下一次对话结束开始，它就会自动工作。

**想确认它在工作？** 在 Claude Code 里输入 `/burn-after-reading:settings`，最下面「最近」那一栏会列出它烧过什么。

## 它具体做了什么

1. **工具给 Claude 拿来图或 PDF 的时候**（读文件、截图等），它会告诉 Claude：「这张图是 #7，这一轮之后会从对话里拿掉，只留编号；之后还想记得图里是什么，就在回复里说一句。」
   于是 Claude 会用自己的话记下图里要紧的东西，只记一遍。
   （你自己发的图不编号；它们默认存档，Claude 想再看随时能翻。）
2. **对话关掉的时候**，Claude 已经回应过的图和 PDF，按你的设置处理：烧掉、存档，或者不动。
   Claude 还没来得及回应的，一律不动。子代理看过的也一样处理。
3. **下次续上这段对话时**，Claude 读到的是那一行说明，不是图。

## 想改设置

在 Claude Code 里输入：

```
/burn-after-reading:settings
```

Claude 会弹出勾选框，四类东西各选一种处理方式，选完就保存好了，以后随时可以再改。

| 哪一类 | 默认 | 为什么这样默认 |
|---|---|---|
| 跟着消息一起发来的图（你粘贴、发给它的） | **存档** | 不存的话，Claude 就再也找不回来了 |
| 工具拿回来的图和 PDF（比如网页截图） | **销毁** | 想再看可以重新截 |
| 从文件读进来的图和 PDF | **销毁** | 原文件还在你电脑上，重新读就行 |
| 很长的文字结果（比如几万字的日志） | **不动** | Claude 可能还要用里面的细节 |

三种处理方式：
- **不动**：留在对话里。
- **存档**：从对话里拿掉，但另存一份，Claude 想再看时自己去读。超过 30 天的存档，会在它下次运行时自动删掉。
- **销毁**：从对话里拿掉，并且彻底删掉，连 Claude Code 自己另存的副本也一起删。

（它留的备份里从来没有图和 PDF。不过销毁的长文字会在纯文字备份里留 30 天；不想留的话，用 `backup=off` 关掉备份。）

## Claude 想再看一眼怎么办

那一行说明里写着东西是从哪来的：

- **存档过的**：说明里写着存档的位置，Claude 自己去读那个文件就行。
- **从文件读进来的**：原文件还在，重新读一次。
- **工具截的图**：重新截一次（看到的是现在的样子）。
- **销毁的、你发来的图**：只能请你再发一次。

另外，Claude 看图时在回复里写下的那句话一直都在，大多数时候看那句就够了。

## 常见问题

**会不会弄坏我的对话？**
不会。它只把图片数据换成一行字，别的一个字都不改；每一处改动都先核对，对不上就不改。它还会把改之前的文件（去掉图和 PDF）留 30 天，万一要把文字找回来，可以手动拿回来。
这些都在真的 Claude Code 上测过，见下面「给懂技术的人」。

**为什么一段对话还开着的时候，图还在？**
Claude Code 把开着的对话放在内存里，外面的工具改不了。所以它在对话关掉的时候烧，下次续上就是干净的。

**Claude 去读存档时，问我「允许读取吗」？**
存档放在 Claude Code 的设置文件夹里，不在你的项目里，所以 Claude Code 可能会先问你。点允许就行。

**存档会一直占地方吗？**
不会。超过 30 天的存档，会在它下次运行时自动删掉。天数在设置里能改。

**子代理是什么？它们看过的图也管吗？**
有些活 Claude 会叫几个分身（子代理）帮忙做，Claude Code 把每个分身做了什么另存成一个文件，图也在里面。这些文件在对话结束时也会一样处理。

**用订阅还是用 API 账号都能用吗？**
都能用。按 token 付费的话，省下的就是真钱。

**怎么卸载？**
在 Claude Code 里输入 `/plugin uninstall burn-after-reading@burn-after-reading`。
它自己的文件（设置、存档、备份）在 `~/.claude/burn-after-reading/`，不要了可以把这个文件夹整个删掉。

## 给懂技术的人

### 不用插件，手动装钩子

```bash
npm install -g github:yuanheng045-jpg/claude-burn-after-reading
```

然后在 `~/.claude/settings.json`（所有项目）或 `.claude/settings.json`（单个项目）里加上：

```json
{
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

### 命令行

```bash
burn-after-reading --latest --dry-run       # 当前文件夹对应项目里最新的那段对话，先看看会烧掉什么
burn-after-reading --all                    # 这个项目的所有对话（比如装之前的旧对话），连同子代理
burn-after-reading <对话 id 或 .jsonl 路径>
burn-after-reading settings                 # 看设置和最近做了什么
burn-after-reading settings user=burn text=archive text-over=30000 lang=zh
```

不安装也能用：`npx github:yuanheng045-jpg/claude-burn-after-reading --latest --dry-run`。

设置项：`user` `screenshot` `file` `text`（各取 `keep` / `archive` / `burn`）、`text-over`（多少字算很长，默认 20000）、
`archive-days`（默认 30）、`keep-latest`（最近几张先不动，默认 0）、`lang`（`en` / `zh`）、`labels`（编号开关）、`backup`（备份开关）。
设置存在 `~/.claude/burn-after-reading/settings.json`；也可以用环境变量 `BURN_AFTER_READING_<设置名>` 覆盖，比如 `BURN_AFTER_READING_LANG=zh`（`settings` 会列出哪些正被环境变量改着）。

单次运行的选项：`--dry-run`、`--keep <n>`、`--text-over <字数>`、`--lang <en|zh>`、`--no-backup`、`--force`、`--json`、`--quiet`。
退出码：`0` 完成或无事可做，`1` 出错，`2` 拒绝（对话开着，或烧的时候文件被改了）。

### 它保证什么

- **只烧 Claude 回应过的。** Claude 在后面回过话才算看过；Claude Code 自己写的 API 报错不算。
- **不碰开着的对话。** 命令行会查 Claude Code 自己记的「正在运行的对话」，开着的不烧；钩子在对话关掉时跑，同一段对话若还在别的窗口开着，就等它也关了。
- **只拿掉数据本身。** 行数和顺序、每个 id 和链接、工具调用和结果的配对、每一个字都不动；每行改完先核对，对不上就原样留着并写进报告；没改的行逐字节写回。
- **每一份副本都处理。** 对话里的那份、Claude Code 私下另存在 `toolUseResult` 和 `api-request-blob` 里的、这段对话叫过的子代理的记录（`<对话>/subagents/`）里的，以及 Claude Code 给你发的图存在临时文件夹里的那个文件。那个文件只有确定是哪张图的（这条消息的每张图正好对应一行 `[Image: source: …]`），而且确实是 Claude Code 的（你自己的普通文件，解开链接后在临时文件夹的 `<对话>/images/` 里）才删；否则留着不动。
- **写入安全。** 临时文件、`fsync`、原子替换、保留文件权限；烧的过程中文件被改了就什么都不写。存档也先这样写好（在 macOS 和 Linux 上只有你自己能读），已有的存档只有内容一模一样才会沿用。
- **备份不带图。** 每段对话保留最近三次烧之前的版本，在 `~/.claude/burn-after-reading/backups/`，30 天。
- **跑几遍都一样**，跑过一半（比如用了 `--keep`）之后再跑也一样。
- **试运行什么都不改**，连存档的清理也不做。
- **设置命令只能改设置。** 它拿到的权限只够运行它自己的 `settings` 命令。
- **拿真的 Claude Code 测过。** 除了单元测试，还会驱动真的 Claude Code 对接一个本地的假 API，不用账号也不联网。测的是：烧过的对话能续上，续上后发的是说明而不是图；发来的图会存档、Claude Code 临时文件夹里的那份会删掉、Claude 能把存档读回来；PDF；子代理看过的图；插件装上后会编号、对话结束时会烧，设置命令能显示设置、也能保存修改。CI 在 Linux、macOS、Windows 上，用 Claude Code 2.1.281 和最新版，每次改动都跑，每周还自动跑一次，好在 Claude Code 改格式时第一时间发现。

### 做不到的

- 下次读进来才生效（原因见上面常见问题）。按条执行 `claude -p --resume` 的应用，从下一条起就生效。
- 改了前面的内容，下一次请求要从烧掉的地方开始重建一次提示缓存。在对话结束时烧，一般是停了一阵之后，那时缓存多半已经过期。
- 对话记录的格式没有官方文档，每个版本都可能变。它只改认得的部分；在不认得的地方发现图片数据会提醒你，那时请提 issue。
- 你自己发的图，Claude 看到时不会编号（没有钩子看得到它们）；所以它们默认存档。
- 在交互式终端里直接粘贴的图，自动测试还没覆盖到（跟着消息发的图测过）。

### 给开发者

```js
import { burnSession, burnFile, burnLines } from 'claude-burn-after-reading'   // npm i github:yuanheng045-jpg/claude-burn-after-reading

const report = burnSession(transcriptPath)   // 用保存的设置；也可以传 { modes: { user: 'burn' }, lang: 'zh', dryRun: true }
```

`burnSession` 烧一段对话连同它的子代理（结果在 `report.subagents`）；`burnFile` 只烧一个文件。传进去的选项会先检查，写错了直接报错，不会悄悄做别的事。如果你的应用让 Claude Code 进程一直开着，先停进程、烧、再续上。`burnLines(lines, options)` 做同样的事，但不碰文件。

### 类似的工具

[cozempic](https://github.com/Ruya-AI/cozempic) 用很多种策略修剪 Claude Code 的上下文，图片是其中一种。
这个工具只做一件事：Claude 看过的，在安全的时候自动拿掉。

## 许可证

MIT
