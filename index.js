const express = require("express");
const cors = require("cors");
const sqlite3 = require("sqlite3").verbose();
const path = require("path"); // ★ 追加
const fs = require("fs"); // ★ 追加

const app = express();
const port = 3000; // ★ ポートを 3000 に戻します

app.use(cors());
app.use(express.json());

// --- ★ ここから追加 (menu.json と assets) ---

// menu.json データを読み込む
let menuData = {};
try {
  // menu.json が 'backend-server/data/menu.json' にあると仮定
  const menuJsonPath = path.join(__dirname, "data", "menu.json");

  // もし 'backend-server/menu.json' (直下) に置いた場合は、上の行をコメントアウトし、下の行を使ってください
  // const menuJsonPath = path.join(__dirname, 'menu.json');

  const menuJsonRaw = fs.readFileSync(menuJsonPath, "utf-8");
  menuData = JSON.parse(menuJsonRaw);
} catch (err) {
  console.error("!!! menu.json の読み込みに失敗しました:", err.message);
  console.error("!!! ファイルパスが正しいか確認してください:", err.path);
  menuData = { categories: [] };
}

// GET /api/menu エンドポイントを追加
app.get("/api/menu", (req, res) => {
  res.json(menuData); // 読み込んだメニューデータを返す
});

// 静的ファイル (assets フォルダ) を提供する設定
// 'backend-server/assets' フォルダを /assets パスで公開
app.use("/assets", express.static(path.join(__dirname, "assets")));

// --- ★ ここまで追加 ---

// データベース設定 (★ 既存の処理を復元・維持)
const db = new sqlite3.Database("./order_system.db", (err) => {
  if (err) {
    console.error("Database connection error:", err.message);
  } else {
    // ★ 起動ログをこちらに移動
    console.log(`サーバーが http://localhost:${port} で起動しました`);
    console.log("データベース (order_system.db) に接続しました。");

    db.serialize(() => {
      // ★ Orders テーブル (既存の処理)
      db.run(
        `CREATE TABLE IF NOT EXISTS orders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        table_number INTEGER NOT NULL,
        items TEXT NOT NULL,
        total_price REAL NOT NULL,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
      )`,
        (err) => {
          if (err) {
            console.error("Ordersテーブル作成エラー:", err.message);
          } else {
            console.log("Ordersテーブルを正常に（または既に）読み込みました。");
          }
        }
      );

      // ★ Menus テーブル (★ ユーザーの元の定義に合わせてください)
      // 以下は推測です。実際のテーブル定義に合わせて修正してください。
      db.run(
        `CREATE TABLE IF NOT EXISTS Menus (
        id TEXT PRIMARY KEY,
        name TEXT,
        description TEXT,
        price REAL,
        image TEXT,
        category TEXT
      )`,
        (err) => {
          if (err) {
            console.error("Menusテーブル作成エラー:", err.message);
          } else {
            console.log("Menusテーブルを正常に（または既に）読み込みました。");
          }
        }
      );

      // ★ OrderDetails テーブル (★ ユーザーの元の定義に合わせてください)
      // 以下は推測です。実際のテーブル定義に合わせて修正してください。
      db.run(
        `CREATE TABLE IF NOT EXISTS OrderDetails (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        order_id INTEGER,
        menu_id TEXT,
        quantity INTEGER,
        options TEXT,
        FOREIGN KEY(order_id) REFERENCES orders(id)
      )`,
        (err) => {
          if (err) {
            console.error("OrderDetailsテーブル作成エラー:", err.message);
          } else {
            console.log(
              "OrderDetailsテーブルを正常に（または既に）読み込みました。"
            );
          }
        }
      );
    });
  }
});

// 注文APIエンドポイント (既存の処理)
app.post("/api/orders", (req, res) => {
  const { tableNumber, items } = req.body;

  if (!tableNumber || !items || !Array.isArray(items) || items.length === 0) {
    return res
      .status(400)
      .json({ error: "テーブル番号と注文項目は必須です。" });
  }

  let totalPrice = 0;
  try {
    totalPrice = items.reduce((sum, item) => {
      const optionsPrice =
        item.selectedOptions?.reduce((optSum, opt) => optSum + opt.price, 0) ||
        0;
      return sum + (item.price + optionsPrice) * item.quantity;
    }, 0);
  } catch (e) {
    console.error("価格計算エラー:", e);
    return res
      .status(400)
      .json({ error: "注文価格の計算中にエラーが発生しました。" });
  }

  const itemsJson = JSON.stringify(items);
  const timestamp = new Date().toISOString();

  const sql = `INSERT INTO orders (table_number, items, total_price, timestamp) VALUES (?, ?, ?, ?)`;
  const params = [tableNumber, itemsJson, totalPrice, timestamp];

  db.run(sql, params, function (err) {
    if (err) {
      console.error("DBエラー (注文保存):", err.message);
      return res
        .status(500)
        .json({ error: "データベースへの注文保存中にエラーが発生しました。" });
    }
    res
      .status(201)
      .json({
        id: this.lastID,
        tableNumber,
        items: JSON.stringify(items),
        totalPrice,
        timestamp,
      });
  });
});

// 注文履歴取得APIエンドポイント (既存の処理)
app.get("/api/orders", (req, res) => {
  const sql = "SELECT * FROM orders ORDER BY timestamp DESC";
  db.all(sql, [], (err, rows) => {
    if (err) {
      console.error("DBエラー (注文履歴取得):", err.message);
      return res
        .status(500)
        .json({
          error: "データベースからの注文履歴取得中にエラーが発生しました。",
        });
    }
    res.json(rows);
  });
});

// サーバー起動
app.listen(port, () => {
  // ★ ログは DB 接続成功時に表示されるため、ここでは不要
  // console.log(`Server running on port ${port}`);
});

// DBクローズ処理 (変更なし)
process.on("SIGINT", () => {
  db.close((err) => {
    if (err) {
      console.error("Error closing database:", err.message);
    } else {
      console.log("Database connection closed.");
    }
    process.exit(0);
  });
});
