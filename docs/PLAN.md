# Unifire — UniFi 擴充管理平台 實作計畫

## Context

使用者的 UniFi 環境：UDM Pro、UniFi OS 6.0.17、Network **11.0.99**、3 條 WAN、11 個 VPN Client（WireGuard/OpenVPN）、約 31 條 Policy-Based Route。原生 UniFi 有幾件事做不到，例如「路由出口依時段切換」。使用者已在 go-gost 主機上用 Python 腳本加 systemd timer 自行解決（見 `/Users/lizian/Documents/log-server/docs/2026-11-24_unifi-gost-routing-report.md`、`scripts/gost-egress.py`）。

目標：把這類能力做成一套通用、可視化的自架網站 **Unifire**，涵蓋 4 大類共 16 項 UniFi 原生沒有的功能。後台要有接近 UniFi 配色、令人驚艷的 UI/UX，PWA 也要做完整。專案目錄 `/Users/lizian/Documents/unifire` 目前是空的。

## 已確認的決策

| 項目 | 決定 |
|---|---|
| 技術 | Nuxt 4 + TypeScript，後端只用內建 Nitro（不另開 Express） |
| UniFi 環境 | UniFi OS 閘道（UDM Pro），單一控制器；資料模型保留 controllerId/site 擴充性 |
| UniFi 認證 | **只用本機管理員帳密**，走內部 API（cookie + CSRF）。建議另建本機帳號 `unifire`，不用 go-gost 那組 |
| 部署 | Docker（host network）與裸 Node（pm2/systemd）**都支援** |
| 主機位置 | 未定，做成可設定：自動偵測本機 MAC，各網段廣播位址可在設定頁填寫 |
| 後台帳號 | 管理員 + 家人帳號（家人只看自己的裝置與配額、可申請延長）；密碼 + Passkey |
| 通知 | PWA Web Push、Telegram Bot（inline 按鈕）、Discord Webhook、通用 Webhook / ntfy |
| 探測路由 | 同意 Unifire 自動建立與管理 `[unifire-probe]` 前綴的路由 |
| go-gost 路由 | **不碰**。`go-gost hourly egress` 列為外部管理，只讀不寫 |
| 語言 | 繁中 + 英文都完整做（@nuxtjs/i18n） |
| 交付 | 16 項一次全部做完（內部仍按里程碑推進，中途不停下驗收） |
| 分工 | Claude：規劃 + 全部 UI/UX + 覆核；Codex CLI（`gpt-6.2-sol`, xhigh）：調查 + 後端實作 |

## 關鍵技術依據（已核實）

調查報告：`/private/tmp/claude-501/-Users-lizian-Documents-unifire/95c74f3d-1fb1-4dc8-b49b-0d5439f12dda/scratchpad/research/unifi-api-research.md`。以下各點已用使用者實機抓到的資料交叉驗證（`log-server/.local/pbr-gost-*.json`）。

- **路由切換已在實機證實可行**：`PUT /proxy/network/v2/api/site/default/trafficroutes/{_id}` 要帶完整文件，只改頂層 `network_id`。WAN1 ↔ WireGuard client 之間切換已在使用者環境穩定執行 16 次以上。OpenVPN client 尚未實測，要靠能力檢測確認。
- 出口清單來自 `GET /proxy/network/api/s/default/rest/networkconf`：`purpose: "wan"`（`wan_networkgroup` 為 WAN/WAN2/WAN3）以及 `purpose: "vpn-client"`（`vpn_type` 為 wireguard-client 或 openvpn-client）。
- Route 欄位：`_id, description, enabled, matching_target(INTERNET|DOMAIN|IP|REGION), target_devices[{type:CLIENT,client_mac}|{type:NETWORK,network_id}], network_id, next_hop, kill_switch_enabled, domains, ip_addresses, ip_ranges, regions, origin_type(object_pbr = 由 Object 產生，不可直接管), origin_id, predefined`。
- Network 11 的 Object Manager（`v2/.../object-oriented-network-configs`）有 secure 時段，但 **route 沒有時間條件**。這正是 Unifire 要補的缺口。
- Network 11 已移除舊版 `stat/report/*`、`stat/event`。用量統計改由 **Unifire 自行取樣**（每分鐘讀 `v2/clients/active?includeTrafficUsage=true` 算差值，並處理計數器歸零）。另以能力檢測接入新統計引擎 `v2/api/stats/recent/series` 作為補充。事件來源用 WebSocket `wss://…/proxy/network/wss/s/default/events`，加上 `v2/system-log/*`，並有輪詢備援。
- 其他寫入：`cmd/stamgr`（block-sta / unblock-sta / kick-sta）、`cmd/devmgr`（restart、`power-cycle` + `port_idx`）、`rest/wlanconf/{id}`（`x_passphrase`、`enabled`）、`rest/user/{id}`（name、fixed IP）。
- 登入：`POST /api/auth/login` 從回應取 `X-CSRF-Token`，有 `X-Updated-Csrf-Token` 時以它為準。401 時序列化重登一次。連續失敗要退避，因為 5 次失敗會觸發 403/429 鎖定。

