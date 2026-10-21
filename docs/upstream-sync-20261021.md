# 2026-10-21 本地上游同步

同步起点：fork `stable` 为 `2ea244ab`，共同上游基线为 `8271afc6`。
本次合入 `upstream/main` 的 `fe5f1d96`，共 59 个上游提交。
本地 `main` 已快进至同一上游提交。

## 主要变化

- 上游 CLI 基线由 1.8.8 升至 2.0.2，扩展由 1.0.24 升至 1.0.26。
- 默认 JSON 输出采用 `{ok:true,data:...}`，错误采用 `{ok:false,error:...}`。
  browser 页面命令使用显式 `--session`；adapter 开发命令归入
  `adapter init|check|test`；`list` 默认提供分页摘要。
- 增加每站点 tab slot 池与任务间隔、native Chrome 工具、未完成网络响应快照；
  修复重复导航、隐藏页面原生输入、上传以及插件路径约束。
- 合入小红书、携程、Twitter、ChatGPT、Gemini、TikTok、Instagram、Reddit
  等适配修复，增加抖音内容详情、Proton API 邮箱等能力。
- 移除 Electron 桌面适配器、sitemap 和外部 CLI hub。这些命令的调用方需要迁移。

由于存在 CLI 语法与输出破坏性变化，fork CLI 独立版本升至 `3.0.0`；
扩展独立版本升至 `2.1.0`，兼容范围为 `>=3.0.0 <4.0.0`。
这些是源码候选版本，不表示已经发布或安装。

## Fork 兼容处理

- 保留 operation deadline、取消 tombstone、verified teardown、tab ownership
  以及持久 session 的独立生命周期；合入 site slot 时按最终 session 创建 operation。
- 网络捕获默认仍只返回已完成记录，保留在途请求；`retainIncomplete=true`
  提供上游所需的 pending snapshot，保持缺失 body 的显式错误信息。
- 保留 Twitter 完整详情、作者认证/组织徽章和头像，加入上游新增元数据。
- 保留携程价格、脱敏错误和跨批响应聚合；合入前台等待和捕获完成检查。
- 保留小红书 backend 搜索预算、取消和隔离语义，加入站内搜索与新布局处理。
- 新增 `list --full -f json` 供 backend 获取完整 adapter 参数和调度元数据。
  backend 解包新成功 envelope，REST/MCP 的 `output` 继续返回原业务结果。
  回归覆盖超过单页的 catalog、拒绝摘要冒充完整目录，以及实际构建 CLI 的结果。
- backend MCP SDK 锁定版本从 2.0.0 更新至兼容的 2.3.1，消除依赖审计中的高危项。
- 保留 fork 私有包与 GitHub 构件发布路径；上游 npm workflow 限定为上游仓库。
- 浏览器测试按 manifest 查找带版本的 worker；operation fixture 只终止自己创建的
  daemon，避免测试初始化失败后关闭正在运行的用户 daemon。

## 本地验证与边界

- TypeScript、CLI build、扩展 typecheck/build/package 通过。
- unit / extension / adapter：543 个文件、6474 个测试通过。
- backend：53 个测试通过；同 checkout 集成：6 个测试通过。
- npm provenance helper：21 个测试通过；两个 adapter lint gate 无新增问题。
- 文档构建通过；CLI、扩展、backend 生产依赖审计均为 0 vulnerabilities。
- 未运行会占用固定端口的 daemon E2E、真实登录站点或 Linux headed Chrome gate。
  CI、容器构建及部署验收仍属于后续发布流程。
- 本次只更新本地分支，没有 push、发布 tag/release、替换已安装 CLI 或重载扩展。
