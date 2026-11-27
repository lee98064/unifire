# Unifire

自架的 UniFi Network 擴充管理台，補上 UniFi 原生沒有的功能，包括依時段切換出口、出口健康備援、上網配額、新裝置審核、規則引擎、設定快照與回滾、設備長期健康、線材守衛、PoE 排程、房間級在家、事故關聯等。介面配色貼近 UniFi OS，支援 PWA、繁中與英文。

> A self-hosted companion console for UniFi Network (UniFi OS gateways). It adds what UniFi doesn't have: time-scheduled per-device egress routing, egress health failover, quotas, device approval, an IF-THEN rule engine, config snapshots with rollback, long-term device health, cable/port guard, PoE schedules with an energy ledger, room-level presence and incident correlation. UI in Traditional Chinese and English, installable as a PWA.

---

## 功能

### 路由與出口
- **排程出口**：受管路由可以套用 7×24 出口格或輪替序列，例如 00 點固定走 WAN1，其他時段輪流走幾條 VPN。整點前預先收斂，寫入後讀回確認，並記錄每次切換。
- **出口健康偵測與自動備援**：每個 WAN／VPN 出口都有專屬探測路由，連續失敗或丟包時依備援鏈切換，恢復時有遲滯，避免來回跳。
- **一鍵臨時出口**：例如「改走 Tokyo 兩小時」，時間到自動回到排程。可以從 ⌘K、裝置抽屜或規則動作觸發。
- **實際出口 IP 驗證**：輪流掃描每個出口的公網 IP、國家與延遲，IP 異常變化時通知。

### 存取管控
- **新裝置審核**：模式分「僅通知」和「嚴格」（先封鎖，核准後才放行），可以在推播或 Telegram 上直接核准或封鎖。
- **上網時數與流量配額**：以「活躍分鐘」計算，同一人多台裝置同時上網只算一次。可設日、週、月配額，超量時可以封鎖、改走指定出口或只通知。
- **暫停上網與定時放行**：以人或群組為單位，支援睡覺時段，也能臨時「再給 30 分鐘」。
- **人員與群組**：把多台裝置歸給同一人；家人帳號只能看到自己的配額，並可以申請延長。

### 自動化
- **IF-THEN 規則引擎**：觸發、條件、動作可以自由組合，有冷卻時間、試跑和執行紀錄。
- **PoE 看門狗**：裝置沒有回應時，自動斷電重啟它所在的交換器 port，並有冷卻時間和每日上限。
- **訪客 Wi-Fi 密碼輪換**：定期更換密碼，並提供可以放在平板上的 QR Code kiosk 頁。
- **Wake-on-LAN 排程**。

### 維運洞察
- **設定快照、語意化差異比對、逐項回滾**：回滾前會先 dry-run，顯示將送出的 PUT。
- **變更稽核時間軸**：分辨每筆變更是 Unifire 做的還是外部做的。
- **長期歷史與 ISP 月報**：資料存在自己的 SQLite，不受 UniFi 保留期限制。
- **在家狀態時間軸**。

### 設備維運（交換器與 AP）
- **設備總覽與長期健康**：CPU、記憶體、溫度、uptime、韌體、可用率。分辨非預期重開機和 Unifire 自己發起的重啟，支援閃燈定位與遠端重啟。
- **線材與埠健康守衛**：仿實機的交換器面板圖，偵測降速（例如 1G 掉到 100M）、錯誤率偏高、反覆斷線和陌生裝置，每個 port 都有完整歷史。
- **PoE 排程與電力帳本**：依時段開關 PoE，採期望狀態式收斂，只恢復 Unifire 自己關掉的 port。有寫入驗證、漂移時自動暫停並通知，並記錄各 port 的用電與省下的電費。
- **即時拓撲**：從出口、閘道、交換器、AP 一路畫到每個人的裝置，標示速率與流量，並自動找出瓶頸。
- **房間級在家與漫遊軌跡**：把 AP 指派到房間，推算每個人目前在哪個房間；記錄每台裝置在 AP 之間的漫遊，偵測黏滯裝置。
- **事故關聯**：把同一時段、拓撲上相關的異常合併成一起事故，推測根因，並列出事故前 15 分鐘內的設定變更，連到快照差異。計畫性 PoE 斷電不算事故。
- **設備可用率月報**。

## 安全設計

Unifire 直接寫入正式網路，所以預設保守：

