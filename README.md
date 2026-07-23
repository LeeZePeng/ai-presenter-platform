# AI 口播工厂

完整的架构、接口、配置、部署、运维、备份与故障排查说明见 [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md)。

面向 AI 数字人口播的任务网站。用户可以按主题创作、提交已有文案或上传视频复刻；服务负责排队、按小时启停 CompShare GPU、调用 Codex CLI 编排 `ai-presenter-video-replica` skill，并提供进度、日志和成片下载。

## 核心流程

```text
Web 表单 / 文件上传
        ↓
SQLite 持久化队列
        ↓
复刻任务先用 ModelVerse whisper-1 完成带时间戳 ASR
        ↓
转写通过 → 启动 CompShare 实例
        ↓
等待 Running + 数字人 API 健康检查
        ↓
Codex CLI + gpt-5.6-sol + AI 口播 skill
        ↓
锁定最终旁白 → 逐句时间轴 → InfiniteTalk → Remotion
        ↓
成片 / 标题 / 描述 / 封面
        ↓
每个一小时时间片边界：队列为空则关机，否则顺延一小时
```

## 功能

- 三种创建模式：主题创作、已有文案、复刻视频。
- 支持粘贴 YouTube 单条视频链接直接导入，也可按关键词、发布时间和授权类型搜索热门视频，按播放量与日均播放速度排序后“一键导入并复刻”。
- 形象和参考声音可在首次提交任务时保存为个人素材；后续复刻直接从形象库、声音库选择，任务会复制一份素材快照，避免以后修改素材影响历史任务。
- 复刻视频默认使用“完整复刻”。“精简复刻”支持 5 秒起的任意目标时长，允许删除次要观点、案例、展开论据和支线；保留核心主题、关键论点、完整开场与结束语，已保留内容仍按原片顺序和视觉语言复刻。
- 复刻任务在开数字人 GPU 前优先由 ModelVerse `whisper-1` 转写原片，并将带时间戳结果锁定给后续文案与语义选片使用；云端失败时自动切换 Mac Metal whisper.cpp。
- 先生成并锁定唯一最终旁白，再从这条音频生成逐句时间轴；字幕、PPT、卡片和原片镜头都按 3-8 秒语义 cue 对齐，禁止使用 InfiniteTalk 分段作为视觉切换点。
- 人物图片、参考视频、参考声音上传与权限确认。
- 普通生成任务无需填写目标时长，由 AI 按内容自动规划自然时长，平台上限为 120 秒。
- 完整 MP3/WAV/M4A 可直接作为最终口播，视频按真实音频时长生成，最长 180 秒；参考音色模式限制为 5-30 秒。
- 单 worker 有序队列，任务状态在服务重启后自动恢复。
- 失败/取消任务可从用户端或管理端重新入队；素材和已完成的数字人分段检查点会复用。若成片、封面和清单已经存在但最终验收失败，重试会复制完整发布包，只修清单或验收问题，不重新 TTS、生成口型或渲染 Remotion。
- CompShare `DescribeCompShareInstance`、`StartCompShareInstance`、`StopCompShareInstance` 控制。
- 实例显示运行但数字人服务连续无响应时，任务启动前自动重启实例一次。
- 按首个启动请求建立一小时计费窗口，只在窗口边界检查关机。
- Codex JSONL 事件解析、进度展示、超时和取消。
- InfiniteTalk 回执和真实口型成片硬验收，禁止静态图片动画降级为成功任务。
- InfiniteTalk 使用 OOM 安全尺寸生成；真人主画面完成口型后用 `4xNomosWebPhoto_RealPLKSR` 分块 AI 高清化，再按人物原图画布或所选画幅精确导出。
- 超过 20 秒的口播按约 19.5 秒分段；`AI_PRESENTER_GPU_WORKERS=4` 时在 4 张卡上并行、同一卡内串行。每段独立保存 MP4 和回执，失败重试只补未完成分段。生产档使用 `blocks_to_swap=0`、10 秒轮询和 240 次上限，减少 CPU/GPU 搬运并保留 40 分钟单段等待窗口。
- 最终成片默认使用 Remotion 组合真实口型人物、原片录屏/产品画面、信息卡和章节进度；禁止整段退化为单一全屏口播。
- 16:9 复刻在原片没有明确人物布局时，默认使用不遮挡 UI 的圆形头肩数字人 PIP。
- UI 文字只使用已核对文案或原片内容，图片/视频生成模型不得绘制文字，避免乱码和字幕错位。
- 成功任务同时生成发布标题、发布描述和与成片同画幅的 Remotion 封面，可在任务详情预览和下载。
- 用户时间线只展示 assistant 自然语言进展和产品级里程碑，不显示 Codex 工具命令；管理员保留完整脱敏日志。
- 时间线当前步骤显示加载动画，已完成步骤显示绿色勾，告警和失败分别使用黄色、红色状态。
- 进度探测兼容 Skill 产出的连字符/下划线 Remotion 文件名和 `out/remotion/public` 人物素材，避免实际已渲染但页面仍停在“生成数字人”。
- 用户端与 `/admin` 管理端使用独立 HttpOnly 会话认证。
- 管理端监控实例、计费时间片、24 小时请求、队列、成功率、失败和执行日志。
- 管理员可取消请求，并在无活动任务时手动启停实例。
- 管理台提供受保护的一键发布：只从固定远程 `main` 部署，队列非空时拒绝，发布前自动安装、类型检查、测试、构建和备份，健康检查失败自动回滚。
- 私有 Git 仓库、功能分支、Pull Request、CI 和分支保护协作流程；生产密钥、数据库、素材、日志和本机二进制不进入版本控制。
- 上传类型/大小限制、速率限制、日志脱敏。
- 默认模拟 GPU 和 Codex，防止开发阶段产生费用。