## 架構

### 技術選型（版本為 2026-11 npm 最新版）
`nuxt@4.7` · `@nuxt/ui@4.13`（Reka UI + Tailwind v4）· `@nuxtjs/i18n` · `@vite-pwa/nuxt@2`（injectManifest 自訂 SW）· `nuxt-auth-utils@0.6`（sealed session + WebAuthn）· `drizzle-orm` + `better-sqlite3` · `undici`（UniFi HTTP/TLS 與 WebSocket）· `croner`（cron 解析）· `web-push` · `vue-echarts`（熱圖、時間軸、走勢）· `@vue-flow/core`（出口拓撲圖）· `zod`（前後端共用 schema）· `vitest` + `playwright`

### 目錄結構
```
app/            ← Claude：pages, components, layouts, composables, assets/css (design tokens)
i18n/locales/   ← Claude：zh-TW.json, en.json
shared/         ← Claude 先定義：types/*.ts, schemas/*.ts（zod，API 契約，前後端共用）
server/
  api/          ← Codex：REST handlers（依 shared/schemas 驗證）
  unifi/        ← Codex：client.ts（session/CSRF/TLS pin/重登/寫入佇列）, endpoints/*.ts, capabilities.ts, ws.ts, mock/
  engine/       ← Codex：reconciler.ts, samplers/, probes/, rules/, notifiers/, snapshots/, scheduler.ts
  db/           ← Codex：schema.ts（drizzle）, migrations/
  plugins/      ← Codex：engine 啟動、單寫者 lease
tests/          ← Codex：unit + fake-UniFi 整合測試；Claude：Playwright UI 測試
docker/, Dockerfile, docker-compose.yml, ecosystem.config.cjs, deploy/unifire.service
```

### 核心設計：Desired-State Reconciler（整個系統的心臟）
不靠「整點 cron 觸發一次」，而是每 30 秒（以及事件觸發時）計算「此刻應有狀態」，再與 UniFi 實際狀態比對收斂：
- **路由**：每條受管路由的期望出口優先序為 `手動臨時出口 > 健康備援 > 7×24 排程 > 預設出口`。實際值不同才 PUT，寫入後讀回驗證，並記入 switch log。這是 go-gost 腳本邏輯的通用化。
- **封鎖**：期望封鎖集合 = 暫停上網 ∪ 睡覺時段 ∪ 配額超量 ∪ 待審核（嚴格模式）∪ 規則動作。Unifire 只解除自己設下的封鎖，在 UniFi 介面手動封鎖的裝置一律不動。
- 好處：重開機後自動補齊、冪等、可偵測漂移；另有全域 **Dry-run 模式**（相當於腳本的 `--check`）。
- **漂移守衛**：受管路由的來源、目的、kill switch 若被人在 UniFi 介面改掉（比對 fingerprint），立即暫停管理並通知，不硬覆蓋。
- **擁有權**：只寫入 Unifire 建立或明確「認領」的路由。`origin_type=object_pbr`、`predefined` 以及排除清單（go-gost）一律唯讀。稽核若發現某條路由「週期性被外部修改」，加上「疑似外部自動化」標章，並阻擋認領。

