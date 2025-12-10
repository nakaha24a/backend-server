const express = require("express");
const cors = require("cors");
const sqlite3 = require("sqlite3").verbose();
const path = require("path");
const fs = require("fs");

const app = express();
const port = 3000;

app.use(cors());
app.use(express.json());
app.use("/static", express.static("assets"));
// 画像などを置くassetsフォルダを公開
app.use("/assets", express.static(path.join(__dirname, "assets")));

// データベース接続
const db = new sqlite3.Database("./order_system.db", (err) => {
  if (err) {
    console.error("Database connection error:", err.message);
  } else {
    console.log(`サーバーが http://localhost:${port} で起動しました`);
    initDatabase();
  }
});

function initDatabase() {
  db.serialize(() => {
    // 注文テーブル
    db.run(
      `CREATE TABLE IF NOT EXISTS orders (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          table_number INTEGER NOT NULL,
          items TEXT NOT NULL,
          total_price REAL NOT NULL,
          status TEXT NOT NULL DEFAULT '注文受付', 
          timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
        )`
    );

    // メニューテーブル
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
        if (!err) {
          db.get("SELECT COUNT(*) as count FROM Menus", (err, row) => {
            if (row && row.count === 0) loadInitialMenuData();
          });
        }
      }
    );

    // 注文詳細テーブル (必要に応じて)
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
        )`
    );
  });
}

function loadInitialMenuData() {
  try {
    const menuJsonPath = path.join(__dirname, "data", "menu.json");
    if (fs.existsSync(menuJsonPath)) {
      const menuData = JSON.parse(fs.readFileSync(menuJsonPath, "utf-8"));
      const stmt = db.prepare(
        `INSERT INTO Menus (id, name, description, price, image, category, options, isRecommended) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      );
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
      console.log("初期メニューデータをロードしました");
    }
  } catch (err) {
    console.error("初期データロードエラー:", err);
  }
}

/* ================= API 定義 ================= */

// 1. メニュー一覧取得 (GET) ★これが消えていたため一覧が出なかった可能性があります
app.get("/api/menu", (req, res) => {
  db.all("SELECT * FROM Menus", [], (err, rows) => {
    if (err) return res.status(500).json({ error: "Database error" });

    // カテゴリごとにまとめる処理
    const categoriesMap = new Map();
    rows.forEach((item) => {
      if (!categoriesMap.has(item.category))
        categoriesMap.set(item.category, { name: item.category, items: [] });
      try {
        item.options = JSON.parse(item.options || "[]");
      } catch {
        item.options = [];
      }
      // SQLiteのBOOLEANは0/1なので変換
      item.isRecommended = item.isRecommended === 1;

      categoriesMap.get(item.category).items.push(item);
    });
    res.json({ categories: Array.from(categoriesMap.values()) });
  });
});