## 本地启动

```bash
cp .env.example .env
pnpm install
pnpm run build
pnpm start
```

打开用户工作台 `http://localhost:4317`，管理台为 `http://localhost:4317/admin`。默认：

```dotenv
MOCK_GPU=true
MOCK_CODEX=true
```

模拟模式会真实执行队列、计费窗口和 MP4 下载流程，但不会访问收费实例或模型。

开发模式：

```bash
pnpm run dev
```

前端为 `http://localhost:5173`，API 为 `http://localhost:4317`。

## 生产配置

所有密钥必须放在服务器环境文件，禁止写入仓库：

```dotenv
HOST=127.0.0.1
PORT=4317
DATA_DIR=/var/lib/ai-presenter/data
APP_ACCESS_TOKEN=<random-access-token>
ADMIN_ACCESS_TOKEN=<different-random-admin-token>
SESSION_COOKIE_SECURE=true
JOBS_ENABLED=true

MOCK_GPU=false
MOCK_CODEX=false

COMPSHARE_PUBLIC_KEY=<public-key>
COMPSHARE_PRIVATE_KEY=<private-key>
COMPSHARE_INSTANCE_ID=uhost-xxxx
COMPSHARE_REGION=cn-wlcb
COMPSHARE_ZONE=cn-wlcb-01

GPU_HEALTH_URL=http://<digital-human-host>:7860/
AI_PRESENTER_API_URL=http://<digital-human-host>:7860
AI_PRESENTER_COMFY_URL=http://<digital-human-host>:8188
AI_PRESENTER_GPU_WORKERS=4
ASR_PROVIDER=modelverse
ASR_CLOUD_BASE_URL=https://api.modelverse.cn/v1
ASR_CLOUD_MODEL=whisper-1
ASR_LOCAL_FALLBACK=true
ASR_CACHE_DIR=/var/lib/ai-presenter/data/asr-cache
ASR_BIN=/var/lib/ai-presenter/runtime/whisper/whisper-cli
ASR_MODEL=/var/lib/ai-presenter/runtime/whisper/ggml-small.bin
ASR_LANGUAGE=auto
ASR_THREADS=8
ASR_USE_GPU=true
ASR_TIMEOUT_MINUTES=120
REMOTION_RUNTIME_DIR=/var/lib/ai-presenter/runtime/remotion
REMOTION_BROWSER_EXECUTABLE=/usr/lib64/chromium-browser/headless_shell
CJK_FONT_PATH=/usr/share/fonts/google-noto-cjk/NotoSansCJK-Regular.ttc

CODEX_MODEL=gpt-5.6-sol
CODEX_REASONING_EFFORT=xhigh
CODEX_MODEL_PROVIDER=modelverse
CODEX_BIN=/usr/bin/codex
CODEX_PROXY_URL=
CODEX_PROXY_CONFIG_PATH=/etc/mihomo-ai-presenter/config.json
CODEX_PROXY_GROUP=CODEX
CODEX_PROXY_PROBE_TIMEOUT_SECONDS=10
CODEX_SANDBOX_MODE=danger-full-access
CODEX_EPHEMERAL=true
AI_PRESENTER_SKILL_PATH=/var/lib/ai-presenter/.codex/skills/ai-presenter-video-replica

MODELVERSE_API_KEY=<modelverse-key>

# 可选：配置后关键词搜索使用 YouTube Data API；未配置时使用 yt-dlp 搜索
YOUTUBE_API_KEY=
YTDLP_BIN=/usr/local/bin/yt-dlp
FFMPEG_BIN=/usr/local/bin/ffmpeg
YOUTUBE_PROXY_URL=
YOUTUBE_MAX_DURATION_MINUTES=30
```