- **Dry-run 預設開啟**：新連線的實體控制器只會記錄「會做什麼」，要由管理員手動切到寫入模式。
- **單一寫入閘道**：所有 UniFi 寫入都經過同一道 gate，依站點序列化，寫入前拍快照、寫入後讀回驗證，並留下稽核紀錄。
- **擁有權**：只寫入 Unifire 建立或明確認領的路由。由 Object 產生的路由、預設路由和排除清單一律唯讀。PoE 只恢復 Unifire 自己關掉的 port，在 UniFi 中被手動關掉的永遠不碰。
- **漂移守衛**：受管的路由或 PoE port 被人在 UniFi 介面改掉時，暫停管理並通知，不會硬改回來。
- **寫入資格驗證**：路由用一條停用的測試路由驗證，PoE 由管理員挑一個 port 做開關驗證，通過才允許真正寫入。
- **PoE 安全規則**：不准斷電的 port 包括上連埠、後面還有其他 UniFi 設備的 port、Unifire 主機所在的 port，以及通往閘道路徑上的 port。關閉 AP 的供電需要明確確認。
- **連線與機密**：控制器憑證指紋採 TOFU 釘選；帳密與快照以 AES-256-GCM 加密存放；回傳給介面的資料會遮蔽 `x_*` 機密欄位。
- **單一寫入者**：以 SQLite lease 確保同一份資料只有一個程序在跑引擎。

## 技術架構

| 層 | 技術 |
| --- | --- |
| 前端 | Nuxt 4、Nuxt UI 4（Reka UI + Tailwind v4）、ECharts、Vue Flow、@nuxtjs/i18n、@vite-pwa/nuxt |
| 後端 | Nitro（node-server），沒有另外的 Express |
| 資料 | SQLite（better-sqlite3、WAL）+ Drizzle ORM，啟動時自動執行 migration |
| UniFi | 內部 API（本機管理員、cookie + CSRF）、WebSocket 事件、undici |
| 其他 | zod（前後端共用契約）、croner、web-push、vitest、Playwright |

核心是一個 **desired-state reconciler**：不靠「時間到觸發一次」，而是週期性地，以及事件發生時，計算「此刻應有的狀態」，再和 UniFi 的實際狀態比對收斂。這樣重開機後會自動補齊，操作具冪等性，也能偵測漂移。路由、封鎖、PoE 都用同一套模式。

```
app/            前端：pages、components、composables、設計 token
i18n/locales/   zh-TW.json、en.json
shared/         API 契約（shared/api.ts）與 zod schema，前後端共用
server/
  api/          REST handlers（依 shared/schemas 驗證）
  unifi/        UniFi client、寫入閘道、能力檢測、mock 控制器
  engine/       reconciler、探測、規則、通知、快照、設備／埠／PoE／拓撲／房間／事故
  services/     控制器 runtime、快取、設定、存取管控
  db/           Drizzle schema 與內嵌 migration
tests/          vitest 單元與整合測試、HTTP 契約煙霧測試、去識別化的實機資料 fixture
deploy/         systemd unit、Nginx 範例
docs/           規劃、部署、UniFi API 調查與實機欄位形狀
```

## 系統需求

- UniFi OS 閘道（UDM、UDM Pro、UCG、UXG 等）。目前在 **UDM Pro、UniFi OS 6.0.17、Network 11.0.104** 上驗證過。
- 在 UniFi OS 建立一個**專用的本機管理員帳號**給 Unifire 使用，不要用個人帳號或其他自動化共用的帳號。
- 一台能連到閘道的主機，需要 Docker，或 Node.js 22 加 pnpm 10。
- PWA、Web Push 和 Passkey 需要 **HTTPS**，建議放在反向代理（例如 Nginx）後面。

## 快速開始：本機開發（mock 控制器）

不需要真的 UniFi 設備。內建的 mock 控制器模擬了一整套閘道、交換器、AP、VPN 與用戶端。

```sh
corepack enable
pnpm install
NUXT_MOCK_CONTROLLER=true NUXT_DATA_DIR=./.data-dev pnpm dev
```

打開 http://localhost:3000，依首次啟動精靈建立管理員即可。

如果 `pnpm dev` 遇到檔案監看上限（`EMFILE`），可以改用 build 後的版本：

```sh
pnpm build
NUXT_MOCK_CONTROLLER=true NUXT_DATA_DIR=./.data-dev NUXT_SESSION_COOKIE_SECURE=false node .output/server/index.mjs
```

