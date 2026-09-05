# Adapter authoring workflow

## Runbook（一步一步勾选）

```
[ ] 1. opencli doctor 返回 "Everything looks good"
[ ] 2. 读站点记忆：
       [ ] ~/.opencli/sites/<site>/endpoints.json 存在？里面有想要的 endpoint？
       [ ] references/site-memory/<site>.md 存在？看"已知 endpoint"节
       [ ] 命中后：**跳到第 5（endpoint 验证） + 第 7（字段核对）**，不能直接跳第 9 写 adapter
       [ ] memory 写入超过 30 天（看 `verified_at`）→ 当作过期，按冷启动走 Step 3 → 4
[ ] 3. 侦察（site-recon.md）：
       [ ] **首选**：`opencli browser analyze <url>` 一步拿 pattern + 反爬 + 最近 adapter + next step
       [ ] `analyze` 结论模糊时再手跑：`open` → `wait time 2` (或 `wait xhr <regex>`) → `network`
       [ ] 定 Pattern（A / B / C / D / E）
[ ] 4. API 发现（api-discovery.md）按 Pattern 选 §：
       [ ] Pattern A → §1 network 精读
       [ ] Pattern B → §2 state 抽取 + §1 深层数据
       [ ] Pattern C → §3 bundle / script src 搜索
       [ ] Pattern D → §4 token 来源 + 降级 §5
       [ ] Pattern E → 找 HTTP 轮询接口；找不到才 §5
       [ ] 无文档 API / DOM 丢数据 / 写操作 / bundle 与 network 冲突 → `deep-recon.md`
           [ ] 写 intent matrix 和明确的 mutation boundary
           [ ] baseline → 单一动作 → 新请求 diff；至少一组 changed-input 对照
           [ ] jsluice 只扩大候选面；候选必须进入 evidence ledger
           [ ] read 候选过 occurrence/replay/completeness/auth/pagination/failure gate
           [ ] write 候选有明确授权、目标绑定、幂等/不确定性与不可自动重试语义
[ ] 5. 候选合同验证（memory 命中也要重跑）：
       [ ] `PUBLIC_API / COOKIE_API / PAGE_FETCH`：safe replay 跨两个输入返回成功
       [ ] `INTERCEPT`：两次自然页面动作都截到属于目标 identity 的完整响应
       [ ] 响应含目标数据（不是 HTML / 广告 / 推荐侧栏），字段与网页对得上
       [ ] 分页达到 exact limit 或证明 upstream exhaustion；失败不返回 partial
       [ ] write 不自动 replay，必须过 `deep-recon.md` 的额外合同门禁
[ ] 6. 写 strategy note（写代码前的强制产物）：
       [ ] 从 `PUBLIC_API / COOKIE_API / PAGE_FETCH / INTERCEPT / DOM_STATE / UI_SELECTOR` 选一个
       [ ] 填 Contract：`stable / visible-ui / internal-unstable`
       [ ] 填 Evidence：observed request/state、auth source、replay result
       [ ] 如果选 `PAGE_FETCH` / `INTERCEPT`，必须解释为什么 `PUBLIC_API` / `COOKIE_API` / `UI_SELECTOR` / `DOM_STATE` 都不适合
       [ ] 如果选 `UI_SELECTOR` / `DOM_STATE`，不需要为 "为什么不是 API" 过度辩护；只要说明语义锚点和 typed error 路径
[ ] 7. 字段解码：
       [ ] 自解释 → 直接用 key
       [ ] 已知代号 → field-conventions.md 查表
       [ ] 未知代号 → field-decode-playbook.md（排序键对比 / 结构差分 / 常量排查）
[ ] 8. 设计 columns（output-design.md）：
       [ ] 命名 camelCase 且对齐邻居 adapter
       [ ] 类型 / 单位 / 百分比格式清楚
       [ ] 顺序：识别列 → 业务数字 → metadata
[ ] 9. 写 adapter（adapter-template.md）：
       [ ] opencli browser init <site>/<name>
       [ ] 找同站点或同类型最像的 adapter，cp 过来
       [ ] 改 name / URL / 字段映射
[ ] 10. opencli browser verify <site>/<name>
        [ ] 首轮通过后立刻 `--write-fixture` 生成 `~/.opencli/sites/<site>/verify/<cmd>.json` 种子
        [ ] 手改种子：加 `patterns`（URL / 日期 / ID 格式）+ `notEmpty`（核心字段）+ 收紧 `rowCount`
        [ ] 再跑一次 `opencli browser verify <site>/<name>`，确认 ✓ matches fixture
[ ] 11. 字段值 vs 网页肉眼比对（别只看 "Adapter works!"）
[ ] 12. 回写站点记忆（**verify 通过 + 肉眼比对对得上之后**，schema 见 `references/site-memory.md`）：
        [ ] `endpoints.json`：以 endpoint 的短名为 key，value = `{url, method, params.{required,optional}, response, verified_at: YYYY-MM-DD, notes}`
        [ ] `field-map.json`：只追加新代号。key = 字段代号，value = `{meaning, verified_at: YYYY-MM-DD, source}`；**已存在的 key 不要覆盖**，有冲突先和网页肉眼值对齐再写
        [ ] `notes.md`：顶部追加一段 `## YYYY-MM-DD by <agent/user>`，写本次写 adapter 时遇到的新坑 / 新结论
        [ ] `verify/<cmd>.json`：**必填。** `opencli browser verify` 的期望值（args / rowCount / columns / types / patterns / notEmpty），Step 10 已经让你生成了，这里只是 checklist
        [ ] `fixtures/<cmd>-<YYYYMMDDHHMM>.json`：仅保存公开数据或可证明完成脱敏的样本；私人邮箱/消息/账号等高敏响应改用合成 fixture，不落盘
        [ ] 原始 dump/capture 只短暂落 `/tmp/` 或受控 cache；安全分级后的长期样本才进 `fixtures/`，任务结束清理原始文件