YouTube 导入只接受 `youtube.com` 和 `youtu.be` 的单条公开视频链接。部署时安装经过官方 SHA-256 校验的 `yt-dlp`：

```bash
sudo bash deploy/install-ytdlp.sh
```

`YOUTUBE_API_KEY` 不是直接链接导入的前置条件；配置后，关键词搜索会使用 YouTube Data API 获取准确的发布日期、播放量、时长和 Creative Commons 授权信息。未配置时会自动使用 `yt-dlp` 搜索，授权状态不明确的结果会在界面标记为“需确认授权”。不论来源如何，用户必须先确认拥有下载和改编权，平台才会导入原片。

查询账号中的 CompShare 实例：

```bash
COMPSHARE_PUBLIC_KEY="..." COMPSHARE_PRIVATE_KEY="..." \
  npx tsx scripts/list-compshare-instances.ts
```

输出只包含实例 ID、名称、状态、GPU 型号和小时价格，不输出凭据。

## Codex + 低成本单会话模型

worker 执行：

```bash
codex exec --json --ephemeral \
  --model gpt-5.6-sol \
  --sandbox danger-full-access \
  --cd <job-workspace> \
  --add-dir <skill-path> -
```

ModelVerse 的 `gpt-5.6-sol` 支持 Responses API，作为单会话 agentic 模型负责整条视频生产和视觉自检。生产环境使用 Codex CLI `0.144.4` 或更高版本，通过 `/usr/bin/codex` 调用。模型供应商配置保留在服务账户的 `$CODEX_HOME/config.toml` 中，也可直接部署 [`deploy/codex-modelverse.toml`](deploy/codex-modelverse.toml)：

```toml
model = "gpt-5.6-sol"
model_provider = "modelverse"
disable_response_storage = true

[model_providers.modelverse]
name = "ModelVerse"
base_url = "https://api.modelverse.cn/v1"
wire_api = "responses"
env_key = "MODELVERSE_API_KEY"
```

API key 只从 systemd 环境中的 `MODELVERSE_API_KEY` 读取，不写入 Codex 配置。Codex 使用 `danger-full-access` 是为避开部分云内核不支持 Landlock 的问题；进程仍受非 root 服务账户和 systemd 的 `ProtectSystem`、`ProtectHome`、`ReadWritePaths` 约束。

若服务器改用 ChatGPT/Codex 登录而不是自定义模型 API，移除 `CODEX_MODEL_PROVIDER`，保留 `CODEX_MODEL=gpt-5.6-sol` 和 `CODEX_REASONING_EFFORT=xhigh`，并设置 `CODEX_PROXY_URL=http://127.0.0.1:7890`。每个口播任务启动 Codex 前，worker 会通过 Mihomo controller 只扫描名称标记为美国的节点，并锁定首个能返回 Codex JSON 接口的节点；全部失败时任务会提前失败，不降级到其他地区。该代理仅注入 Codex 主进程；Codex 启动的 TTS、InfiniteTalk、FFmpeg 等工具子进程会剔除代理变量，继续使用服务器直连网络。

生产 worker 还要求 Python 3.11、FFmpeg 和 whisper.cpp。whisper.cpp 是 ModelVerse 不可用时的本机 Metal 兜底：

```bash
sudo bash deploy/install-whisper-runtime.sh
```

复刻任务只有在 `out/analysis/source_transcript.json` 成功生成并锁定 SHA-256 后才会启动 GPU。20 秒以内任务通过 `infinite_talk_api.py submit` 生成；更长任务通过 `segmented-submit` 在配置的 GPU worker 间并行、并保存可恢复检查点。云端只暴露原有 `7860/8188` 两个入口，`/w1`、`/w2`、`/w3` 由路径路由到其他卡，避免增加公网端口。单段或分段缺少 InfiniteTalk MP4/原始回执都会标记失败，不允许静态图缩放、平移或假嘴型降级。