### UniFi Client（server/unifi）
沿用 gost-egress.py 已驗證的流程並強化：cookie jar、CSRF 輪替、**憑證指紋 TOFU 釘選**（設定時顯示指紋，由使用者確認；也可上傳 CA PEM）、per-site 寫入 mutex、讀改寫一律先取最新文件並保留未知欄位、HTML/`meta.rc` 錯誤判斷、登入退避。
**能力檢測矩陣**（設定精靈與每次版本變更時跑）：版本、各讀取端點、WebSocket、統計引擎；寫入資格以一條停用狀態的測試路由做 create → read → update → delete 驗證。POST/DELETE 不可用時，退回「請在 UI 手動建立，再由 Unifire 認領」。
**Mock 控制器**：用去識別化的實機資料形狀做 fixtures，開發和測試都不碰正式 UDM。

### 探測路由設計（出口健康 + 實際 IP 驗證）
- **常駐探測路由**：每個出口一條 `[unifire-probe] <出口名>`，來源只限 Unifire 主機 MAC，`matching_target: IP`，目的為探測 IP 池中分配給該出口的專屬 IP（9.9.9.9、8.8.8.8、208.67.222.222、94.140.14.14 等公共 DNS，可設定）。`kill_switch_enabled: true`，出口掛掉時探測必然失敗，不會從預設 WAN 漏出而誤判健康。每 30 秒對所有出口並行量測 TCP/DNS 延遲與丟包。
- **輪替 IP 掃描**：另有一條探測路由指向 `1.1.1.1/1.0.0.1`，依序切換 `network_id`，讀取 `https://1.1.1.1/cdn-cgi/trace` 取得 `ip=`、`loc=`（國家）、`colo=`。每小時或手動跑一輪，以 IP 變化確認新設定已生效。
- Unifire 主機 MAC 自動偵測：用連往 UDM 的本機 IP，在 `stat/sta` 反查。

### 資料模型（SQLite，摘要）
users / passkeys · controller（帳密以 `UNIFIRE_SECRET` AES-256-GCM 加密）· egresses / egress_samples / egress_ip_checks · managed_routes / route_schedules（7×24 grid 或輪替序列 + IANA 時區）/ route_overrides / route_switch_log · people / person_devices · clients（審核狀態、OUI 廠商、首次出現）· blocks（原因、擁有者、到期）· pause_schedules · quotas / usage_minutes（分鐘桶）+ hourly/daily rollups · extension_requests · rules / rule_runs · poe_watchdogs / watchdog_events · guest_wifi · wol_targets · snapshots / snapshot_items（完整文件加密保存，顯示時遮蔽 `x_*` 機密）· audit_events · presence_sessions · notification_channels / push_subscriptions · settings · leases

