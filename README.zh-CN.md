---
metadata:
  change-policy: >-
    Do not modify this Markdown file together with source code or other non-Markdown
    files. Submit changes in a separate documentation-only pull request for review
    and approval. The recommended reviewer is taowen-paraflow.
---

<div align="center">

# Morty

[English](README.md) · **简体中文**

### 离开电脑，也能让工作继续。

在任意浏览器中，继续与 Codex、Claude Code 和 Pi 对话。

[打开 Morty →](https://morty.build) · [开始连接](#一条提示词然后拿起手机) · [参与贡献](docs/CONTRIBUTING.md)

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)

<img src="docs/assets/readme-accent.svg" width="320" height="40" alt="" />

</div>

Agent 在电脑上工作，你可以用手机、平板或另一台电脑查看进展，给出下一条指令。
Morty 把正在进行的对话带到你手边。

## 工作进展，随时掌握

- **看见正在发生的事。** 实时查看回复和工具执行进展，打开对话中的文件和生成的图片。
- **让任务继续向前。** 发送指令、排队追加任务、停止当前执行，或响应 Agent 支持的审批请求。
- **换个屏幕，接着聊。** 从另一个浏览器回到已连接的对话，继续之前的工作。

## 你的 Agent，原来的环境。

项目、工具和已登录的 Agent 仍在连接的机器上，Morty 提供远程对话的浏览器界面。
换个屏幕，打开已连接的对话就能继续工作。需要协作时分享访问权限，用完后可以撤销。

## 一条提示词，然后拿起手机。

打开 [morty.build](https://morty.build) 复制设置提示词，或把下面的内容发给你的编程 Agent：

```text
Fetch https://morty.build/doc/setup.md and complete the Morty setup for me.
You may install missing prerequisites and pair this machine.
```

打开 Agent 返回的链接，或用手机扫描二维码。无需安装手机 App。

安装过程是一份你的 Agent 会读的文档，不是黑盒：
[setup.md](https://morty.build/doc/setup.md) 完全公开，并且要求 Agent 把安装脚本下载到
私有临时目录、运行前先检查一遍。粘贴提示词之前，建议你自己也读一遍。

## 运行条件

- 电脑上装有并已登录 **Codex**、**Claude Code** 或 **Pi** 其中之一
- **Node.js 22.19+（22.x）或 24.20+（24.x）**
- 连接的机器保持**唤醒并联网**。Morty 是你本地会话的一扇窗，不是云端沙箱；
  电脑休眠时会话随之暂停，重新连上之前浏览器里看不到历史。

## 停止 Morty

`npx --yes @morty-build/cli@latest stop` 停止 Morty，
保留配对关系和 Agent 历史。

## 已知限制

- **在 Morty 里继续之前，先退出终端里的会话；回到电脑后，再重新恢复它。** 用
  `claude --resume`、`pi --continue` 或 `codex resume` 打开的终端会话里做的事，Morty
  都能接上。但一直开着没退出的终端会话保留的是它自己的那份对话：看不到你在 Morty 里发的
  消息，**Claude Code** 和 **Pi** 在那里发下一条消息时还会让对话分叉。
- **Codex 同一时间只允许一个应用写入同一个 thread。** 在 Morty 里用过某个 thread 之后，
  如果终端提示 `thread ... already has an active writer`，执行 `npx --yes @morty-build/cli release`。它会交还
  闲置的会话，不会断开 Morty；之后在 Morty 里继续时会重新打开。

## Morty 如何处理你的数据

- **对话是从你的机器实时读取的。** 浏览器只保存会话 ID 和标题，历史记录在每次打开
  会话时从你电脑上的 daemon 取回。电脑离线时，浏览器里看不到历史——这是设计如此，
  不是缓存没命中。
- **云端不保存你的历史。** Morty 从连接的机器读取会话历史，从不把它存到云端。
- **会话载荷采用端到端加密（E2EE）。** 浏览器和你电脑上的 daemon 负责加密和解密会话载荷。
  Morty relay 转发密文，不持有载荷加密密钥。路由元数据对 relay 仍然可见；
  端到端加密不会隐藏所有连接信息。
- **机器身份只留在本机。** 安装程序把这台电脑的 Morty 身份保存在当前用户的本地应用
  数据目录中，并用文件系统权限保护。它不会在电脑之间同步，每台电脑各有一份。
- **分享是显式的、有时限的，也是可撤销的。** 分享链接在 10 分钟内有效，只能供一台设备
  使用一次。该设备可在分享时选择的期限内查看并操作该电脑上的会话（1 小时至 30 天，默认
  1 天），包括让 Agent 执行命令、修改文件。Codex 会话默认拥有这台电脑的完全访问权限，
  所以请像对待密码一样对待这个链接。**Devices** 列出有访问权限的设备，可以逐一
  断开。要撤销此前从某台机器分享出去的全部链接和浏览器访问，对你的 Agent 说：
  *"Revoke all links I previously shared from this machine."* 这同时会更换这台机器自己的
  凭证，被复制的旧凭证随之失效。被断开设备上的聊天窗口会立即
  关闭；如果暂时无法联系 relay，最迟在 15 分钟内关闭。
- **Morty 记录设备加入时的大致位置，不记录 IP 地址。** 浏览器打开分享链接时，Morty
  保存 Cloudflare 提供的城市和国家，帮助你辨认自己的设备。
- **重启更新。** `npx --yes @morty-build/cli@latest restart` 启动最新版。用 `status` 查看 CLI 和 daemon 版本。
- **网站向 Sentry 上报错误和性能诊断。** 报告会去除 URL 查询参数、用户信息、cookie、
  请求头和请求体。Morty 的服务器会在日志里记录 setup 进度（获取说明、创建身份、签发链接、
  打开链接），只记录步骤本身以及请求来自浏览器还是 Agent。你主动提交的 bug 报告还会附带
  浏览器和你电脑上 daemon 的诊断信息，以及你附上的图片。

## 离开

Morty 不会扣住你的会话。执行 `npx --yes @morty-build/cli stop`，这台电脑上所有 Morty 会话都会关闭，
而配对关系和 Agent 自身的历史记录完整保留。回到原生客户端继续：

| Agent | 恢复会话 |
| --- | --- |
| Codex | `codex resume` |
| Claude Code | `claude --resume`，或用 `claude --continue` 直接接上最近一次 |
| Pi | `pi --resume`，或用 `pi --continue` 直接接上最近一次 |

之后执行 `npx --yes @morty-build/cli start` 即可重新连接 Morty。如果只想把闲置的会话交还给终端、
不断开 Morty，改用 `npx --yes @morty-build/cli release`。

## 安全

发现安全问题？请私下报告——见 [SECURITY.md](SECURITY.md)。
请不要为安全问题创建公开 issue。

---

Morty 的浏览器、云端服务和本地 Runtime 源码统一由本仓库维护。

[参与贡献](docs/CONTRIBUTING.md) · [测试指南](docs/TESTING.md) · [使用指南](docs/GUIDE.md) · [部署说明](docs/deployment.md) · [安全](SECURITY.md)

## 许可

[Apache License 2.0](LICENSE)，另见 [NOTICE](NOTICE)。
