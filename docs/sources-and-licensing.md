# 来源与授权记录

核查日期：2026-10-08。本文件记录已知来源与目前的许可证状态，不是许可证或授权证明。

## 用户脚本的已知来源

`gxb-helper.user.js` 的 `@author` 保留了两份上游仓库的署名，`@namespace` 沿用 Wu557666 的仓库地址。来源记录如下：

| 上游 | 已署名的来源范围 | 本次核查的文件与版本 |
| --- | --- | --- |
| [Wu557666/gaoxiaobang](https://github.com/Wu557666/gaoxiaobang) | 视频、阅读页面与讨论处理逻辑 | [厦门理工高校邦（视频+页面+讨论区）.js](https://github.com/Wu557666/gaoxiaobang/blob/e7db8b0979ce83292e0cd9c9997a3074f649f481/%E5%8E%A6%E9%97%A8%E7%90%86%E5%B7%A5%E9%AB%98%E6%A0%A1%E9%82%A6%EF%BC%88%E8%A7%86%E9%A2%91%2B%E9%A1%B5%E9%9D%A2%2B%E8%AE%A8%E8%AE%BA%E5%8C%BA%EF%BC%89.js)，提交 `e7db8b0979ce83292e0cd9c9997a3074f649f481`；脚本署名为 `wu某人 (优化 by Assistant)` |
| [Tyrone2333/Gaoxiaobang-Script](https://github.com/Tyrone2333/Gaoxiaobang-Script) | 测验题目与选项 DOM 操作逻辑 | [gxb.js](https://github.com/Tyrone2333/Gaoxiaobang-Script/blob/4c8447ecbb9c0950d3b926b48ceb85bc70985814/gxb.js)，提交 `4c8447ecbb9c0950d3b926b48ceb85bc70985814`；头部记载 `Created by enzo`，元数据署名为 `en20` |

这里的提交号固定本次核查的上游快照，不代表已确认最初整合时使用的精确版本。范围依据现有署名及相应代码功能记录，尚未完成逐段来源比对。

本项目后续加入或修改了 DeepSeek 答题、任务导航、按账号和课程隔离状态、执行控制、Firefox 兼容处理及回归测试等内容，变更可在[本仓库提交历史](https://github.com/xiaoyu884/i-dont-wanna-take-gaoxiaobang/commits/main/)中查阅。这些修改不意味着本项目拥有全部上游代码的权利。

## 上游声明与核查结果

本次检查了两份上游的文件列表、README 和上述脚本。两份仓库均未发现独立的许可证文件，脚本中未发现明确的许可证条款，GitHub API 的 `license` 字段也均为空。API 结果只表示未识别出许可证，不证明不存在其他声明或另行授权。

- Wu557666 的 [README 快照](https://github.com/Wu557666/gaoxiaobang/blob/e7db8b0979ce83292e0cd9c9997a3074f649f481/README.md) 将文件称为“开源”，同时写有“不作商业用途”和“只能用于学习和研究计算机原理”等用途声明。目前未确认这些声明是否足以覆盖本组合脚本的使用、修改、再分发和再许可；不能将其当作 MIT 等标准许可证。
- Tyrone2333 的 [README 快照](https://github.com/Tyrone2333/Gaoxiaobang-Script/blob/4c8447ecbb9c0950d3b926b48ceb85bc70985814/README.md) 提供使用和修改提示；本次检查未发现明确规定使用、修改、再分发及再许可权限的许可证文本。

## 为什么目前没有整体 LICENSE

目前尚未确认覆盖继承代码的适用条款或其他授权，也尚未确定组合脚本可以采用的整体许可证。因此暂未给仓库整体附加 `LICENSE`，也不宣称本仓库已经按某个开源许可证发布。待来源与授权依据明确后，再记录适用许可证、必要声明及其范围；相关工作见[发布蓝图的授权与来源核对](release-blueprint.md#1-授权与来源核对p0并行推进)。

按照 [GitHub 的许可证说明](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/licensing-a-repository)，公开仓库可供其他 GitHub 用户查看和 fork；公开本身不会自动授予通常由开源许可证规定的广泛使用、修改与再分发权限。已有适用条款、另行授权及法律规定仍需分别判断。

署名、来源链接和本说明用于保留来源信息，不替代授权，也不自动解决继承代码的发布权限问题。上游与本项目贡献者的相应权利不因本说明而转移。

## 测试包与第三方依赖

`gxb-tests/package.json` 及锁文件根包中现有的 `license: "ISC"` 字段仅位于测试包元数据中，不是组合用户脚本或仓库整体的许可证。

测试使用 jsdom 及其依赖。各依赖保留自己的许可证，锁文件记录的依赖许可证不为本用户脚本授予许可，也不替代各依赖实际附带的许可证文本与声明。
