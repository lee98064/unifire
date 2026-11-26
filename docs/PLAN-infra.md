# Unifire 第二階段：設備維運（交換器／AP）實作計畫

## Context

Unifire 第一階段的 16 項功能（WP1–WP7）已完成，正式部署在 192.168.31.165，以 live 模式連著 UDM Pro（Network 11.0.104）。第一階段的重心是「路由／出口／存取管控」。使用者的 UDM 底下其實還接了多台 **UniFi 交換器與 AP**，但 Unifire 目前只每 60 秒讀一次 `stat/device`，而且只用在兩個地方：WAN 狀態（`server/unifi/wan.ts`）和 PoE 看門狗（`server/unifi/poe-ports.ts`）。沒有任何設備頁面、設備歷史、拓撲或埠資訊。

使用者選定 6 項 UniFi 原生沒有、或只做到一半的功能，作為「設備維運」支柱：
1. 設備總覽與長期健康
2. 線材與埠健康守衛＋埠位圖
3. PoE 排程＋電力帳本
4. 即時拓撲流量圖
5. 房間級在家＋漫遊軌跡（含黏滯裝置偵測）
6. 事故關聯時間軸

不做：分批韌體升級、Home Assistant MQTT 橋接、多 Console／多站點（使用者確認只有一台 UDM）。

## 沿用的決策與分工（同第一階段，見記憶 unifire-project-decisions）
- **Claude**：規劃、`shared/` 契約、全部 UI/UX（`app/`、`i18n/`）、覆核 Codex 的成果。
- **Codex**（`codex exec -m gpt-6.2-sol -c model_reasoning_effort="xhigh" -s workspace-write … < /dev/null`，stdin 必須導向 /dev/null）：調查與 `server/`、`tests/` 實作。
- Codex 規則沿用 `docs/codex/BRIEF.md`：不得改 `shared/`、所有寫入走同一道 write gate、server 端字串用 i18n key，並登錄到 `docs/backend/i18n-keys.md`。
- 新增 `docs/PLAN-infra.md`，內容是本計畫的中文版。在 BRIEF 的「Read before coding」加上這份檔案。

## 架構延伸

### 資料來源（多數已有，只是沒用到）
- `stat/device`：已在 `server/services/cache.ts` 每 60 秒輪詢，WebSocket 收到 `device:sync` 會提前刷新。需要擴充 `server/unifi/endpoints/schemas.ts` 的 `Device` 欄位：`state, uptime, version, upgradable, upgrade_to_firmware, system-stats{cpu,mem}, general_temperature/temperatures, num_sta, uplink{uplink_mac,uplink_remote_port,type,speed,full_duplex,rx/tx_bytes-r,signal}, port_table[]{port_idx,up,speed,full_duplex,speed_caps,poe_mode,poe_power,poe_class,rx/tx_errors,rx/tx_dropped,stp_state,media}, radio_table_stats[]{channel,cu_total,tx_retries,num_sta,tx_power}, total_max_power`。欄位一律可為 null，未知欄位保留。
- 有線客戶端的 `sw_mac/sw_port`、無線客戶端的 `ap_mac/signal`：已在每分鐘 usage 取樣（`server/engine/samplers/usage.ts`）讀到。
- WS 事件：`client.roam` 已有型別（`server/unifi/ws.ts:12`），之後要實際存起來。
- 新增寫入／指令：`cmd/devmgr` 的 `set-locate`／`unset-locate`（閃燈定位）、`PUT rest/device/{_id}` 的 `port_overrides`（PoE 排程）、`cmd/stamgr kick-sta`（已有，給黏滯裝置用）。

### 第一步：實機欄位擷取（唯讀，去識別化）
Network 11 的設備欄位形狀還沒在實機核對過（現有的 `docs/unifi-wire-shapes.md` 只涵蓋路由與客戶端），所以先擷取一次：
- Codex 寫 `scripts/capture-wire.ts`：重用 Unifire 已加密保存的控制器連線，只做 GET，外加監聽 WS 3 分鐘。擷取 `stat/device`、`rest/device`、`rest/portconf`、`stat/sta` 各一份，以及 WS 事件樣本。
- 輸出前去識別化：MAC 換成穩定代號、名稱換成佔位字、IP 換成文件保留網段、`x_*` 全部移除。
- 由 Claude 在 unifire 主機上執行（需要 SSH，屆時向使用者確認）。產出 `docs/unifi-wire-shapes-infra.md` 和 mock fixtures，mock 依實際機型與數量建模。