[ ] 13. repo 贡献收口（私人 adapter 可跳过）：
        [ ] production-path tests，不只测 parser/helper
        [ ] `npm run typecheck` + focused/site tests + `npm run build`
        [ ] `node dist/src/main.js validate <site>`
        [ ] `npm run check:typed-error-lint` + `npm run check:silent-column-drop`
        [ ] adapter 文档；若 sitemap/site memory 有稳定新知识则同步
        [ ] `git diff --check` + 敏感数据扫描 + 删除 raw capture/cache + 释放 browser session
        [ ] 写操作或私有协议请独立 review exact head 后再合入
```

---

## 降级路径（某步卡住跳到哪）

| 卡在 | 现象 | 跳去 |
|------|------|-----|
| Step 4 API 发现 | `network` 空，`__INITIAL_STATE__` 也空 | §3 bundle 搜 baseURL |
| | bundle 搜不到 baseURL | §5 intercept |
| Step 5 endpoint 验证 | 401 / 403 | §4 token 排查 |
| | 200 但响应是 HTML | 回 Step 3 换 Pattern 判断 |
| | 200 但 `data: []` 空 | 参数传错 / 接口换版，回 §1 看 network 里真实请求头 |
| Step 7 字段解码 | 排序键对比推不出 | field-decode-playbook.md §3 结构差分 |
| | 还推不出 | 先输出 raw，adapter 跑起来再迭代 |
| Step 10 verify 失败 | `fltt` 漏了 / 字段映射错 | autofix skill；复现命令加 `--trace retain-on-failure` |
| | 某列永远是 `null` | 字段路径错了，回 Step 7 |
| Step 10 verify fixture mismatch | `[pattern]` row[i] 报错 | 先肉眼比对网页值；值对 → 是 fixture pattern 太严，放宽；值不对 → 字段映射错 |
| | `[column] missing column "X"` | 实际 response 没这列（站点改版 or args 影响）；重新 `--update-fixture` 或修 adapter |
| | `[type]` actual null / undefined | 字段提取失败，回 Step 7 重抽；临时 fallback 用 union type `string\|null` 只有在语义真的可空时用 |
| Step 11 数值不对 | 差 10000 倍 | 单位不统一（"万" vs "元"） |
| | 百分比小 100 倍 | 响应已是 `0.025`，不要 × 100 |

---
