# pi-bark-reminder

当 pi 的一次任务真正结束、进入 idle 状态后，通过 [Bark](https://github.com/Finb/Bark) 向 iPhone 发送提醒。
插件监听 `agent_settled`，因此自动重试、自动压缩和排队的后续消息全部处理完毕后才会通知。

## 安装

将 `index.ts` 加入 pi 的全局 `settings.json` 的 `extensions` 数组：

```json
{
  "extensions": ["/path/to/pi-bark-reminder/index.ts"]
}
```

Windows 中可使用 WSL UNC 路径：

```text
\\wsl.localhost\Ubuntu\path\to\pi-bark-reminder\index.ts
```

重新启动 pi 或执行 `/reload` 生效。

## 配置

插件只读取用户目录下的私有配置，不使用环境变量：

```text
~/.pi/agent/pi-bark-reminder.json
```

首次安装时，从仓库的 `pi-bark-reminder.example.json` 复制一份到上述位置，
然后填写自己的 Bark Key：

```json
{
  "defaultEnabled": false,
  "barkEndpoint": "https://api.day.app/YOUR_BARK_KEY",
  "barkLevel": "timeSensitive",
  "barkGroup": "pi",
  "barkSound": "",
  "barkTimeoutSeconds": 15
}
```

此文件位于用户目录之外，不应提交到插件仓库。WSL 和 Windows 原生 pi 有各自的
用户目录，因此各自需要一份配置文件。

## 开关逻辑

Footer 显示当前会话状态：`[Bark: ON]` 或 `[Bark: OFF]`。

默认关闭。执行 `/bark` 时会同时：

1. 切换当前会话的提醒状态；
2. 将同样的状态保存为未来新会话的默认值。

所以，执行 `/bark` 开启后，当前会话和之后新开的会话都会提醒；再次执行关闭后，
当前会话和之后新开的会话都会关闭。其他已经存在的会话保持它们自己的 ON/OFF 状态。

通知包含项目名、可选的会话名和本轮耗时。WSL 直连 Bark 失败时，插件会自动通过
Windows PowerShell 网络发送；这不需要额外配置。
