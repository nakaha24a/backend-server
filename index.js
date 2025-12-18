/* backend-server/index.js - 完全修正版 */
const express = require("express");
const cors = require("cors");
const sqlite3 = require("sqlite3").verbose();
const path = require("path");
const fs = require("fs");

const app = express();
const port = 3000;

app.use(cors());
app.use(express.json());

// 画像などを置くassetsフォルダを公開 (複数のパスに対応)
app.use("/static", express.static("assets"));
app.use("/assets", express.static(path.join(__dirname, "assets")));
app.use("/images", express.static(path.join(__dirname, "assets")));

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
          // データが空なら初期データをロード
          db.get("SELECT COUNT(*) as count FROM Menus", (err, row) => {
            if (row && row.count === 0) loadInitialMenuData();
          });
        }
      }
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
            item.isRecommended ? 1 : 0
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

// 1. メニュー一覧取得
app.get("/api/menu", (req, res) => {
  db.all("SELECT * FROM Menus", [], (err, rows) => {
    if (err) return res.status(500).json({ error: "Database error" });

    // カテゴリごとにまとめる処理
    const categoriesMap = new Map();
    rows.forEach((item) => {
      // データの整形
      const formattedItem = {
        ...item,
        options: JSON.parse(item.options || "[]"),
        isRecommended: item.isRecommended === 1, // 0/1 を true/false に変換
      };

      if (!categoriesMap.has(item.category)) {
        categoriesMap.set(item.category, { name: item.category, items: [] });
      }
      categoriesMap.get(item.category).items.push(formattedItem);
    });
    res.json({ categories: Array.from(categoriesMap.values()) });
  });
});


// 2. メニュー追加 (★ここが重要：新規作成用)

const sharp = require("sharp");
const multer = require("multer");
const upload = multer({ storage: multer.memoryStorage() });

app.post("/api/menu", upload.single("imageFile"), async (req, res) => {
  try {
    const body = req.body || {};
    const file = req.file;

    const { id, name, description = "", category } = body;
    const price = parseFloat(body.price);
    const isRecommended =
      body.isRecommended === "true" || body.isRecommended === "1";

    if (!id || !name || !category || isNaN(price)) {
      return res.status(400).json({ error: "必須項目が不足しています" });
    }

    let options = [];
    if (body.options) options = JSON.parse(body.options);

    let imageName = "";

    if (file) {
      const rootDir = path.resolve(__dirname, "..");

      const backendDir = path.join(rootDir, "backend-server/assets");
      const frontendDir = path.join(
        rootDir,
        "frontend-admin/kds-app/public/assets"
      );

      [backendDir, frontendDir].forEach((dir) => {
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      });

      // ★ jpeg 拡張子
      imageName = `menu_${id}.jpeg`;

      const jpegBuffer = await sharp(file.buffer)
        .jpeg({ quality: 80 })
        .toBuffer();

      fs.writeFileSync(path.join(backendDir, imageName), jpegBuffer);
      fs.writeFileSync(path.join(frontendDir, imageName), jpegBuffer);
    }

    db.run(
      `INSERT INTO Menus
       (id, name, description, price, image, category, options, isRecommended)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        name,
        description,
        price,
        imageName,
        category,
        JSON.stringify(options),
        isRecommended ? 1 : 0,
      ],
      (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.status(201).json({ message: "メニューを追加しました" });
      }
    );
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "メニュー作成失敗" });
  }
});



// 3. メニュー編集 (★修正: isRecommendedも更新できるように)

// メニュー更新 API

app.put("/api/menu/:id", upload.single("imageFile"), async (req, res) => {
  try {
    const { id } = req.params;
    const body = req.body;
    const file = req.file;

    const name = body.name;
    const description = body.description || "";
    const price = parseFloat(body.price);
    const category = body.category;
    const isRecommended =
      body.isRecommended === "true" || body.isRecommended === "1";

    if (!name || !category || isNaN(price)) {
      return res.status(400).json({ error: "必須項目が不足しています" });
    }

    let imageName = body.image || "";

    if (file) {
      const rootDir = path.resolve(__dirname, "..");

      const backendDir = path.join(rootDir, "backend-server/assets");
      const frontendDir = path.join(
        rootDir,
        "frontend-admin/kds-app/public/assets"
      );

      [backendDir, frontendDir].forEach((dir) => {
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      });

      // ★ jpeg 拡張子
      imageName = `menu_${id}.jpeg`;

      const jpegBuffer = await sharp(file.buffer)
        .jpeg({ quality: 80 })
        .toBuffer();

      fs.writeFileSync(path.join(backendDir, imageName), jpegBuffer);
      fs.writeFileSync(path.join(frontendDir, imageName), jpegBuffer);
    }

    db.run(
      `UPDATE Menus
       SET name=?, description=?, price=?, image=?, category=?, isRecommended=?
       WHERE id=?`,
      [
        name,
        description,
        price,
        imageName,
        category,
        isRecommended ? 1 : 0,
        id,
      ],
      function (err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ message: "メニュー更新完了" });
      }
    );
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "メニュー更新失敗" });
  }
});


// 4. メニュー削除
app.delete("/api/menu/:id", (req, res) => {
  const { id } = req.params;
  db.run(`DELETE FROM Menus WHERE id=?`, [id], function (err) {
    if (err) return res.status(500).json({ error: err.message });
    if (this.changes === 0)
      return res.status(404).json({ error: "該当メニューがありません" });
    res.json({ message: "メニューを削除しました", id });
  });
});


// 5. 注文作成
app.post("/api/orders", (req, res) => {
  const { tableNumber, items } = req.body;
  const tableNumInt = parseInt(tableNumber, 10);
  if (isNaN(tableNumInt) || !items)
    return res.status(400).json({ error: "Invalid data" });

  const itemsJson = JSON.stringify(items);
  const timestamp = new Date().toISOString();
  // 合計金額の計算
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


// 6. 注文取得 (Resto-app用: 自分のテーブルの注文)
app.get("/api/orders", (req, res) => {
  const tableNumber = req.query.tableNumber;
  db.all(
    "SELECT * FROM orders WHERE table_number = ? AND status != '会計済み' ORDER BY timestamp DESC",
    [tableNumber],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });

      // items文字列をJSONに戻して返す
      const formattedRows = rows.map((row) => ({
        ...row,
        items: JSON.parse(row.items || "[]"),
      }));
      res.json(formattedRows);
    }
  );
});


// 7. KDS用 注文一覧 (全テーブル)
app.get("/api/kitchen/orders", (req, res) => {
  const sql = `SELECT * FROM orders 
               WHERE status IN ('注文受付', '調理中', '調理完了', '提供済み', '呼び出し')
               ORDER BY timestamp ASC`;
  db.all(sql, [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });

    const formattedRows = rows.map((row) => ({
      ...row,
      items: JSON.parse(row.items || "[]"),
    }));
    res.json(formattedRows);
  });
});


// 8. ステータス更新
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


// 9. 呼び出し機能
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


// 10. テーブル一覧取得
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
  console.log(`Server running on port ${port}`);
});
