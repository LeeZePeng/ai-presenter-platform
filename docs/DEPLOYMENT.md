# Git 协作与管理台发布

## 安全边界

仓库只保存可复现的源码、锁文件、测试和部署模板。生产 `.env`、SQLite、上传素材、日志、成片、第三方二进制和 `node_modules` 永远留在服务器，不进入 Git。

管理台不会执行管理员输入的 shell 命令。服务端只启动 `DEPLOY_SCRIPT` 指向的固定脚本，并把固定的仓库目录、远程名、分支和目标目录通过服务器环境传入。部署接口受独立管理员会话保护、限制调用频率，并要求明确确认；队列非空时拒绝发布。

## 首次准备

1. 创建私有远程仓库，把本项目推送为 `main`。
2. 在生产 Mac 准备一个只用于拉取代码的 checkout，并配置只读 deploy key 或受限凭据。
3. 确保生产 Mac 可直接执行 Node 22+、pnpm 11、Git、rsync 和 launchctl。
4. 先保持 `DEPLOY_ENABLED=false`，在终端手工执行一次部署脚本并验证回滚与健康检查。
5. 验证无误后填写 `.env` 中的 `DEPLOY_*`，再设置 `DEPLOY_ENABLED=true` 并重启服务。

示例：

```dotenv
DEPLOY_ENABLED=true
DEPLOY_REPO_DIR=/Users/example/ai-presenter-platform-checkout
DEPLOY_REMOTE=origin
DEPLOY_BRANCH=main
DEPLOY_TARGET_DIR=/Users/example/ai-presenter-platform
DEPLOY_SCRIPT=/Users/example/ai-presenter-platform/deploy/deploy-macos.mjs
DEPLOY_PNPM_BIN=/opt/homebrew/bin/pnpm
DEPLOY_LAUNCHD_LABEL=com.ai-presenter.platform
DEPLOY_HEALTH_URL=http://127.0.0.1:4317/api/health
```

## 一次发布

1. 拒绝有排队/运行任务或已有发布进程的请求。
2. `git fetch` 固定远程和分支，解析远程提交。
3. 将该提交导出到临时目录，不修改开发 checkout。
4. 在临时目录执行锁文件安装、类型检查、测试和前端构建。
5. 用硬链接快照保留上一个运行版本，再同步到生产目录；`.env`、`data`、`logs`、`out`、`bin` 和 `vendor` 保持不变。
6. 重启固定 launchd 服务并等待本机健康检查。
7. 健康检查失败时自动恢复上一个快照并再次重启。

管理页显示当前阶段、提交、开始/完成时间和脱敏后的日志尾部。发布记录写到 `DATA_DIR/deployment-state.json` 与 `DATA_DIR/deployment.log`，服务重启后仍可读取。

## 回滚

脚本在覆盖生产目录前创建上一个版本的本地快照；新版本健康检查失败时自动回滚。若发布成功后发现业务问题，应在 Git 中回退对应 PR，合并后再次通过管理页发布，保证仓库历史与线上版本一致。