### 資料模型（新增 drizzle 表，migration 內嵌）
| 表 | 用途 | 保留期 |
|---|---|---|
| `infra_devices` | 每台設備（mac PK、名稱、型號、type、韌體、狀態、首見／最後見、roomId） | 永久 |
| `device_samples` → `device_rollups_hourly` | CPU、記憶體、溫度、uptime、客戶端數、上下行速率、狀態 | 原始 7 天，每小時彙總 400 天 |
| `device_transitions` | online／offline／restarting；`reason`：unexpected_reboot、unifire_restart、upgrade、offline | 永久 |
| `firmware_history` | 韌體版本變更（from → to） | 永久 |
| `port_state` | 每個 port 的目前狀態、速率基準（同一對端裝置曾達到的最高速率）、對端 mac 與種類 | 現況 |
| `port_samples`（5 分鐘桶）→ hourly | 速率、up、錯誤與丟包差值、PoE 瓦數平均 | 14 天，每小時彙總 400 天 |
| `port_events` | downgrade、recovered、errors、flapping、new_device、peer_changed，可標記已讀 | 1 年 |
| `poe_schedules`、`poe_overrides`、`poe_applied` | PoE 排程、臨時覆寫，以及 Unifire 實際改過哪些 port（擁有權依據） | — |
| `energy_hourly` | 每 port 每小時 Wh | 永久 |
| `rooms`、`ap_rooms` | 房間（名稱、樓層、圖示、排序）與 AP 對應 | — |
| `room_segments` | 人員 × 房間的時段 | 1 年 |
| `client_roams` | 漫遊紀錄（from AP → to AP、訊號、頻段、來源 ws／poll） | 90 天 |
| `sticky_flags` | 黏滯裝置狀態、推一下的次數 | 現況 |
| `incidents`、`incident_signals` | 事故與其中的訊號 | 1 年 |

設定（`server/services/settings.ts` 與 `shared/schemas/system.ts` 的 Settings）新增以下區塊：
- `infra`：溫度警戒、錯誤率門檻、flapping 門檻、各類保留期
- `energy`：每度電價、幣別（預設 TWD）
- `rooms`：停留分鐘數（預設 2）
- `sticky`：是否啟用、訊號門檻（-75 dBm）、持續分鐘數、要不要自動推一下、每日上限
- `incidents`：合併視窗（10 分鐘）、恢復後靜默時間（5 分鐘）、通知的最低嚴重度

### 引擎模組（`server/engine/infra/`）
- **device-sampler**：掛在 cache 的 `cache.changed: devices` 上，寫入樣本、狀態轉移與韌體變化。
  - 重開機判定：uptime 倒退時記為重開機。用 write ledger（`server/unifi/write-ledger.ts`）比對 Unifire 自己發出的 restart，區分「預期內」與「非預期」。
  - 發出 engine 事件：`infra.offline/online/rebooted/overheat/firmware`。
- **port-health**：每次輪詢比對 `port_table`。
  - 降速：同一對端裝置的協商速率低於基準，且持續 2 次輪詢以上。
  - 錯誤率：錯誤差值除以封包差值，超過門檻。計數器歸零的處理方式比照 usage sampler。
  - flapping：1 小時內 up/down 次數達門檻。
  - 新裝置：某個 port 出現從沒在這個 port 見過的 MAC。
  - 每個事件都會寫入 `port_events` 並發出 `port.issue`。
- **poe**：desired-state reconciler，比照 `server/engine/reconciler.ts` 與 `blocks.ts` 的擁有權模式。
  - 期望狀態的優先序：臨時覆寫 > 週排程 off 視窗 > 不管（UniFi 現狀）。
  - 只恢復 Unifire 自己關掉的 port。期間若有人在 UniFi 介面把 port 打開，就視為漂移：暫停該排程並通知，不跟人搶。
  - 排程讓 port 斷電期間，同一個 port 的 PoE 看門狗自動暫停（改 `server/engine/watchdogs.ts`），避免看門狗把它當成故障。
- **energy**：每次輪詢把 `poe_power` 對時間積分，算出 Wh 累加到 `energy_hourly`。輪詢中斷超過 3 分鐘的區段不補值。用排程的 off 時數乘以平均瓦數，估算每個排程省下的電。
- **topology**：從 `uplink` 建出樹狀圖，從客戶端的 `ap_mac`、`sw_mac/sw_port` 掛上葉節點，並疊加 people 資料。
  - 瓶頸判定：連線速率低於兩端能力、使用率超過 80%、Mesh 上連訊號低於 -70 dBm、半雙工。
  - 結果透過 SSE（`liveBus`）推送 `topology` 增量。
