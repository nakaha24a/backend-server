const express = require("express");
const cors = require("cors");
const sqlite3 = require("sqlite3").verbose();
const path = require("path");
const fs = require("fs");

const app = express();
const port = 3000;

app.use(cors());
app.use(express.json());

// --- 静的ファイル (assets フォルダ) の提供 ---
app.use("/assets", express.static(path.join(__dirname, "assets")));

// --- データベース設定 ---
const db = new sqlite3.Database("./order_system.db", (err) => {
  if (err) {
    console.error("Database connection error:", err.message);
  } else {
    console.log(`サーバーが http://localhost:${port} で起動しました`);
    console.log("データベース (order_system.db) に接続しました。");

    db.serialize(() => {
      // ★ Orders テーブルに 'status' カラムを追加 (デフォルト '調理中')
      db.run(
        `CREATE TABLE IF NOT EXISTS orders (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          table_number INTEGER NOT NULL,
          items TEXT NOT NULL,
          total_price REAL NOT NULL,
          status TEXT NOT NULL DEFAULT '調理中', 
          timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
        )`,
        (err) => {
          if (err) console.error("Ordersテーブル作成エラー:", err.message);
          else
            console.log("Ordersテーブルを正常に（または既に）読み込みました。");
        }
      );

      // ★ Menus テーブル (メニューの原本)
      db.run(
        `CREATE TABLE IF NOT EXISTS Menus (
          id TEXT PRIMARY KEY,
          name TEXT,
          description TEXT,
          price REAL,
          image TEXT,
          category TEXT,
          options TEXT, -- オプションはJSON文字列で保存
          isRecommended BOOLEAN DEFAULT 0
        )`,
        (err) => {
          if (err) console.error("Menusテーブル作成エラー:", err.message);
          else {
            console.log("Menusテーブルを正常に（または既に）読み込みました。");
            // ★ Menus テーブルが空の場合、menu.json から初期データを読み込む
            db.get("SELECT COUNT(*) as count FROM Menus", (err, row) => {
              if (row && row.count === 0) {
                console.log(
                  "Menusテーブルが空のため、menu.jsonから初期データを読み込みます..."
                );
                loadInitialMenuData();
              }
            });
          }
        }
      );

      // ★ OrderDetails テーブル (詳細な注文項目用 - 将来の拡張用)
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
          if (err)
            console.error("OrderDetailsテーブル作成エラー:", err.message);
          else
            console.log(
              "OrderDetailsテーブルを正常に（または既に）読み込みました。"
            );
        }
      );
    });
  }
});

