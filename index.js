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
      // ★ Orders テーブル
      db.run(
        `CREATE TABLE IF NOT EXISTS orders (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          table_number INTEGER NOT NULL,
          items TEXT NOT NULL,
          total_price REAL NOT NULL,
          status TEXT NOT NULL DEFAULT '注文受付', 
          timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
        )`,
        (err) => {
          if (err) console.error("Ordersテーブル作成エラー:", err.message);
        }
      );

      // ★ Menus テーブル
      db.run(
        `CREATE TABLE IF NOT EXISTS Menus (
          id TEXT PRIMARY KEY,
          name TEXT,
          description TEXT,
          price REAL,
          image TEXT,
          category TEXT,
          options TEXT,
          isRecommended BOOLEAN DEFAULT 0
        )`,
        (err) => {
          if (err) console.error("Menusテーブル作成エラー:", err.message);
          else {
            db.get("SELECT COUNT(*) as count FROM Menus", (err, row) => {
              if (row && row.count === 0) {
                loadInitialMenuData();
              }
            });
          }
        }
      );

      // ★★★ 修正: テーブル名を order_details (小文字スネークケース) に統一 ★★★
      db.run(
        `CREATE TABLE IF NOT EXISTS order_details (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          order_id INTEGER NOT NULL,
          menu_item_id TEXT NOT NULL,
          name TEXT,
          price REAL,
          quantity INTEGER,
          options TEXT,
          FOREIGN KEY(order_id) REFERENCES orders(id)
        )`,
        (err) => {
          if (err)
            console.error("order_detailsテーブル作成エラー:", err.message);
          else
            console.log(
              "order_detailsテーブルを正常に（または既に）読み込みました。"
            );
        }
      );
    });
  }
});

// (loadInitialMenuData 関数は変更なし)
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
          category.name,
          JSON.stringify(item.options || []),
          item.isRecommended || false
        );
      }
    }
    stmt.finalize();
  } catch (err) {
    console.error("menu.json error:", err.message);
  }
}

// ------------------------------------------
// --- お客様用 (Frontend-Customer) API ---
// ------------------------------------------

// GET /api/menu
app.get("/api/menu", (req, res) => {
  const sql = "SELECT * FROM Menus";
  db.all(sql, [], (err, rows) => {
    if (err) {
      return res.status(500).json({ error: "メニューの取得に失敗しました。" });
    }
    const categoriesMap = new Map();
    for (const item of rows) {
      const categoryName = item.category;
      if (!categoriesMap.has(categoryName)) {
        categoriesMap.set(categoryName, { name: categoryName, items: [] });
      }
      try {
        item.options = JSON.parse(item.options || "[]");
      } catch (e) {
        item.options = [];
      }
      categoriesMap.get(categoryName).items.push(item);
    }
    const menuData = { categories: Array.from(categoriesMap.values()) };
    res.json(menuData);
  });
});

// POST /api/orders
app.post("/api/orders", (req, res) => {
  const { tableNumber, items } = req.body;

  const tableNumInt = parseInt(tableNumber, 10);

  if (
    isNaN(tableNumInt) ||
    !items ||
    !Array.isArray(items) ||
    items.length === 0
  ) {
    return res
      .status(400)
      .json({ error: "有効なテーブル番号(数値)と注文項目は必須です。" });
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
    return res
      .status(400)
      .json({ error: "注文価格の計算中にエラーが発生しました。" });
  }

  const itemsJson = JSON.stringify(items);
  const timestamp = new Date().toISOString();

  const sql = `INSERT INTO orders (table_number, items, total_price, timestamp, status) 
               VALUES (?, ?, ?, ?, '注文受付')`;
  const params = [tableNumInt, itemsJson, totalPrice, timestamp];

  // ① まず orders テーブルに保存
  db.run(sql, params, function (err) {
    if (err) {
      console.error("DBエラー (注文保存):", err.message);
      return res
        .status(500)
        .json({ error: "データベースへの注文保存中にエラーが発生しました。" });
    }

    const orderId = this.lastID;

    // ② 続いて order_details テーブルに詳細を保存 (★修正: テーブル名変更)
    const sqlDetail = `INSERT INTO order_details (order_id, menu_item_id, name, price, quantity, options) VALUES (?, ?, ?, ?, ?, ?)`;
    const stmt = db.prepare(sqlDetail);

    try {
      db.serialize(() => {
        items.forEach((item) => {
          stmt.run(
            orderId,
            item.menuItemId || item.id,
            item.name,
            item.price,
            item.quantity,
            JSON.stringify(item.options || item.selectedOptions || [])
          );
        });
        stmt.finalize();
      });

      res.status(201).json({
        id: orderId,
        table_number: tableNumInt,
        items: items,
        total_price: totalPrice,
        timestamp: timestamp,
        status: "注文受付",
      });
    } catch (detailErr) {
      console.error("DBエラー (詳細保存):", detailErr.message);
      res
        .status(500)
        .json({ error: "注文詳細の保存中にエラーが発生しました。" });
    }
  });
});