- **rooms**：沿用 `server/engine/presence.ts`。人在家時依「出現 presence MAC 的 AP」推得房間；在新 AP 上連續停留 `dwellMin` 分鐘才換房間，避免手機來回跳。發出 `person.room_entered/left`。
- **roaming**：WS `client.roam` 為主；萬一漏接，usage 取樣中 `ap_mac` 的變化當備援，兩者去重。
  - 黏滯判定：無線裝置訊號 ≤ 門檻持續 N 分鐘，且同一 SSID 還有其他 AP。
  - 可選的「推一下」（kick-sta）有防護：每台每日有上限、有冷卻時間；正在大流量傳輸（例如視訊中）就跳過。預設關閉。
- **incidents**：關聯引擎。
  - 訊號來源：egress down/up、WAN down、infra offline/online/rebooted、上連 port down、port issue、大量斷線（同一台 AP 或交換器 2 分鐘內有 5 台以上、或超過 30% 的客戶端斷線）、設定變更（audit 中的 external 與 unifire 事件）。
  - 合併規則：與已開啟事故在拓撲上相關（同一子樹，或屬全域的 WAN 類），且在合併視窗內，就併入同一事故。
  - 根因：失敗訊號中最上游、最早發生的那一個。事故開始前 15 分鐘內的設定變更列為「嫌疑」，並連到快照 diff。
  - 嚴重度：閘道、WAN、全部出口受影響，或超過 50% 客戶端受影響，判為 critical；其餘為 warning。
  - 所有失敗訊號都恢復，且靜默期滿，就自動結束事故。
  - 每個事故只送一則通知，結束時再補一則，用來取代洪水般的單點通知。也可當規則觸發條件 `incident.opened`。
- **快照**：`server/unifi/snapshot-resources.ts` 新增 `devices`（`rest/device`）。diff 顯示 port_overrides 與無線設定的變化；回滾只開放 `port_overrides`。

### 寫入安全（比照現有 write gate，`server/unifi/writes.ts`）
- 新增 `updatePortOverride(deviceMac, portIdx, patch)`：寫入前先抓最新的 `rest/device` 文件，合併進完整的 `port_overrides` 陣列，保留其他 port 及未知欄位。寫入前先拍快照，寫入後讀回 `stat/device` 驗證 `poe_mode`，並記入稽核。Dry-run 照舊生效。
- 以下情況一律拒絕：
  - uplink port
  - 非 PoE port
  - 下游子樹含其他 UniFi 設備（交換器或 Mesh 子節點）
  - 下游含 Unifire 主機本身
  - 位於閘道的路徑上
- 下游是 AP 時要明確勾選確認（「該 AP 的客戶端會改連其他 AP」）。
- 寫入資格驗證：使用者在設定頁挑一個不重要的 PoE port 做 off → on 測試（≤ 30 秒），兩次讀回都成功才開放 live。這一步會在實機上線時由我陪同、使用者確認後才做。
- 定位閃燈（`set-locate`）和 kick-sta 也走 gate，並記入稽核。

### 規則引擎擴充（`shared/schemas/automation.ts`、`server/engine/rules/`）
- **觸發**：`infra.offline` / `infra.online` {mac|null, minutes}、`infra.rebooted` {mac|null, unexpectedOnly}、`infra.overheat` {mac|null, celsius}、`infra.firmware` {mac|null}、`port.issue` {switchMac|null, kinds[]}、`poe.budget` {switchMac|null, percent}、`person.room_entered` / `person.room_left` {personId|null, roomId|null}、`incident.opened` {minSeverity}
- **條件**：`person.room` {personId, roomId, inRoom}
- **動作**：`poe.set` {switchMac, portIdx, on, minutes|null}（臨時覆寫，到期交還排程）、`device.locate` {mac, minutes}、`client.kick` {mac}
- 既有的 `device.offline` 保留不動，以免舊規則失效。

## 契約（Claude 先寫，再交給 Codex）
新增 `shared/schemas/infra.ts`：
`InfraDevice`、`InfraDeviceDetail`（radios、ports、韌體歷史）、`DeviceSeries`、`PortView`、`PortEvent`、`PoeSchedule(+Input)`、`PoeOverride`、`EnergyReport`、`Topology {nodes, edges, bottlenecks}`、`Room(+Input)`、`RoomPresence`、`RoamEvent`、`StickyClient`、`Incident`、`IncidentDetail`、`IncidentSignal`。