### API 介面（server/api，皆以 shared/schemas 的 zod 驗證）
auth/*（login、passkey、me）· setup/*（精靈、能力檢測）· controller · dashboard · egresses（含 history、sweep）· probes（provision/cleanup）· routes（UniFi 全部路由 + 受管狀態、adopt）· managed-routes CRUD + schedule、override、preview?hours=48、log · clients（PATCH、block/unblock/kick、usage）· approvals · people（pause、presence）· quotas · extension-requests · rules（test、runs）· watchdogs · guest-wifi（rotate）+ `kiosk/:token`（公開）· wol（wake）· snapshots（diff、restore 支援 dry-run）· audit · reports/isp、reports/usage · presence/timeline · notifications/channels（test）· push/subscribe · users · `me/*`（家人入口）· `events`（SSE 即時推送）

## 16 項功能規格

**路由類**
1. **排程出口**：任一受管路由可套 7×24 出口格或輪替序列（例：00 點固定 WAN1，其餘依序輪替 A、B、C）。整點前 1 秒預先收斂，寫入後讀回確認，留下切換紀錄。提供從輪替序列一鍵產生格子的工具（可重現 go-gost 那 24 格，但不會接管它）。
2. **出口健康偵測與自動備援**：依探測結果（連續 N 次失敗或丟包 ≥ X%），按備援鏈切到下一個健康出口。恢復穩定 M 分鐘後切回，有遲滯避免來回跳動。也會參考 UniFi 回報的 WAN 狀態。
3. **一鍵臨時出口**：例如「改走 Japan 2 小時」，到期由 reconciler 自動回到排程。可從 ⌘K、裝置抽屜、規則動作觸發。
4. **實際出口 IP 驗證**：以輪替掃描取得各出口公網 IP、國家與延遲，顯示在出口卡片和拓撲圖。IP 異常變化時通知。

**存取管控類**
5. **新裝置審核**：WebSocket 事件加輪詢偵測陌生 MAC。模式分「僅通知」與「嚴格（先 block-sta，核准後解除）」。審核卡顯示 OUI 廠商、hostname、AP/port、隨機 MAC 標記。可核准並同時命名、指派人員，或封鎖、忽略。推播與 Telegram 上可直接按按鈕操作。
6. **上網時數／流量配額**：時數以「活躍分鐘」計算（該分鐘流量超過門檻；同一人多台裝置同時上網只算一次）。流量配額可選日、週、月。到 80% 預警，超量依設定執行封鎖、改走指定出口或僅通知。
7. **暫停上網／定時放行**：以人或群組為單位一鍵暫停，可設時長；每週睡覺時段；「再給 30 分鐘」臨時放行，到期恢復。
8. **人員／群組**：多台裝置歸給同一人，上述功能都能以人為單位套用。家人帳號綁定到人員。

**自動化類**
9. **IF-THEN 規則引擎**：觸發（裝置上下線、人員到家或離家、cron、WAN/出口異常、配額事件、新裝置、裝置離線）→ 條件（時段、星期、在家狀態）→ 動作（臨時出口、封鎖/暫停、通知、Webhook、PoE 重啟、SSID 開關、WoL、裝置重啟）。具冷卻時間、試跑、執行紀錄。
10. **PoE 看門狗**：有線裝置由 `stat/sta` 的 `sw_mac/sw_port` 自動帶出交換器 port。以 ICMP（容器內附 ping）或 TCP 探測，連續失敗才觸發，並有冷卻與每日上限。排除 uplink 與非 PoE port，用 `cmd/devmgr power-cycle`。
11. **訪客 Wi-Fi 密碼輪換**：依 cron 產生易讀密碼，取完整 wlanconf 後只改 `x_passphrase` 再寫回。提供公開的 kiosk 頁（帶 token 的網址，顯示大字 SSID、密碼與 QR Code，可放在平板上）。
12. **Wake-on-LAN 排程**：magic packet 送往該網段廣播位址（由 networkconf 子網自動推算，可覆寫）。可依排程或規則觸發。跨 VLAN 需要開放導向廣播，介面會提示。

**維運洞察類**
13. **設定快照、差異比對、回滾**：每日排程、每次 Unifire 寫入前、以及手動觸發快照，涵蓋 trafficroutes、objects、firewall-policies/zones、networkconf、wlanconf、portforward、routing、static-dns、qos、rest/user。語意化 diff（例如「路由 X：出口 A → B」）。可逐項回滾，先 dry-run 顯示將送出的 PUT 再確認。
14. **變更稽核時間軸**：每 5 分鐘比對 fingerprint，產生變更事件；與 Unifire 自己的寫入比對，標註來源是 Unifire 或外部。合併 `system-log` 與 Unifire 動作紀錄，統一成一條時間軸。
15. **長期歷史與 ISP 報告**：資料存在自己的 SQLite，不受 UniFi 保留期限制，也不怕 Network 11 升級清空：出口延遲與丟包、WAN 可用率、裝置用量、測速（能力允許時呼叫 `cmd/devmgr speedtest`）。月報包含可用率、延遲 p50/p95、斷線清單、測速走勢，可直接列印。
16. **在家狀態時間軸**：依人員手機連線判斷，有寬限期避免手機 Wi-Fi 休眠造成誤判。以甘特圖呈現日／週。到家或離家時觸發規則與 Webhook（可給 Home Assistant）。

## UI/UX 設計（Claude 親自設計與實作）

**視覺語言：貼近 UniFi OS Network 9–11**
- Light 模式：頁面底 `#F4F5F6`、卡片白、主色 UniFi 藍 `#006FFF`、文字 `#212327`／次要文字 `#50565E`、邊框 `#DEE0E3`。
- Dark 模式：底 `#131416`、表面 `#1C1E21`／`#232529`、主色 `#4797FF`。
- 狀態色：綠 `#38CC65`、黃 `#F5A524`、紅 `#F03A3E`、VPN 紫 `#8E59FF`。每個出口自動分配一個辨識色，全站一致。
- 字型：Inter + Noto Sans TC，MAC/IP 用 JetBrains Mono（@nuxt/fonts 自託管）。Lucide 細線圖示、8px 圓角、密度偏高的資料表、150–200ms 微動畫，並尊重 `prefers-reduced-motion`。
- 全部以 CSS 變數 token 定義，Nuxt UI 主題客製成 `unifi` 色板。

**版面**：左側 UniFi 式窄圖示欄（可展開或釘選）＋頂列（站點、⌘K 全域指令、即時 WAN 狀態膠囊、通知鈴、使用者）。行動版改為底部分頁列（總覽／裝置／人員／審核／更多）。

**招牌畫面**
- **總覽「出口星圖」**：用 Vue Flow 畫拓撲。左邊人員與裝置，中間受管路由，右邊各 WAN/VPN 出口節點（延遲色環、公網 IP、國旗），作用中的路徑上有流動光點。旁邊是 KPI 與「接下來的切換」時間線（例：15:00 → IEM）。
- **排程編輯器**：7×24 熱圖格，選色票後拖曳塗色；輪替產生器；複製到其他天；「現在」游標；儲存前顯示未來 48 小時預覽與差異；可直接選健康度差的出口時會警示。
- **出口頁**：出口卡片牆（延遲走勢 sparkline、丟包、IP、國家、狀態），點開看歷史圖。
- **裝置**：可篩選的資料表；詳細資訊抽屜分頁（概覽／路由／配額／歷史／事件）。
- **人員**：頭像卡（在家狀態、時數與流量配額圓環、帶時長選項的暫停按鈕）。
- **審核收件匣**：卡片堆疊，支援鍵盤與手機滑動快速決策。
- **規則**：「當…／如果…／就…」的視覺積木編輯器，附試跑與執行紀錄。
- **快照**：時間軸搭配左右對照的語意化 diff，回滾前確認會送出的 PUT。
- **稽核**：統一時間軸，可用篩選 chip 縮小範圍。
- **報告**：ISP 月報，有列印樣式。
- **在家**：甘特時間軸。
- **設定**：控制器連線精靈（憑證指紋確認、能力檢測勾勾矩陣）、探測路由管理、通知管道、使用者。
- **首次啟動精靈**：建立管理員 → 連線 UDM → 能力檢測 → 偵測本機 MAC → 選擇要探測的出口 → 完成。
- **家人入口「我的」**：手機優先，大型配額圓環、「申請延長」按鈕、自己的暫停狀態。
- **Kiosk 頁**：全螢幕訪客 Wi-Fi QR Code，深色大字。

**PWA**
- manifest 含 maskable 圖示、iOS splash、shortcuts（暫停上網、審核新裝置）。
- 自訂 Service Worker：Web Push 加通知 action 按鈕（核准、封鎖、延長）、App Badge 顯示待審數、離線時以快取顯示最後狀態（唯讀）、更新提示 toast、iOS「加入主畫面」引導。
- **前提**：Service Worker 與 Push 都需要 HTTPS。部署時要放在使用者現有的 Nginx 後面（例如 `unifire.ryan-lab.cc` 內網憑證）；app 會信任 `X-Forwarded-*`。

## 分工與 Codex 工作流程

1. 先 `git init`。每個工作包完成並通過覆核後做一次 checkpoint commit，方便審查 Codex 的 diff 與回退。
2. **Claude 先寫契約**：`shared/schemas/*.ts`（zod）與 `shared/types`，作為前後端共同約定；同時寫 design tokens 與 layout。
3. **Codex 工作包**在背景依序執行，Claude 同時用 mock API 做 UI：
   `codex exec -m gpt-6.2-sol -c model_reasoning_effort="xhigh" -s workspace-write -c sandbox_workspace_write.network_access=true -C /Users/lizian/Documents/unifire -o <report.md> "<工作包說明 + 驗收條件>"`
   - WP1 scaffold 後端基礎（db schema/migrations、加密、lease、設定）
   - WP2 UniFi client + 能力檢測 + mock 控制器 + fake-UniFi 測試伺服器
   - WP3 reconciler + 排程／臨時出口／備援 + 探測路由與 IP 掃描
   - WP4 快照、diff、回滾 + 稽核
   - WP5 clients 取樣、用量、配額、審核、暫停、人員、在家
   - WP6 規則引擎 + 通知管道（Web Push、Telegram long-polling、Discord、Webhook/ntfy）+ PoE 看門狗 + 訪客 Wi-Fi + WoL
   - WP7 報告 rollup + SSE + Docker/pm2/systemd 部署檔
4. **Claude 覆核每個工作包**：閱讀 diff、跑 `pnpm typecheck` / `pnpm test`，檢查是否符合契約與安全規則（擁有權、漂移守衛、機密遮蔽）。不合格就把問題清單交回 Codex 修正。
5. Codex 只動 `server/`、`tests/`、部署檔。`shared/` 的變更必須經 Claude 同意，避免和 UI 衝突。

## 實作順序（內部里程碑，不中途停下）
M0 基礎（scaffold、tokens、契約、auth、DB、client、mock、設定精靈）→ M1 路由四項 → M2 快照與稽核（第一次真實寫入之前就要有安全網）→ M3 存取管控四項 + 家人入口 → M4 自動化四項 + 通知 → M5 洞察三項（歷史/報告、在家）→ M6 PWA 打磨、英文翻譯完成、部署檔、文件、實機驗證

## 正式網路安全守則
- 開發與測試一律用 mock／fake 控制器。連實機時預設 **Dry-run**，由使用者在設定頁手動切成寫入模式。
- 實機第一次寫入只對 Unifire 自建的停用測試路由做資格驗證。絕不寫入 go-gost 路由、`object_pbr` 路由、predefined 路由。
- 每次寫入前先快照、寫入後讀回驗證；所有寫入走 per-site 序列化佇列。
- 登入失敗退避，避免觸發 UDM 鎖定。

## 驗證
- **單元測試（vitest）**：排程計算（用 go-gost 的 egress-schedule.json 驗證 24 格結果與 `selected_exit()` 完全一致）、reconciler 優先序與漂移判定、配額活躍分鐘與計數器歸零、規則引擎、diff 與機密遮蔽。
- **整合測試**：fake-UniFi（h3）實作所用端點，跑完整流程：登入與 CSRF、401 重登、路由切換讀回、探測路由建立與清理、封鎖擁有權。
- **UI**：`pnpm dev` 搭配 mock 控制器逐頁實看（light/dark、手機寬度、zh-TW/en），Playwright 跑關鍵流程（設定精靈、排程塗格、審核、暫停）。Lighthouse PWA 檢查；在 HTTPS 下實測推播 action 按鈕。
- **實機（UDM Pro 11.0.99）**：先唯讀連線與能力檢測矩陣 → 建立探測路由並確認各出口延遲與公網 IP → 對一台測試裝置建立受管路由，跑排程整點切換與臨時出口，並用 trace 驗證實際出口 → 確認 go-gost 路由完全沒被動到。
- **部署**：`docker compose up`（host network）與 `node .output/server/index.mjs`（pm2）各跑一次。重啟後確認 reconciler 會自動補齊狀態。
