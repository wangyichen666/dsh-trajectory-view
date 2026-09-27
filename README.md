# DSH 轨迹分析器

独立运行的本地只读网页，以及 DSH 会话页的“分析”标签插件。标签页的“打开详情”按钮按当前 Session ID 打开本网页。网页从 `~/.dsh/sessions` 读取 Session 日志，在另一个端口展示逐 Event 检查、逐步 LLM 往返、工具输入输出、子 Agent 关系、轨迹图和顺序图。它使用同级 `deepseek-harness` 源码构建出的消息投影模块，还原每次模型响应之前的逻辑上下文。

## 安装到 DSH

本仓库的 `integration/deepseek-harness.patch` 包含会话页的“分析”标签、请求分析组件、配置与对应测试，基于 DeepSeek Harness 提交 `477b4f420553e8a52c2fbccc464d7561b239c443`。将两个仓库放在同一目录下，运行：

```sh
git clone https://github.com/deepseek-ai/deepseek-harness.git
git clone https://github.com/wangyichen666/dsh-trajectory-view.git
cd dsh-trajectory-view
./install.sh ../deepseek-harness
```

若补丁与更新后的 DSH 源码冲突，脚本会停止，不会覆盖现有修改。可在干净的 DSH checkout 中切换到上述提交后重试。已有本插件修改的 checkout 无需再次运行安装脚本。

## 启动

先在同级 `deepseek-harness` 目录执行 `pnpm install` 和 `pnpm run build`，并启动 DSH Web；再在本目录执行：

```sh
npm start
```

启动输出会给出带随机访问令牌的本地链接。默认监听 `127.0.0.1:3091`；可通过 `DSH_TRACE_PORT` 和 `DSH_SESSIONS_ROOT` 调整端口与日志目录。`DSH_WEB_ORIGIN` 默认是 `http://127.0.0.1:3080`，只向这个 DSH 页面提供打开详情所需的访问链接。改变详情服务端口时，还要在 DSH 的 `ui-trajectory` 插件配置中设置 `explorerOrigin`。服务器只读取日志，不写入 DSH 会话。

在 DSH Web 中打开任一会话，选择 **分析 → 打开详情**。分析器也可直接通过启动输出的链接打开，并在页面顶部选择 Session。

## 数据范围

页面支持当前的 Session v4 JSONL 和拼接 Zstandard 帧，读取时忽略尚未写完的末尾帧。Event 检查器保留每条日志的完整 JSON。LLM 页面以该次 `assistant/message` 或 `assistant/attempt` 之前的日志前缀重建有序消息；`request/header` 提供请求配置和工具 Schema。模型返回显示已保存的适配器标准化流与 Harness 组装后的消息。历史日志没有保存提供方原始 HTTP 请求体或原始 SSE 帧。

子 Agent 数量来自父会话的 `subagent/catalog`。父会话记录子 ID 与目录模式；子会话 header 的 `isSeeded` 说明是否继承父日志。`spawn` provider 使用独立对话，`fork` provider 继承父会话最后一个已完成轮次的前缀。