`shared/api.ts` 新增端點：
- `/api/devices` 系列：`GET`、`GET :mac`、`GET :mac/series?range=`、`GET :mac/events`、`POST :mac/locate`、`POST :mac/restart`、`PATCH :mac`（設定房間）
- 埠：`/api/ports/events`、`PATCH /api/ports/events/:id`（標記已讀）
- PoE：`/api/poe/schedules` CRUD、`POST /api/poe/override`、`POST /api/poe/qualify`
- `/api/energy?period=`
- `/api/topology`
- `/api/rooms` CRUD、`PUT /api/rooms/assign`（AP → 房間）
- `/api/presence/rooms?from=&to=`
- `/api/clients/:mac/roams`、`/api/roaming/sticky`
- `/api/incidents`、`/api/incidents/:id`、`PATCH /api/incidents/:id`（確認、備註）

另外，`DashboardSummary` 加入 `infra {online, total, openIncidents, poeWatts}`，`LiveEvent` 加入 `device`、`topology`、`incident`、`room` 事件。

## UI/UX（Claude 親自做，沿用現有設計 token 與元件）
- **導覽**：在 `app/utils/nav.ts` 新增「設備」群組，放在路由群組之後：設備 `/devices`、拓撲 `/devices/topology`、PoE `/devices/poe`。PoE 看門狗併進 PoE 頁的分頁，`/automation/watchdogs` 轉址過去。洞察群組新增「事故」`/insight/incidents`，以 badge 顯示開啟中的事故數。手機版放在「更多」選單。
- **`/devices` 設備總覽**：卡片與表格可切換，依類型分組（閘道／交換器／AP）。
  - 每張卡：狀態點、型號圖示、uptime、韌體（有新版時顯示「可更新」）、CPU／記憶體／溫度小量表、客戶端數、24 小時可用率條。
  - 篩選 chip：離線、過熱、有埠問題、可更新。
- **`/devices/[mac]` 設備詳情**：頂部 KPI 列與「定位閃燈」「重新啟動」按鈕。分頁如下：
  - 概覽：24h／7d／30d 圖表，沿用 `UfChart`
  - 埠：交換器才有，含面板圖與埠表
  - 無線：AP 才有，顯示頻道、頻寬、功率、使用率，各頻段客戶端數，以及漫遊進出統計
  - 事件：狀態轉移、重開機、韌體歷史、埠事件
  - 電力：各 PoE port 的用電
- **新元件 `SwitchFaceplate.vue`**：仿交換器正面面板的格狀 port 圖（RJ45 與 SFP 形狀不同）。
  - 依速率上色：10/100 橘、1G 綠、2.5G 以上藍。
  - PoE 閃電圖示加瓦數；有人員的 port 顯示頭像；降速、錯誤或 flapping 時顯示警示角標。
  - 點 port 開啟 `PortDrawer`：速率歷史、錯誤、PoE 瓦數、歷來接過的裝置。
- **`/devices/topology` 拓撲**：Vue Flow，已用在 `EgressConstellation.vue`。
  - 由左到右：出口 → 閘道 → 交換器 → AP → 客戶端群（可展開成人員頭像）。
  - 連線上標示速率與即時流量，流動光點的密度跟著流量變化；使用率決定顏色；Mesh 連線用虛線並標訊號。
  - 瓶頸處掛 badge（例：「100M 上連」）。
  - 疊加層可切換：流量／PoE／健康／人員。
  - 自動排成樹狀圖；可拖曳，位置存在 localStorage。點節點開啟設備抽屜。
- **`/devices/poe` PoE**：三個分頁。
  - 排程：從面板圖挑 port，用 `WeeklyWindowsEditor.vue` 畫 off 視窗；預覽未來 48 小時；顯示安全警示與「預估每月省 X 度、NT$Y」；有「預覽」與「啟用」兩種狀態。
  - 看門狗：搬自現有頁面。
  - 電力帳本：依設備或 port 的堆疊面積圖、本月度數與電費、耗電排行、排程省下的電。
- **`/insight/incidents` 事故**：開啟中的事故置頂（脈動標記），其餘依時間排列。詳情頁包含：
  - 一句話根因
  - 影響 chip：設備、客戶端數、受影響的人員頭像
  - 訊號時間軸
  - 拓撲縮圖，標出受影響的子樹
  - 「事故前的變更」，連到快照 diff
  - 確認與備註