在 mock 模式下，管理員可以呼叫 `POST /api/dev/mock/:scenario` 製造情境，方便開發與展示。可用的情境：`reboot-ap`、`offline-switch`、`config-then-outage`、`recover`、`downgrade-port`、`port-errors`、`flap-port`、`new-device`、`roam`、`sticky`、`overheat`、`firmware-available`。

## 部署

完整步驟（Docker Compose、systemd、PM2、Nginx、HTTPS、首次連線、Dry-run 轉 Live、備份與升級）都在 **[docs/DEPLOY.md](docs/DEPLOY.md)**。

最簡單的方式：

```sh
sudo install -d -m 0700 -o 1000 -g 1000 data
docker compose up -d --build
curl --fail http://127.0.0.1:3000/api/health
```

常用環境變數：

| 變數 | 用途 |
| --- | --- |
| `PORT` / `NITRO_HOST` | 監聽的連接埠與位址（放在反向代理後時建議 `127.0.0.1`） |
| `NUXT_DATA_DIR` | SQLite、加密金鑰與 session 金鑰的存放位置 |
| `NUXT_UNIFIRE_SECRET` | 加密金鑰，不提供時自動產生 `secret.key` |
| `NUXT_SESSION_PASSWORD` | Session 金鑰，不提供時自動產生 `session.key` |
| `NUXT_TRUST_PROXY` | 信任反向代理的 `X-Forwarded-*` 標頭 |
| `NUXT_MOCK_CONTROLLER` | `true` 時使用內建 mock 控制器（只限開發與測試） |

> 備份時請連同資料目錄內的金鑰一起保存，少了加密金鑰就無法還原控制器帳密與快照。

## 開發

```sh
pnpm typecheck      # nuxt typecheck（vue-tsc）
pnpm test           # vitest 單元與整合測試（使用 fake UniFi，不會碰實機）
pnpm test:contract  # 對執行中的伺服器跑 HTTP 契約煙霧測試，例如 pnpm test:contract http://127.0.0.1:3000
pnpm build          # 正式建置（也會抓到 vue-tsc 漏掉的模板錯誤）
```

- `shared/api.ts` 是唯一的 API 契約來源，每個端點都有 method、路徑、權限和輸入輸出的 zod schema。
- 伺服器端產生的使用者可見文字一律使用 i18n key，並登錄在 `docs/backend/i18n-keys.md`。翻譯放在 `i18n/locales/`。
- `scripts/capture-wire.ts` 可以唯讀、去識別化地擷取實機的 UniFi 欄位形狀，用來更新 fixture 與 mock。說明見 [docs/backend/capture-wire.md](docs/backend/capture-wire.md)。

## 文件

| 文件 | 內容 |
| --- | --- |
| [docs/PLAN.md](docs/PLAN.md) | 第一階段規劃：路由、存取管控、自動化、洞察 |
| [docs/PLAN-infra.md](docs/PLAN-infra.md) | 第二階段規劃：交換器與 AP 的設備維運 |
| [docs/DEPLOY.md](docs/DEPLOY.md) | 部署、HTTPS、升級與備份 |
| [docs/unifi-api-research.md](docs/unifi-api-research.md) | UniFi API 調查（端點、payload、陷阱） |
| [docs/unifi-wire-shapes.md](docs/unifi-wire-shapes.md)、[docs/unifi-wire-shapes-infra.md](docs/unifi-wire-shapes-infra.md) | 實機擷取（去識別化）的欄位形狀 |
| [docs/backend/i18n-keys.md](docs/backend/i18n-keys.md) | 伺服器端 i18n key 登錄表 |
| [docs/codex/](docs/codex/) | 各工作包的實作規格 |

## 已知限制

- Unifire 使用 UniFi 的**內部 API**。Network 改版時欄位或端點可能變動，升級 Network 後請在「設定 → UniFi 控制器」重新執行能力檢測。
- 目前一個 Unifire 只管理一個控制器、一個站點。
- 路由出口切換已在實機驗證。PoE 寫入在每個 Network 版本上都要先通過寫入驗證才會真正執行。
- Network 11 的 WebSocket 不會送出漫遊事件，所以漫遊是從用戶端同步與每分鐘輪詢推算的。

## 授權

目前為私人專案，尚未指定授權條款。