完整复刻会读取原片实测时长，当前支持最长 30 分钟，不会继承旧版 120 秒摘要上限。worker 只对完整复刻验收原文覆盖率；精简复刻只验收最终保留内容的原片依据和顺序。两种模式都会验收最终旁白时长、逐句视觉 cue、数字人分段独立性、封面尺寸和发布文案完整性。

云端 Remotion 固定为 `3.3.95`，以兼容 Alibaba Linux 3 的 glibc 2.32。部署后以 root 运行一次：

```bash
bash deploy/install-remotion-runtime.sh
```

该脚本安装 Headless Chromium、Noto CJK 字体和共享 Remotion runtime。worker 不在每个任务里执行 `npm install`，也不允许 Remotion 失败后用 FFmpeg drawtext/drawbox 降级交付。

## 一小时电源策略

1. 新任务写入 SQLite；复刻任务优先通过 ModelVerse 完成 ASR，失败时回退本机 Metal，主题/文案任务可直接进入下一步。
2. ASR 成功或无需 ASR 后触发 `ensureRunning()`。
3. 实例为 `Stopped` 时调用启动 API，并记录 `billing_window_started_at`。
4. `next_power_check_at = started_at + 1 hour`。
5. 到达边界时，如果存在 `pending`、`provisioning` 或 `running` 任务，顺延一小时。
6. 如果队列为空且实例为 `Running`，调用关闭 API并清除时间窗。
7. 任务与关机检查共享串行锁；关机过程中进入的新任务会等待并重新启动实例。

## ECS 部署

Ubuntu、Alibaba Cloud Linux、Rocky Linux 等服务器：

```bash
sudo bash deploy/bootstrap-linux.sh
sudo rsync -a --delete --exclude node_modules --exclude data ./ /opt/ai-presenter-platform/
cd /opt/ai-presenter-platform
sudo npm ci --omit=dev
sudo chown -R presenter:presenter /opt/ai-presenter-platform

sudo install -m 600 -o presenter -g presenter .env.production /etc/ai-presenter-platform.env
sudo install -m 644 deploy/ai-presenter.service /etc/systemd/system/ai-presenter.service
sudo install -m 644 deploy/nginx.conf /etc/nginx/conf.d/ai-presenter.conf
sudo rm -f /etc/nginx/conf.d/default.conf

sudo systemctl daemon-reload
sudo systemctl enable --now ai-presenter nginx
```

### HTTPS

当前部署使用 Let’s Encrypt 的 6 天短期 IP 证书。首次签发需先让 80 端口的 `/.well-known/acme-challenge/` 指向 `/var/www/acme`：

```bash
sudo /opt/certbot/bin/certbot certonly --webroot \
  --webroot-path /var/www/acme \
  --ip-address 47.116.201.223 \
  --preferred-profile shortlived \
  --key-type ecdsa --non-interactive --agree-tos \
  --register-unsafely-without-email

sudo install -m 644 deploy/certbot-renew.service /etc/systemd/system/
sudo install -m 644 deploy/certbot-renew.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now certbot-renew.timer
```

部署 `deploy/nginx.conf` 后，HTTP 自动跳转到 HTTPS。域名部署应把 `server_name` 和证书路径替换为域名，并使用普通 Let’s Encrypt 证书。

同时需要把口播 skill 安装到服务账户的 Codex 目录，并配置 Codex 模型供应商：

```text
/var/lib/ai-presenter/.codex/config.toml
/var/lib/ai-presenter/.codex/skills/ai-presenter-video-replica/SKILL.md
```

## 验证

```bash
pnpm run typecheck
pnpm test
pnpm run build
pnpm audit --audit-level=high
curl http://127.0.0.1:4317/api/health
```

多人协作和管理台发布的首次配置、权限边界与回滚流程见 [`CONTRIBUTING.md`](CONTRIBUTING.md) 和 [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md)。

当前测试覆盖表单约束、完整/精简复刻、公开事件过滤、ASR、重试检查点、提示词契约、成片验收和 GPU 时间片状态机。生产发布前应先保持 `MOCK_CODEX=true` 验证真实 CompShare 启停，再单独关闭 Codex 模拟。