// Menusテーブルに初期データをロードする関数
function loadInitialMenuData() {
  try {
    const menuJsonPath = path.join(__dirname, "data", "menu.json");
    const menuJsonRaw = fs.readFileSync(menuJsonPath, "utf-8");
    const menuData = JSON.parse(menuJsonRaw);

    const stmt =
      db.prepare(`INSERT INTO Menus (id, name, description, price, image, category, options, isRecommended) 
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);

    for (const category of menuData.categories) {
      for (const item of category.items) {
        stmt.run(
          item.id,
          item.name,
          item.description,
          item.price,
          item.image,
          category.name, // ★ category.name を Menus テーブルの category カラムに
          JSON.stringify(item.options || []),
          item.isRecommended || false
        );
      }
    }
    stmt.finalize((err) => {
      if (err)
        console.error("Menusテーブルへの初期データ挿入エラー:", err.message);
      else console.log("Menusテーブルに初期データを挿入しました。");
    });
  } catch (err) {
    console.error(
      "!!! menu.json の読み込みまたはパースに失敗しました:",
      err.message
    );
  }
}

// ------------------------------------------
// --- お客様用 (Frontend-Customer) API ---
// ------------------------------------------

// GET /api/menu: メニュー一覧を渡す
// ★ DB (Menusテーブル) から取得するように変更
app.get("/api/menu", (req, res) => {
  const sql = "SELECT * FROM Menus";
  db.all(sql, [], (err, rows) => {
    if (err) {
      console.error("DBエラー (メニュー取得):", err.message);
      return res.status(500).json({ error: "メニューの取得に失敗しました。" });
    }

    // DBから取得したデータを、フロントエンドが期待するカテゴリごとの形式に再構築
    const categoriesMap = new Map();
    for (const item of rows) {
      const categoryName = item.category;
      if (!categoriesMap.has(categoryName)) {
        categoriesMap.set(categoryName, { name: categoryName, items: [] });
      }
      // options を JSON 文字列からオブジェクトに戻す
      item.options = JSON.parse(item.options || "[]");
      categoriesMap.get(categoryName).items.push(item);
    }

    const menuData = { categories: Array.from(categoriesMap.values()) };
    res.json(menuData);
  });
});

// POST /api/orders: 注文を受け取る
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
  // ★ status のデフォルト ('調理中') を指定して INSERT
  const sql = `INSERT INTO orders (table_number, items, total_price, timestamp, status) 
               VALUES (?, ?, ?, ?, '調理中')`;
  const params = [tableNumber, itemsJson, totalPrice, timestamp];

  db.run(sql, params, function (err) {
    if (err) {
      console.error("DBエラー (注文保存):", err.message);
      return res
        .status(500)
        .json({ error: "データベースへの注文保存中にエラーが発生しました。" });
    }

    // ★ ターミナルにログを表示 (ご要望に応じて追加)
    // console.log(`注文を受け付けました: テーブル ${tableNumber}, 注文ID ${this.lastID}`);

    // 新しく作成された注文情報を返す (status も含む)
    res.status(201).json({
      id: this.lastID,
      table_number: tableNumber, // ★ カラム名に合わせる
      items: itemsJson, // ★ DB保存前の items を返しても良い (JSON.stringify(items))
      total_price: totalPrice, // ★ カラム名に合わせる
      timestamp: timestamp,
      status: "調理中", // ★ ステータスを返す
    });
  });
});

// GET /api/orders: (お客様用) 注文履歴取得
app.get("/api/orders", (req, res) => {
  // ★ お客様には会計済み以外の全注文を表示する (例)
  const sql =
    "SELECT * FROM orders WHERE status != '会計済み' ORDER BY timestamp DESC";
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

// ------------------------------------------
// --- お店側 (Frontend-Admin/Kitchen) API ---
// ------------------------------------------

// GET /api/kitchen/orders: 「調理中」「提供済み」の注文一覧を渡す
app.get("/api/kitchen/orders", (req, res) => {
  const sql = `SELECT * FROM orders 
               WHERE status = '調理中' OR status = '提供済み' 
               ORDER BY timestamp ASC`; // 古い順に表示
  db.all(sql, [], (err, rows) => {
    if (err) {
      console.error("DBエラー (キッチン注文取得):", err.message);
      return res
        .status(500)
        .json({ error: "キッチン用の注文取得に失敗しました。" });
    }
    res.json(rows);
  });
});

// PUT /api/orders/:id/status: 注文を「提供済み」などに変更する
app.put("/api/orders/:id/status", (req, res) => {
  const orderId = req.params.id;
  const { status } = req.body; // 例: { "status": "提供済み" }

  if (!status) {
    return res.status(400).json({ error: "ステータスは必須です。" });
  }
  // 想定されるステータス以外は弾く (任意)
  const allowedStatus = ["調理中", "提供済み", "会計済み", "キャンセル"];
  if (!allowedStatus.includes(status)) {
    return res.status(400).json({ error: "無効なステータスです。" });
  }

  const sql = `UPDATE orders SET status = ? WHERE id = ?`;
  db.run(sql, [status, orderId], function (err) {
    if (err) {
      console.error("DBエラー (ステータス更新):", err.message);
      return res
        .status(500)
        .json({ error: "注文ステータスの更新に失敗しました。" });
    }
    if (this.changes === 0) {
      return res.status(404).json({ error: "該当する注文が見つかりません。" });
    }
    res
      .status(200)
      .json({
        message: "ステータスを更新しました。",
        id: orderId,
        status: status,
      });
  });
});

// POST /api/admin/menu: 新メニューを登録する
app.post("/api/admin/menu", (req, res) => {
  const {
    id,
    name,
    description,
    price,
    image,
    category,
    options,
    isRecommended,
  } = req.body;

  if (!id || !name || !price || !category) {
    return res
      .status(400)
      .json({ error: "id, name, price, category は必須です。" });
  }

  const sql = `INSERT INTO Menus (id, name, description, price, image, category, options, isRecommended) 
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;
  const params = [
    id,
    name,
    description || "",
    price,
    image || "",
    category,
    JSON.stringify(options || []),
    isRecommended || false,
  ];

  db.run(sql, params, function (err) {
    if (err) {
      console.error("DBエラー (メニュー追加):", err.message);
      return res.status(500).json({ error: "メニューの追加に失敗しました。" });
    }
    res.status(201).json({ message: "メニューを追加しました。", id: id });
  });
});

// PUT /api/admin/menu/:id: メニューを編集・品切れにする
app.put("/api/admin/menu/:id", (req, res) => {
  const menuId = req.params.id;
  const { name, description, price, image, category, options, isRecommended } =
    req.body;

  // 必須項目チェック (例: name と price)
  if (!name || !price) {
    return res.status(400).json({ error: "name と price は必須です。" });
  }
  // (品切れフラグを別カラムで持つ場合は、ここも更新対象に含める)

  const sql = `UPDATE Menus SET 
               name = ?, description = ?, price = ?, image = ?, category = ?, options = ?, isRecommended = ?
               WHERE id = ?`;
  const params = [
    name,
    description || "",
    price,
    image || "",
    category || "未分類",
    JSON.stringify(options || []),
    isRecommended || false,
    menuId,
  ];

  db.run(sql, params, function (err) {
    if (err) {
      console.error("DBエラー (メニュー更新):", err.message);
      return res.status(500).json({ error: "メニューの更新に失敗しました。" });
    }
    if (this.changes === 0) {
      return res
        .status(404)
        .json({ error: "該当するメニューが見つかりません。" });
    }
    res.status(200).json({ message: "メニューを更新しました。", id: menuId });
  });
});

// DELETE /api/admin/menu/:id: メニューを削除する
app.delete("/api/admin/menu/:id", (req, res) => {
  const menuId = req.params.id;

  const sql = `DELETE FROM Menus WHERE id = ?`;

  db.run(sql, [menuId], function (err) {
    if (err) {
      console.error("DBエラー (メニュー削除):", err.message);
      return res.status(500).json({ error: "メニューの削除に失敗しました。" });
    }
    if (this.changes === 0) {
      return res
        .status(404)
        .json({ error: "該当するメニューが見つかりません。" });
    }
    res.status(200).json({ message: "メニューを削除しました。", id: menuId });
  });
});

// --- サーバー起動 ---
app.listen(port, "0.0.0.0", () => {
  // ★ 0.0.0.0 を指定 (タブレットなど外部アクセス許可)
  // ログは DB 接続成功時に表示
});

// --- DBクローズ処理 ---
process.on("SIGINT", () => {
  db.close((err) => {
    if (err) console.error("Error closing database:", err.message);
    else console.log("Database connection closed.");
    process.exit(0);
  });
});
