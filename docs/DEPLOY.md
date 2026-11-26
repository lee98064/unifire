# 部署 Unifire

Unifire 需要一台能從區域網路連到 UniFi OS 閘道的主機。容器部署建議使用 Linux、Docker Engine 與 Docker Compose。直接部署需要 Node.js 22、pnpm 10.22.0 和 SQLite 原生模組的建置工具。單一資料目錄只啟動一個 Unifire 程序。

瀏覽器請透過有可信任憑證的 HTTPS 網域連線。PWA、Web Push 和 Passkey 都需要安全環境。把既有 Nginx 當成入口，並讓 Unifire 後端只監聽本機。主機需要能連到閘道的 HTTPS 與 WebSocket、探測目的地，以及使用中的通知服務。WoL 跨 VLAN 時，需在網路上允許封包到達目標廣播位址。

## 使用 Docker Compose

在專案根目錄執行以下命令。容器使用 UID/GID 1000，需能寫入 `./data`。

```sh
sudo install -d -m 0700 -o 1000 -g 1000 data
docker compose up -d --build
docker compose ps
curl --fail http://127.0.0.1:3000/api/health
```

Compose 採用 Linux host networking，讓 UniFi 能辨識探測流量的主機來源，也讓 WoL 能傳送 LAN 廣播封包。以 `docker compose logs -f unifire` 查看啟動狀態。健康檢查中的 `db: "ok"` 表示資料庫可用，`controller` 則各自顯示 `unconfigured`、`disconnected` 或 `connected`。閘道暫時離線時仍可啟動 Unifire。

## 直接使用 Node.js

在與部署主機相同的作業系統與 CPU 架構上建置。若需要編譯 SQLite 原生模組，請先安裝 Python 3、make 和 C++ 編譯器。

```sh
corepack enable
corepack prepare pnpm@10.22.0 --activate
pnpm install --frozen-lockfile
pnpm build
```

### 使用 systemd

在 Linux 主機建立專用服務帳號，將建置產物安裝到 `/opt/unifire`。範例 unit 使用 `/usr/bin/node`，請依 Node.js 的實際安裝位置調整。

```sh
sudo useradd --system --user-group --home-dir /var/lib/unifire --shell /usr/sbin/nologin unifire
sudo install -d -m 0755 /opt/unifire /etc/unifire
sudo cp -a .output /opt/unifire/
sudo install -m 0644 deploy/unifire.service /etc/systemd/system/unifire.service
sudo systemctl daemon-reload
sudo systemctl enable --now unifire
curl --fail http://127.0.0.1:3000/api/health
```

服務資料放在 `/var/lib/unifire`。若要覆寫環境變數，請建立權限為 0600 的 `/etc/unifire/unifire.env`。unit 已授予 `CAP_NET_RAW`，可配合主機上的 `ping` 使用 ICMP 探測。以 `journalctl -u unifire -f` 查閱日誌。

### 使用 PM2

在已安裝 PM2 的主機上，以部署帳號執行。環境變數可由部署帳號的啟動環境提供。若希望重開機自動啟動，執行 `pm2 startup` 並照輸出的指令安裝啟動服務。

```sh
pm2 start ecosystem.config.cjs
pm2 save
curl --fail http://127.0.0.1:3000/api/health
```

## 環境變數