// GET /api/orders
app.get("/api/orders", (req, res) => {
  const tableNumber = req.query.tableNumber;

  if (!tableNumber) {
    return res
      .status(400)
      .json({ error: "テーブル番号が指定されていません。" });
  }

  const sql =
    "SELECT * FROM orders WHERE table_number = ? AND status != '会計済み' ORDER BY timestamp DESC";

  db.all(sql, [tableNumber], (err, rows) => {
    if (err) {
      return res.status(500).json({
        error: "データベースからの注文履歴取得中にエラーが発生しました。",
      });
    }
    res.json(rows);
  });
});

// ------------------------------------------
// --- お店側 (Frontend-Admin/Kitchen) API ---
// ------------------------------------------

// GET /api/kitchen/orders
app.get("/api/kitchen/orders", (req, res) => {
  const sql = `SELECT * FROM orders 
               WHERE status = '注文受付' OR status = '調理中' OR status = '提供済み' OR status = '呼び出し'
               ORDER BY timestamp ASC`;
  db.all(sql, [], (err, rows) => {
    if (err) {
      return res
        .status(500)
        .json({ error: "キッチン用の注文取得に失敗しました。" });
    }
    res.json(rows);
  });
});

// PUT /api/orders/:id/status
app.put("/api/orders/:id/status", (req, res) => {
  const orderId = req.params.id;
  const { status } = req.body;

  if (!status) {
    return res.status(400).json({ error: "ステータスは必須です。" });
  }
  const allowedStatus = [
    "調理中",
    "提供済み",
    "会計済み",
    "キャンセル",
    "注文受付",
    "呼び出し",
  ];
  if (!allowedStatus.includes(status)) {
    return res.status(400).json({ error: "無効なステータスです。" });
  }

  const sql = `UPDATE orders SET status = ? WHERE id = ?`;
  db.run(sql, [status, orderId], function (err) {
    if (err) {
      return res
        .status(500)
        .json({ error: "注文ステータスの更新に失敗しました。" });
    }
    if (this.changes === 0) {
      return res.status(404).json({ error: "該当する注文が見つかりません。" });
    }
    res.status(200).json({
      message: "ステータスを更新しました。",
      id: orderId,
      status: status,
    });
  });
});

// スタッフ呼び出しAPI
app.post("/api/call", (req, res) => {
  const { tableNumber } = req.body;
  const tableNumInt = parseInt(tableNumber, 10);

  if (!tableNumInt) {
    return res.status(400).json({ error: "テーブル番号は必須です。" });
  }

  const itemsJson = JSON.stringify([
    { name: "スタッフ呼び出し", quantity: 1, price: 0 },
  ]);
  const timestamp = new Date().toISOString();

  const sql = `INSERT INTO orders (table_number, items, total_price, timestamp, status) 
               VALUES (?, ?, 0, ?, '呼び出し')`;

  db.run(sql, [tableNumInt, itemsJson, timestamp], function (err) {
    if (err) {
      return res.status(500).json({ error: "呼び出しの保存に失敗しました。" });
    }
    res
      .status(201)
      .json({ message: "スタッフを呼び出しました", id: this.lastID });
  });
});

// POST /api/admin/menu
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
      return res.status(500).json({ error: "メニューの追加に失敗しました。" });
    }
    res.status(201).json({ message: "メニューを追加しました。", id: id });
  });
});

// PUT /api/admin/menu/:id
app.put("/api/admin/menu/:id", (req, res) => {
  const menuId = req.params.id;
  const { name, description, price, image, category, options, isRecommended } =
    req.body;
  if (!name || !price) {
    return res.status(400).json({ error: "name と price は必須です。" });
  }
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

// DELETE /api/admin/menu/:id
app.delete("/api/admin/menu/:id", (req, res) => {
  const menuId = req.params.id;
  const sql = `DELETE FROM Menus WHERE id = ?`;
  db.run(sql, [menuId], function (err) {
    if (err) {
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

// テーブル番号一覧を取得
app.get("/api/tables", (req, res) => {
  const sql = `
    SELECT DISTINCT table_number 
    FROM orders 
    WHERE status != '会計済み'
    ORDER BY table_number ASC
  `;

  db.all(sql, [], (err, rows) => {
    if (err) {
      return res
        .status(500)
        .json({ error: "テーブル番号の取得に失敗しました。" });
    }
    const tableNumbers = rows.map((r) => r.table_number);
    res.json(tableNumbers);
  });
});

// --- サーバー起動 ---
app.listen(port, "0.0.0.0", () => {
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
