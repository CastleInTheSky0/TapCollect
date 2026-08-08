# 贡献指南

## Git 提交信息规范

本项目的提交信息必须同时满足以下标准：

1. 遵循 [Conventional Commits](https://www.conventionalcommits.org/zh-hans/v1.0.0/) 规范。
2. 类型和可选作用域之后的提交描述使用简体中文。

提交格式：

```text
<类型>[可选作用域][!]: <中文描述>
```

常用类型：

- `feat`：新增功能
- `fix`：修复问题
- `docs`：文档调整
- `style`：不影响逻辑的格式调整
- `refactor`：代码重构
- `perf`：性能优化
- `test`：测试调整
- `build`：构建系统或依赖调整
- `ci`：持续集成配置调整
- `chore`：其他维护工作
- `revert`：撤销提交

正确示例：

```text
feat: 支持多任务并发运行
fix(preview): 修复详情页重复打开错误
docs: 更新使用说明
```

错误示例：

```text
支持多任务并发运行
feat: support concurrent task runs
```

存在破坏性变更时，在类型或作用域后添加 `!`，并按需使用
`BREAKING CHANGE:` 补充说明。