| 變數 | 預設 | 用途 |
| --- | --- | --- |
| `PORT` | `3000` | HTTP 連接埠。變更時同步更新 Nginx upstream。 |
| `NITRO_HOST` | 部署範例為 `127.0.0.1` | 經 Nginx 發布時，讓後端限本機存取。 |
| `TZ` | 部署範例為 `Asia/Taipei` | 程序時區。報表和排程各自依 Unifire 設定選用 IANA 時區。 |
| `NUXT_DATA_DIR` | 容器為 `/data`，systemd 為 `/var/lib/unifire`，其他為 `./.data` | 儲存 SQLite、加密金鑰和 session 金鑰。 |
| `NUXT_UNIFIRE_SECRET` | 自動產生 `secret.key` | AES 金鑰。若自行提供，須為可解碼成 32 位元組的 Base64 或十六進位字串，或正好 32 位元組的原始文字。 |
| `NUXT_SESSION_PASSWORD` | 自動產生 `session.key` | Session 金鑰。自訂時至少 32 個字元。 |
| `NUXT_TRUST_PROXY` | 程式預設 `false`，部署範例為 `true` | 使用可信任 Nginx 覆寫的 `X-Forwarded-Proto` 與 `X-Forwarded-Host`，產生 kiosk 網址及 Web Push 開啟的頁面網址。 |
| `NUXT_LOG_LEVEL` | `info` | Unifire 啟停日誌層級，可填 `silent`、`error`、`warn`、`info`、`debug`。 |
| `NUXT_MOCK_CONTROLLER` | `false` | 僅在隔離的測試資料目錄使用 `true`。 |

## 設定 HTTPS 與首次啟動

1. 將 [Nginx 範例](../deploy/nginx.conf.example) 加入既有設定，替換網域、憑證路徑及必要的 upstream 連接埠。範例會覆寫用戶端傳入的轉送標頭，並讓 `/api/events` 持續串流。執行 `sudo nginx -t`，確認成功後重新載入 Nginx。
2. 在 UniFi OS 建立專用的本機管理員，例如 `unifire`，並授予目標 Network 站點與所需功能的管理權限。請與家人帳號和既有自動化帳號分開。
3. 用 HTTPS 網址打開 Unifire，建立 Unifire 管理員。依精靈輸入閘道的內網 HTTPS 位址、站點和專用 UniFi 帳密。確認憑證指紋與閘道相符，或提供信任的 CA。執行能力檢測後，再確認主機的來源 MAC、探測出口和時區。
4. 在設定填入對外的 HTTPS 站台網址，讓背景通知服務也能產生絕對網址。若 kiosk 將顯示在共用裝置，請把連結視為存取憑證，必要時重新產生 token。

## 從 Dry-run 切換到 Live

- 在開始前手動建立第一份快照，確認能檢視內容和差異。
- 如果有路由只想讓 Unifire 讀取，到「設定 → 一般」加入「永不寫入的路由」清單。確認路由清單顯示為排除，並檢查要認領的路由及目標裝置。若要認領仍由外部腳本切換的路由，請先停掉該腳本。
- 在 Dry-run 驗證排程、臨時出口、暫停與規則測試的結果，檢查稽核記錄中的預計操作。
- 切換 Live 後，在控制器頁重新執行能力檢測。確認測試路由的建立、回讀、更新及刪除通過，再對一個可控的裝置測試，並確認新連線經預期出口離開。
- 啟用所需探測出口和通知，檢查探測狀態與稽核。需要停止控制器寫入時，切回 Dry-run。

## 備份、還原與升級

停止服務後，備份完整資料目錄，其中包含 SQLite 資料庫及自動產生的金鑰。若透過環境變數供應金鑰，另外用安全方式備份其原值。還原資料必須搭配相同的加密金鑰，沿用 session 金鑰則能保留既有登入。請限制備份的存取權限。

以下在 Compose 專案目錄執行。

```sh
docker compose stop
sudo sh -c 'umask 077; tar -czf "../unifire-data-$(date +%Y%m%d-%H%M%S).tar.gz" data'
docker compose start
```

還原時先停止服務，將現有資料目錄改名留存，把選定的封存檔解到同一層。保留原檔案擁有者和權限，確認資料目錄位置及金鑰相符後再啟動。直接部署同樣先停止 systemd 或 PM2，再備份設定中的 `NUXT_DATA_DIR`。

升級前保留資料目錄的備份與上一版成品。Compose 更新程式碼後執行 `docker compose up -d --build`。直接部署則先建置新版，停止服務、更換 `.output` 後重新啟動。啟動會自動遷移 SQLite。升級後檢查 `/api/health`、登入、控制器連線與稽核。若要退回上一版，請搭配升級前的資料目錄一起還原。
