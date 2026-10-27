# dsh-session-recover

把 **DeepSeek Harness（DSH）** 里"打不开的会话"救回来。零依赖，一个文件，命令名 `dsh-recover`。

它不是教程，是**能直接跑的工具**：读你机器上真实的 `$DSH_HOME`，按 DSH 自己的布局与身份规则逐条校验，指出哪一处会让服务起不来、哪一句崩溃日志是它的后果，并给出可执行的动作。

## 它救的四种情况

**1. 项目目录下的扁平会话文件（能让整个应用起不来）**

DSH 的会话存储只认 `<sessions>/<项目目录>/<session-id>/session.vN.jsonl.zstd`。项目目录下只要出现一个扁平的 `*.jsonl`（导出、解码、手工备份的常见产物），`dsh-session-persistence-jsonl` 就会抛：

```
session artifact "...\\wechat-xxx.decoded.jsonl" uses the unsupported flat-file layout
```

`workspace` 插件因此激活失败，`workspaceRegistry` 永远 pending，于是用户看到的是：

```
workspace/create: active Service "workspaceController" is unavailable
session/control: active Service "sessionController" is unavailable
```

真正的根因在另一个目录里躺着。`dsh-recover` 直接点名是哪个文件。

**2. 会话文件还在，却没被任何工作区认领**

`workspace.json` 的 `sessionIds` 是侧边栏的权威名单。文件被移走后 DSH 会在下一次写入时把它们从名单里剪掉；再把文件放回来，它也不会自动回来——重启后只会出现在「未分组」里。工具列出所有孤儿会话，`--fix-orphans` 按会话头里的 `cwd` 把它们挂回相符的工作区（等价于 DSH 自己的 `attachSession`）。

**3. 多帧 zstd 日志被误判成损坏**

DSH 每追加一条事件就写一个独立的 zstd 帧。用单帧解压器读，只能拿到第一行（往往就是 session 头），看起来像"文件只有一行、肯定坏了"。工具按帧切分、逐帧解压、校验记录完整性、`seq` 是否单调。

**4. 崩溃日志里的已知根因**

扫描 `%APPDATA%\@deepseek-ai\dsh-desktop\logs\crash-*.log`，把几类事故与解释对上：扁平布局、通配地址（0.2.1 拒绝 `0.0.0.0`）、被连带 pending 的服务、压缩模式不匹配、写到一半的记录。

## 用法

```bash
# 诊断（默认读 $DSH_HOME 或 ~/.dsh）
npx dsh-session-recover

# 机器可读
npx dsh-session-recover --json

# 把项目目录下的扁平会话文件移到隔离目录（移动，不删除）
npx dsh-session-recover --fix

# 把孤儿会话挂回 cwd 相符的工作区（先备份 workspace.json）
# ⚠️ 先完全退出 DSH 再跑，否则会被内存里的状态覆盖
npx dsh-session-recover --fix-orphans

# 指定别的家目录
npx dsh-session-recover --home "D:\dsh-test"
```

退出码：`0` 干净（可能有提醒）、`1` 有错误、`2` 无法诊断。

## 它不做什么

- 不解析、不改写会话内容，只读日志。
- 不猜"哪个会话该挂到哪个工作区"：只按会话头里的 `cwd` 与工作区 `path` 严格比对，不相等就跳过并说明原因。
- 不删除任何东西：`--fix` 是移动，隔离目录在 `<DSH_HOME>/dsh-doctor-quarantine/<时间戳>/`。
- 不修复损坏的日志帧：只报告哪一段坏了，怎么修得看备份。

## 实测输出

```
dsh-session-recover 0.1.0
DSH_HOME  C:\Users\you\.dsh

会话 7 个，分属 2 个项目目录
  ✓ session-198950d7-...  「大肥鱼接入微信聊天」  711 帧, seq 0–1216, 919 KB
  ✓ session-273001aa-...  「分析文档测试方法」   1235 帧, seq 0–1984, 1.3 MB
  ...

工作区 1 个，认领 3 个会话
  · default-workspace  C:\Users\you\Documents\deepseek-harness\default-workspace
  ! 4 个会话没有被任何工作区认领（插件运行时自建的那种，属正常）

崩溃日志里对上的已知问题：
  · 项目目录下有扁平会话文件，workspace 服务因此起不来
    crash-2026-10-26T07-56-55-500Z-host.log: ... uses the unsupported flat-file layout
```

## 为什么值得存在

这类故障的排查路径通常是：看对话框的报错 → 猜 → 搜 → 翻进 `~/.dsh` → 找到崩溃日志 → 读懂插件依赖图 → 才发现是一个导出文件放错了目录。`dsh-recover` 把这段路压成一条命令。

MIT。
