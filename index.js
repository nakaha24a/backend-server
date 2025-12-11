const express = require("express");
const cors = require("cors");
const sqlite3 = require("sqlite3").verbose();
const path = require("path");
const fs = require("fs");

const app = express();
const port = 3000;

app.use(cors());
app.use(express.json());

app.use("/assets", express.static(path.join(__dirname, "assets")));

const db = new sqlite3.Database("./order_system.db", (err) => {
  if (err) {
    console.error("Database connection error:", err.message);
  } else {
    console.log(`サーバーが http://localhost:${port} で起動しました`);

    db.serialize(() => {
      // 古いテーブル削除（念のため）
      // db.run("DROP TABLE IF EXISTS OrderDetails");

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
});

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
    }
  } catch (err) {
    console.error(err);
  }
}

// API
app.get("/api/menu", (req, res) => {
  db.all("SELECT * FROM Menus", [], (err, rows) => {
    if (err) return res.status(500).json({ error: "Error" });
    const categoriesMap = new Map();
    rows.forEach((item) => {
      if (!categoriesMap.has(item.category))
        categoriesMap.set(item.category, { name: item.category, items: [] });
      try {
        item.options = JSON.parse(item.options || "[]");
      } catch {
        item.options = [];
      }
      categoriesMap.get(item.category).items.push(item);
    });
    res.json({ categories: Array.from(categoriesMap.values()) });
  });
});

//追加したAPI
// メニュー編集 
app.put("/api/menu/:id", (req, res) => {
  const { id } = req.params;
  const { name, description, price, image, category } = req.body;

  // バリデーション（必須項目チェック）
  if (!name || !category || price === undefined) {
    return res.status(400).json({ error: "name, category, price は必須です" });
  }

  db.run(
    `UPDATE Menus SET name=?, description=?, price=?, image=?, category=? WHERE id=?`,
    [name, description, price, image, category, id],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      if (this.changes === 0) return res.status(404).json({ error: "該当メニューがありません" });

      res.json({
        message: "メニューを更新しました",
        menu: { id, name, description, price, image, category },
      });
    }
  );
});

// メニュー削除
app.delete("/api/menu/:id", (req, res) => {
  const { id } = req.params;

  db.run(`DELETE FROM Menus WHERE id=?`, [id], function (err) {
    if (err) return res.status(500).json({ error: err.message });
    if (this.changes === 0) return res.status(404).json({ error: "該当メニューがありません" });

    res.json({ message: "メニューを削除しました", id });
  });
});

//追加ここまで


app.post("/api/orders", (req, res) => {
  const { tableNumber, items } = req.body;
  const tableNumInt = parseInt(tableNumber, 10);
  if (isNaN(tableNumInt) || !items)
    return res.status(400).json({ error: "Invalid data" });

  const itemsJson = JSON.stringify(items);
  const timestamp = new Date().toISOString();
  const totalPrice = items.reduce((sum, i) => sum + i.totalPrice, 0); // 簡易計算

  db.run(
    `INSERT INTO orders (table_number, items, total_price, timestamp, status) VALUES (?, ?, ?, ?, '注文受付')`,
    [tableNumInt, itemsJson, totalPrice, timestamp],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      res
        .status(201)
        .json({
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
  // 顧客側: 会計済み以外を表示
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
  // ★ 店舗側: 'KDS完了' や '会計済み' 以外を表示
  // 呼び出し、注文受付、調理中、調理完了、提供済み を取得
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
  // ★ すべてのステータスを許可
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

// メニューAPI等は省略（変更なし）

app.listen(port, "0.0.0.0", () => {});
