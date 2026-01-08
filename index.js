/* backend-server/index.js - HTTPS + メンバー機能統合版 */
const express = require("express");
const https = require("https"); // HTTPS用
const cors = require("cors");
const sqlite3 = require("sqlite3").verbose();
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const sharp = require("sharp"); // ★メンバー追加: 画像処理用

const app = express();
const port = 443; // ★HTTPSポート

app.use(cors());
app.use(express.json());

// 画像などを置くassetsフォルダを公開
app.use("/static", express.static("assets"));
app.use("/assets", express.static(path.join(__dirname, "assets")));
app.use("/images", express.static(path.join(__dirname, "assets")));

// データベース接続
const db = new sqlite3.Database("./order_system.db", (err) => {
  if (err) {
    console.error("Database connection error:", err.message);
  } else {
    console.log(`データベースに接続しました`);
    initDatabase();
  }
});

// ★修正: メンバーのコードに合わせてメモリ保存に変更（sharpで加工するため）
const upload = multer({ storage: multer.memoryStorage() });

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

    const categoriesMap = new Map();
    rows.forEach((item) => {
      const formattedItem = {
        ...item,
        image: item.image || null,
        options: JSON.parse(item.options || "[]"),
        isRecommended: item.isRecommended === 1,
      };

      if (!categoriesMap.has(item.category)) {
        categoriesMap.set(item.category, { name: item.category, items: [] });
      }
      categoriesMap.get(item.category).items.push(formattedItem);
    });
    res.json({ categories: Array.from(categoriesMap.values()) });
  });
});

// 2. メニュー追加 (★メンバー機能: sharp対応版)
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

    let imageName = null;

    if (file) {
      const rootDir = path.resolve(__dirname, "assets"); // assetsフォルダの絶対パス

      // 保存先1: バックエンド自身のassets
      const backendDir = path.join(__dirname, "assets");

      // 保存先2: フロントエンド(管理画面)のpublic/assets (※フォルダ構成によりパス調整が必要な場合あり)
      // メンバーのコードにあったパス設定を使用
      const rootProjectDir = path.resolve(__dirname, ".."); // 一つ上の階層へ
      const frontendDir = path.join(
        rootProjectDir,
        "frontend-admin/kds-app/public/assets"
      );

      // 両方のフォルダがなければ作る
      [backendDir, frontendDir].forEach((dir) => {
        // frontendDirへのパスが見つからない場合のエラー回避
        try {
          if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        } catch (e) {
          console.warn(`フォルダ作成スキップ: ${dir}`);
        }
      });

      // 画像ファイル名の決定
      imageName = `assets/${id}.jpeg`; // DBにはパスとして保存
      const fileNameOnly = `${id}.jpeg`;

      // sharpで変換して保存
      const jpegBuffer = await sharp(file.buffer)
        .jpeg({ quality: 80 })
        .toBuffer();

      // バックエンドへ保存
      fs.writeFileSync(path.join(backendDir, fileNameOnly), jpegBuffer);

      // フロントエンドへ保存 (フォルダが存在する場合のみ)
      if (fs.existsSync(frontendDir)) {
        fs.writeFileSync(path.join(frontendDir, fileNameOnly), jpegBuffer);
      }
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

// 3. メニュー編集 (★メンバー機能: 画像更新対応)
app.post("/api/menu/:id", upload.single("imageFile"), async (req, res) => {
  try {
    const { id } = req.params;
    const body = req.body || {};
    const file = req.file;

    const name = body.name ?? null;
    const description = body.description ?? null;
    const price =
      body.price && !isNaN(parseFloat(body.price))
        ? parseFloat(body.price)
        : null;
    const category = body.category ?? null;

    const isRecommended =
      body.isRecommended !== undefined
        ? body.isRecommended === "true" || body.isRecommended === "1"
        : null;

    const hasUpdate =
      body.name !== undefined ||
      body.description !== undefined ||
      body.price !== undefined ||
      body.category !== undefined ||
      body.isRecommended !== undefined ||
      file;

    if (!hasUpdate) {
      return res.status(400).json({ error: "更新内容がありません" });
    }

    let imageName = body.image ?? null;

    if (file) {
      // 保存先の定義（追加時と同じロジック）
      const rootProjectDir = path.resolve(__dirname, "..");
      const backendDir = path.join(__dirname, "assets");
      const frontendDir = path.join(
        rootProjectDir,
        "frontend-admin/kds-app/public/assets"
      );

      [backendDir, frontendDir].forEach((dir) => {
        try {
          if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        } catch (e) {}
      });

      const fileNameOnly = `${id}.jpeg`;
      imageName = `assets/${fileNameOnly}`;

      const jpegBuffer = await sharp(file.buffer)
        .jpeg({ quality: 80 })
        .toBuffer();

      fs.writeFileSync(path.join(backendDir, fileNameOnly), jpegBuffer);
      if (fs.existsSync(frontendDir)) {
        fs.writeFileSync(path.join(frontendDir, fileNameOnly), jpegBuffer);
      }
    }

    // SQL構築 (COALESCEを使って、値がある場合のみ更新)
    db.run(
      `UPDATE Menus SET
        name = COALESCE(?, name),
        description = COALESCE(?, description),
        price = COALESCE(?, price),
        image = COALESCE(?, image),
        category = COALESCE(?, category),
        isRecommended = COALESCE(?, isRecommended)
      WHERE id = ?`,
      [
        name,
        description,
        price,
        imageName,
        category,
        isRecommended === null ? null : isRecommended ? 1 : 0,
        id,
      ],
      function (err) {
        if (err) {
          console.error("DB error:", err);
          return res.status(500).json({ error: err.message });
        }
        res.json({ message: "メニュー更新完了" });
      }
    );
  } catch (err) {
    console.error("POST error:", err);
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

// 6. 注文取得
app.get("/api/orders", (req, res) => {
  const tableNumber = req.query.tableNumber;
  db.all(
    "SELECT * FROM orders WHERE table_number = ? AND status != '会計済み' ORDER BY timestamp DESC",
    [tableNumber],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });

      const formattedRows = rows.map((row) => ({
        ...row,
        items: JSON.parse(row.items || "[]"),
      }));
      res.json(formattedRows);
    }
  );
});

// 7. KDS用 注文一覧
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

/* ========================================================== */
/* ★ HTTPSサーバー起動 (ここが重要！) */
/* ========================================================== */

// 証明書ファイルの読み込み
const sslOptions = {
  key: fs.readFileSync(path.join(__dirname, "server.key")),
  cert: fs.readFileSync(path.join(__dirname, "server.crt")),
};

// HTTPSサーバーを起動
https.createServer(sslOptions, app).listen(port, "0.0.0.0", () => {
  console.log(
    `HTTPS Server running on port ${port} (https://localhost:${port})`
  );
});
