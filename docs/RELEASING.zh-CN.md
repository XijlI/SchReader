[English](RELEASING.md) · **中文**

# 发版说明

每次发版会在 GitHub 上放出三个文件：

| 文件 | 由什么构建 |
|---|---|
| `schreader-android-v<版本>.apk` | `android/` + `extension/`（构建时由 `android/tools/mirror.py` 镜像进去） |
| `schreader-chrome-v<版本>.zip` | `extension/` |
| `SHA256SUMS.txt` | 上面两个文件的校验值 |

工作流在 [`.github/workflows/release.yml`](../.github/workflows/release.yml)，
**不需要任何本地机器**：GitHub 负责编译、签名、发布。

## 发一个版本

**方式 A —— 推 tag**（常规）：

```bash
git tag v0.2.0
git push origin v0.2.0
```

**方式 B —— 网页上手动点**（不想碰命令行时）：
GitHub 仓库 → **Actions** → 左边选 **Release** → **Run workflow** → 版本号填 `0.2.0` → **Run**。
这个 tag 不存在的话，工作流会自己创建并推上去。

对同一个版本再跑一次，就是重新构建并覆盖那次 release 的文件 —— 构建坏了的时候很方便。

### 打 tag 之前

`manifest.json` 里的站点名单和 `extension/src/whitelist.js` 里的权威名单不一致时，发版会直接失败：

```bash
python3 .github/scripts/sync_whitelist.py          # 按 JS 里的名单重写 manifest
python3 .github/scripts/sync_whitelist.py --check  # 就是工作流里跑的那条
```

### 版本号怎么定

`v主.次.修订`，每段 0–99。tag 决定一切，不用改任何文件：

- APK 里的 `versionName` = `主.次.修订`
- Android 判断「这是新版」用的 `versionCode` = `主*10000 + 次*100 + 修订`，
  所以 `v0.2.1` → `201`。写 `v0.2` 也认，会自动补成 `0.2.0`。
- `extension/manifest.json` 里的 `version` 是构建时写进去的，**不会提交**，
  所以仓库里的版本号永远不会过期。

安卓只有在 `versionCode` 变大时才肯当升级装。版本号绝不能重复用。

## 一次性设置：签名密钥

安卓不允许「签名不同的 APK」覆盖安装，所以每个 release 必须用**同一把**密钥签名。
这把 keystore 放在仓库**外面**：`C:\Users\i2026\Documents\schreader-signing\schreader-release.jks`，
GitHub 那边以仓库 secret 的形式拿到它。

到 **Settings → Secrets and variables → Actions → New repository secret** 加这四条：

| Secret 名称 | 值 |
|---|---|
| `ANDROID_KEYSTORE_BASE64` | `schreader-release.jks.b64` 那整行内容（一行，5912 个字符） |
| `ANDROID_KEYSTORE_PASSWORD` | 密钥库密码 |
| `ANDROID_KEY_ALIAS` | `schreader` |
| `ANDROID_KEY_PASSWORD` | 跟密钥库密码一样 |

四个值都写在 `C:\Users\i2026\Documents\schreader-signing\SECRETS.txt` 里，直接复制粘贴。

> **这个文件夹要备份。** keystore 丢了，装了旧版 APK 的人就永远收不到更新 ——
> 只能先卸载再装。拷一份到 U 盘或密码管理器里。

没有配置 secret 时构建仍然会成功，但会打印 `::warning::` 并改用一次性的 CI 调试密钥签名；
那种 APK 装不上去了旧版本的手机。

## 发版说明（Release notes）

由 [`.github/scripts/release_notes.py`](../.github/scripts/release_notes.py) 生成：
英文正文在前，可折叠的「中文说明」在最后。改动清单是拿上一个 `v*` tag 之后的提交
（按 `feat:` / `fix:` 这类前缀分组）自动列的。

想手写就提前放文件：

```
docs/release-notes/v0.2.0.md         # 替换英文正文
docs/release-notes/v0.2.0.zh-CN.md   # 替换中文部分
```

## 在本机复现一次 release

跟 CI 完全一样的步骤：

```bash
cd android
export NV_KEYSTORE_FILE='C:/Users/i2026/Documents/schreader-signing/schreader-release.jks'
export NV_KEYSTORE_PASSWORD="$(cat /c/Users/i2026/Documents/schreader-signing/.storepass)"
export NV_KEY_ALIAS=schreader
export NV_KEY_PASSWORD="$NV_KEYSTORE_PASSWORD"
python3 tools/mirror.py
sh gradlew assembleRelease -PappVersionName=0.2.0 -PappVersionCode=200
```

产物：`android/app/build/outputs/apk/release/app-release.apk`。
平时 `build.cmd` / `assembleDebug` 那些日常构建完全不受影响 —— release 构建在没有
`NV_*` 变量时会退回调试密钥。

不想用环境变量就建 `android/keystore.properties`（已被 git 忽略）：

```properties
storeFile=C:/Users/i2026/Documents/schreader-signing/schreader-release.jks
storePassword=...
keyAlias=schreader
keyPassword=...
```

## 出问题时

| 现象 | 原因 / 处理 |
|---|---|
| 手机上 `INSTALL_FAILED_UPDATE_INCOMPATIBLE` | 新 APK 的签名和手机里那个不一样。检查那四个 secret；如果从来没配过，先卸载一次。v0.1.0 之前的调试版 APK 用的是本机调试密钥，所以**第一个**发布版 APK 需要卸载一次（App 里的收藏会跟着丢）。 |
| 工作流卡在 "Set up the Android SDK" | 工作流里写的 `platforms;android-36` / `build-tools;36.0.0` 上游没了 —— 改 `packages:` 那行。 |
| `./gradlew` 报 `Permission denied` | wrapper 的可执行位没进仓库；工作流里已经先 `chmod +x gradlew`，本地也一样处理，或用 `sh gradlew`。 |
| release 正文显示 "_No commit messages…_" | 上一个 tag 太远或历史是浅克隆（必须 `fetch-depth: 0`）。 |
| 扩展 zip 加载不了 | Chrome 要的是**解压后直接含 `manifest.json` 的那个文件夹**，不是 zip，也不是它的上一层。 |
