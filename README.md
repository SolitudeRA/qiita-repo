# Qiita 发布子项目

本仓库接收 `Blog-Project` 的文章和权威 manifest，并以稳定的
`article_id` 更新已经绑定的 Qiita item。标题、源文件名和 `public/`
文件名都不是文章身份。

## 身份协议

`pre-publish/manifest.json` 必须是主仓库
`articles/manifest.json` 的原样副本，不能增加 Qiita 私有字段。此子项目只读取：

- `schema_version`
- `articles[].article_id`
- `source`
- `article_state`
- `targets.qiita.desired`

没有 `targets.qiita` 的条目会被忽略。当前发布切片只接受
`article_state: active` 且 `targets.qiita.desired: published`。
`retiring`、`retired` 或 `withdrawn` 会明确报错；普通发布流程不会删除、
撤回或私密化任何文章。

Qiita 源文件只接受以下投影：

```text
articles/share/<basename>.md -> pre-publish/<basename>.md
articles/qiita/<basename>.md -> pre-publish/<basename>.md
```

所有投影后的 basename 必须唯一。每个源文件的 front matter 必须包含与
manifest 完全一致的小写 32hex `article_id`：

```yaml
---
article_id: 339243802597e8c42bcddfb10b5e94e3
title: 示例标题
tags:
  - example
local_updated_at: '2026-07-23T00:00:00.000Z'
---
```

文章间引用使用 ID，不允许标题回退：

```text
<<<article:339243802597e8c42bcddfb10b5e94e3>>>
```

生成后的正文会包含恢复标记：

```html
<!-- blog-project:article-id=339243802597e8c42bcddfb10b5e94e3 -->
```

## Qiita binding

平台绑定只保存在根目录 `article-map.json`：

```json
{
  "schema_version": 1,
  "platform": "qiita",
  "qiita_user": "SolitudeRA",
  "bindings": {
    "<article_id>": {
      "item_id": "<20hex Qiita item id>",
      "binding_state": "bound"
    }
  }
}
```

脚本使用 `item_id` 在 `npx --no-install qiita pull` 的结果中定位目标，不按标题或文件名匹配。
因此修改标题或源文件 basename 后仍会更新原来的 Qiita item。

对于既有 binding，如果源标签和 pull 到的远端标签在规范化后是一一对应、
集合也完全相同，构建始终会按源标签顺序保留远端现有的显示名，避免
`server` → `Server`、`nodejs` → `Node.js` 这类仅显示形式的改写。
标签身份使用 NFKC 和固定的 `en-US` locale 小写，并且只忽略 ASCII 的点、下划线、
连字符和空白；日文固有标点不会被删除。任何真实新增、删除、无法匹配、空身份或规范化冲突都会
安全回退到源标签，因此真实标签编辑仍会生效。

工作流会把当前 binding 与 PR 的 base revision（`pull_request.base.sha`）或
一次 push 之前的 revision（`github.event.before`）比较。既有
`article_id -> item_id` 不允许修改或删除，
`qiita_user` 也不能在普通发布中漂移；
只有 base revision 的可达历史从未出现过 `article-map.json`，首次引入才可跳过
比较；当前树缺失但历史出现过 map 时，会回溯最近一份 map 继续校验。新增文章在
进入普通发布流之前，必须先人工确认 Qiita item 并增加 binding；此流程不会自动创建文章。

## 安全发布流程

本地验证命令：

```bash
npm ci
npm run typecheck
npm test
npm run validate:map-history -- --baseline-ref <base-revision>
npm run prepare:pull
npx --no-install qiita pull --force
npm run validate
```

`npm run build:articles` 可在临时副本中作为生成检查，因为它会改写 `public/`。
真实发布前必须先用 `prepare:pull` 删除并重建这个纯生成目录，再执行只读的
`npx --no-install qiita pull --force`。这既覆盖本地生成结果，也清除远端已删除或已不可见目标
留下的陈旧文件，并会永久丢弃 `public/` 内所有本地生成物；缺失 binding 会在随后全量验证时失败。验证后应立即运行单进程
orchestrator，在这两步之间不能再单独 build。这里的 `--force` 只用于 pull 的
本地基线恢复，不是强制 publish。GitHub Actions 也遵循同一顺序。发布入口需要
`QIITA_TOKEN`：

```bash
npm run release:bound
```

它先 snapshot 所有 pull 到的绑定目标，再 build，随后重新全量读取和验证，并严格
核对 build 前后的 `article_id + item_id + public basename` 集合。任何验证错误或
目标漂移都会在第一次 Qiita 写调用之前失败。`active + published` 始终生成
`private: false`，不会继承远端的 `private: true`。

changed-only 比较只使用实际可发布投影：`title`、忽略顺序但精确保留显示名的 `tags`、
`private`、`organization_url_name`、`slide` 和正文。`updated_at`、`id`、
`ignorePublish` 与 front matter 序列化格式不参与内容 diff；`id` 仍由 binding
和全量校验保证不能漂移。正文只把 CRLF 规范为 LF，并忽略首尾空行和终止换行，
不会折叠内部空行。没有隐藏 `article_id` marker 的首次迁移目标会被判定为 changed；
以后只有 `local_updated_at` 改变而发布投影不变时会跳过。纯 tag 重排也会跳过，
因为 qiita-cli 1.6.1 自身把 tag 顺序视为无语义。规范化身份等价的显示形式编辑
会长期保留远端显示名；当前协议不支持有意进行这类大小写、点或分隔符显示改名。
真实新增、删除或替换 tag 身份时仍会发布。

发布脚本只逐条调用：

```text
qiita publish -- <mapped-public-basename>
```

正常入口只对 changed targets 调用，不使用 `publish --all`、`--force`，也没有
删除或撤回步骤。`publishPlanned` 仍作为可注入的底层兼容函数导出，但不再暴露为
`npm` 发布命令，也不被 workflow 使用。

## 自动化顺序

GitHub Actions 使用只读仓库权限。PR 只执行安装、typecheck、测试和 binding
历史校验，不读取 `QIITA_TOKEN`，也不会 pull 或 publish。`main` push 才继续执行：

1. `npm ci`
2. `npm test`
3. 对比对应事件的 base revision 验证 binding 不可变
4. 清空纯生成的 `public/`，再用 `npx --no-install qiita pull --force` 恢复确定的只读远端基线
5. 全量 preflight
6. 单进程 snapshot、生成 ID marker/系列链接/ID 引用，再全量重验
7. 仅逐条发布可发布投影发生变化的明确绑定目标

测试通过注入 runner 验证发布计划，不会调用真实 Qiita 写接口。

## License

[MIT](LICENSE)