// 2. メニュー作成 (POST) ★新規追加
app.post("/api/menu", (req, res) => {
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

  if (!id || !name || price === undefined || !category) {
    return res
      .status(400)
      .json({ error: "必須項目(id, name, price, category)が不足しています" });
  }

  const optionsJson = JSON.stringify(options || []);
  const recommended = isRecommended ? 1 : 0;

  const sql = `INSERT INTO Menus (id, name, description, price, image, category, options, isRecommended) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;

  db.run(
    sql,
    [id, name, description, price, image, category, optionsJson, recommended],
    function (err) {
      if (err) {
        console.error("Menu create error:", err.message);
        return res.status(500).json({ error: err.message });
      }
      res.status(201).json({ message: "Menu created", id });
    }
  );
});

// 3. メニュー更新 (PUT) ★新規追加
app.put("/api/menu/:id", (req, res) => {
  const menuId = req.params.id;
  const { name, description, price, image, category, options, isRecommended } =
    req.body;

  // 更新する項目だけをSQLに組み込む
  let updates = [];
  let params = [];

  if (name !== undefined) {
    updates.push("name = ?");
    params.push(name);
  }
  if (description !== undefined) {
    updates.push("description = ?");
    params.push(description);
  }
  if (price !== undefined) {
    updates.push("price = ?");
    params.push(price);
  }
  if (image !== undefined) {
    updates.push("image = ?");
    params.push(image);
  }
  if (category !== undefined) {
    updates.push("category = ?");
    params.push(category);
  }
  if (options !== undefined) {
    updates.push("options = ?");
    params.push(JSON.stringify(options));
  }
  if (isRecommended !== undefined) {
    updates.push("isRecommended = ?");
    params.push(isRecommended ? 1 : 0);
  }

  if (updates.length === 0)
    return res.status(400).json({ error: "No fields to update" });

  const sql = `UPDATE Menus SET ${updates.join(", ")} WHERE id = ?`;
  params.push(menuId);

  db.run(sql, params, function (err) {
    if (err) return res.status(500).json({ error: err.message });
    if (this.changes === 0)
      return res.status(404).json({ error: "Menu not found" });
    res.json({ message: "Menu updated", id: menuId });
  });
});

// 4. メニュー削除 (DELETE) ★新規追加
app.delete("/api/menu/:id", (req, res) => {
  const menuId = req.params.id;
  db.run("DELETE FROM Menus WHERE id = ?", menuId, function (err) {
    if (err) return res.status(500).json({ error: err.message });
    if (this.changes === 0)
      return res.status(404).json({ error: "Menu not found" });
    res.json({ message: "Menu deleted", id: menuId });
  });
});

// --- 注文関連 API ---

app.post("/api/orders", (req, res) => {
  const { tableNumber, items } = req.body;
  const tableNumInt = parseInt(tableNumber, 10);
  if (isNaN(tableNumInt) || !items)
    return res.status(400).json({ error: "Invalid data" });

  const itemsJson = JSON.stringify(items);
  const timestamp = new Date().toISOString();
  // total_priceの計算は本来サーバー側で厳密に行うべきですが、ここでは簡易的にクライアント値を信用または再計算
  const totalPrice = items.reduce(
    (sum, i) => sum + (i.totalPrice || i.price * i.quantity),
    0
  );

  db.run(
    `INSERT INTO orders (table_number, items, total_price, timestamp, status) VALUES (?, ?, ?, ?, '注文受付')`,
    [tableNumInt, itemsJson, totalPrice, timestamp],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      res.status(201).json({
        id: this.lastID,
        table_number: tableNumInt,
        items,
        status: "注文受付",
        timestamp,
      });
    }
  );
});

app.get("/api/orders", (req, res) => {
  const tableNumber = req.query.tableNumber;
  db.all(
    "SELECT * FROM orders WHERE table_number = ? AND status != '会計済み' ORDER BY timestamp DESC",
    [tableNumber],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows);
    }
  );
});

app.get("/api/kitchen/orders", (req, res) => {
  const sql = `SELECT * FROM orders 
               WHERE status IN ('注文受付', '調理中', '調理完了', '提供済み', '呼び出し')
               ORDER BY timestamp ASC`;
  db.all(sql, [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.put("/api/orders/:id/status", (req, res) => {
  const orderId = req.params.id;
  const { status } = req.body;
  const allowedStatus = [
    "注文受付",
    "調理中",
    "調理完了",
    "提供済み",
    "会計済み",
    "キャンセル",
    "呼び出し",
    "KDS完了",
  ];

  if (!allowedStatus.includes(status))
    return res.status(400).json({ error: "Invalid status" });

  db.run(
    "UPDATE orders SET status = ? WHERE id = ?",
    [status, orderId],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ message: "Updated", id: orderId, status });
    }
  );
});

app.post("/api/call", (req, res) => {
  const { tableNumber } = req.body;
  db.run(
    "INSERT INTO orders (table_number, items, total_price, status) VALUES (?, ?, 0, '呼び出し')",
    [tableNumber, "[]"],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      res.status(201).json({ id: this.lastID });
    }
  );
});

app.get("/api/tables", (req, res) => {
  db.all(
    "SELECT DISTINCT table_number FROM orders WHERE status != '会計済み' ORDER BY table_number",
    [],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows.map((r) => r.table_number));
    }
  );
});

app.listen(port, "0.0.0.0", () => {
  console.log(`Server running at http://0.0.0.0:${port}/`);
});