- **在家頁**：`/insight/presence` 加上「在家／房間」切換。房間模式的甘特圖以房間色塊呈現，上方有「家庭地圖」：每個房間一張卡，顯示目前在裡面的人。
- **房間設定**：放在設定頁的新分頁，把 AP 卡片拖進房間，房間可依樓層分組。
- **客戶端抽屜**：新增「漫遊」分頁，顯示 AP 跳轉時間軸與訊號；客戶端列表加上黏滯 badge。
- **總覽頁**：新增設備健康列（在線數／總數、開啟中的事故、目前 PoE 瓦數）。有開啟中的事故時，頂部顯示橫幅。
- **規則編輯器**：在 `app/utils/rules.ts` 與 `RuleBlockEditor.vue` 加上新的觸發、條件、動作積木。
- **⌘K**：新增「定位 <設備>」「前往 <設備>」「PoE 開／關 <port>」。
- 所有新頁面都要有 zh-TW 和 en 翻譯，並用 mock 檢查 light／dark 與手機寬度。

## 工作包與順序
| 順序 | 內容 | 執行者 |
|---|---|---|
| C0 | `shared/schemas/infra.ts`、`api.ts`、automation 擴充、settings 擴充；`docs/PLAN-infra.md`；WP8–WP11 規格寫成 `docs/codex/WP8.md`…`WP11.md` | Claude |
| WP8a | `scripts/capture-wire.ts`（唯讀、去識別化），由 Claude 在主機上執行，產出 wire-shapes 文件 | Codex 寫，Claude 執行 |
| WP8 | Device schema 擴充、infra 資料表、device-sampler、韌體與重開機偵測、devices API、locate、快照 `devices` 資源、infra 規則觸發、多設備 mock（依實機機型，含 Mesh AP 與 PoE 交換器，會模擬重開機、降速、漫遊） | Codex |
| UI-1 | 導覽、`/devices`、`/devices/[mac]`、總覽健康列（同時用 mock 開發） | Claude |
| WP9 | port-health、port events API、PoE reconciler 與 write gate 的 `updatePortOverride`、看門狗協調、energy 與報表、`poe.set` 動作、qualify | Codex |
| UI-2 | `SwitchFaceplate`、`PortDrawer`、`/devices/poe`（排程、看門狗、帳本） | Claude |
| WP10 | topology 與 SSE、rooms 與 room presence、roaming 與 sticky、`client.kick`、`person.room` 條件 | Codex |
| UI-3 | 拓撲頁、房間設定、在家頁房間模式、漫遊分頁 | Claude |
| WP11 | incidents 引擎、API、通知（加入 `notification.incident_*` i18n key）、`incident.opened` 觸發；報表頁新增設備可用率 | Codex |
| UI-4 | 事故頁、總覽橫幅、規則積木、⌘K、翻譯收尾 | Claude |

每個 WP 完成後由 Claude 覆核：看 diff，跑 `pnpm typecheck`、`pnpm test`、`pnpm test:contract`，再檢查安全規則（擁有權、拒絕清單、去識別化、機密遮蔽、i18n key 是否登錄）。不合格就把問題清單交回 Codex 修正，通過後才 commit。

## 驗證
- **單元測試（vitest）**：
  - 重開機判定（uptime 倒退，並排除 Unifire 自己發出的 restart）
  - 降速基準與持續判定、錯誤率在計數器歸零時的處理、flapping 視窗、新裝置判定
  - PoE 期望狀態優先序、擁有權、漂移暫停、與看門狗的協調
  - 能量積分（含輪詢中斷的區段）
  - 房間停留遲滯
  - 黏滯判定與推一下的防護
  - 事故合併與根因：用拓撲加時間序列 fixture 驗證「交換器重開 → 子 AP 離線 → 大量斷線」會合併成同一個事故，根因是該交換器
- **整合測試（fake-UniFi）**：`port_overrides` 合併會保留其他 port 與欄位、拒絕清單、讀回驗證、`set-locate`、`rest/device` 快照遮蔽 `x_*`。
- **UI**：`NUXT_MOCK_CONTROLLER=true pnpm dev` 逐頁檢查 light/dark、手機寬度、zh-TW/en；Playwright 跑關鍵流程：PoE 排程建立、房間指派、事故詳情。
- **實機上線（UDM Pro 11.0.104，由我陪同，每一步先徵得使用者同意）**：
  1. 部署後先看唯讀功能：設備數量與型號、拓撲是否和 UniFi 介面一致、埠速率是否正確。
  2. 觀察 24 小時，確認重開機與降速沒有誤報。
  3. 由使用者挑測試 port，做 PoE 資格驗證。
  4. 先建立「預覽」狀態的排程並確認，再啟用。
  5. 經使用者同意後重啟一台 AP，確認事故合併、根因與通知。
  6. 房間：使用者拿手機在各房間走動，確認房間判定與停留遲滯。
