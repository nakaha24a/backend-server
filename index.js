const express = require("express");
const cors = require("cors");
const sqlite3 = require("sqlite3").verbose(); // ★ 追加 1

const app = express();
const port = 3000;

// ★ 追加 2 (データベースファイルの名前と接続)
// 'order_system.db' という名前のファイルでデータベースを管理します
const db = new sqlite3.Database("./order_system.db", (err) => {
  if (err) {
    console.error(err.message);
  }
  console.log("データベース (order_system.db) に接続しました。");
});

db.serialize(() => {
  // 1. Menusテーブル
  db.run(
    `
    CREATE TABLE IF NOT EXISTS Menus (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      price INTEGER NOT NULL,
      category TEXT,
      is_sold_out BOOLEAN DEFAULT false
    )
  `,
    (err) => {
      if (err) return console.error("Menusテーブル作成エラー:", err.message);
      console.log("Menusテーブルを正常に（または既に）読み込みました。");

      // Menusテーブルのサンプルデータ挿入
      const checkSql = `SELECT COUNT(*) as count FROM Menus`;
      db.get(checkSql, (err, row) => {
        if (err) return console.error("Menusカウントエラー:", err.message);

        // もしデータが0件なら、サンプルデータを挿入
        if (row.count === 0) {
          console.log("Menusテーブルが空のため、サンプルデータを挿入します...");
          const insertSql = `INSERT INTO Menus (name, price, category, is_sold_out) VALUES (?, ?, ?, ?)`;

          db.run(insertSql, ["ビール", 500, "ドリンク", false]);
          db.run(insertSql, ["からあげ", 600, "フード", false]);
          db.run(insertSql, ["枝豆", 300, "フード", false]);

          console.log("サンプルデータを3件挿入しました。");
        }
      });
    }
  );

  // 2. Orders (注文伝票) テーブル
  db.run(
    `
    CREATE TABLE IF NOT EXISTS Orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      table_number INTEGER NOT NULL,
      status TEXT DEFAULT '調理中',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `,
    (err) => {
      if (err) return console.error("Ordersテーブル作成エラー:", err.message);
      console.log("Ordersテーブルを正常に（または既に）読み込みました。");
    }
  );

  // 3. OrderDetails (注文詳細) テーブル
  db.run(
    `
    CREATE TABLE IF NOT EXISTS OrderDetails (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL,
      menu_id INTEGER NOT NULL,
      quantity INTEGER NOT NULL,
      FOREIGN KEY (order_id) REFERENCES Orders (id),
      FOREIGN KEY (menu_id) REFERENCES Menus (id)
    )
  `,
    (err) => {
      if (err)
        return console.error("OrderDetailsテーブル作成エラー:", err.message);
      console.log("OrderDetailsテーブルを正常に（または既に）読み込みました。");
    }
  );
});
app.use(cors());
app.use(express.json());

app.get("/", (req, res) => {
  res.send("Hello World!");
});

// '/api/menu' の処理 (★ 内容を書き換え)
app.get("/api/menu", (req, res) => {
  const sql = "SELECT * FROM Menus WHERE is_sold_out = false"; // 品切れでないものだけ

  db.all(sql, [], (err, rows) => {
    if (err) {
      // もしデータベースエラーが起きたら
      console.error("メニュー取得エラー:", err.message);
      res.status(500).json({ error: err.message }); // 500エラーを返す
      return;
    }
    // 成功したら、取得したデータ(rows)をJSONで返す
    res.json(rows);
  });
});

app.post("/api/orders", (req, res) => {
  // フロントから送られてくるデータ
  // { table_number: 5, items: [ { id: 1, quantity: 2 }, { id: 3, quantity: 1 } ] }
  const { table_number, items } = req.body;

  if (!table_number || !items || items.length === 0) {
    // データが不十分な場合はエラーを返す
    return res
      .status(400)
      .json({ error: "テーブル番号と注文内容（items）は必須です。" });
  }

  // データベースへの保存処理
  db.serialize(() => {
    // 1. Ordersテーブルに伝票（親）を作成
    const orderSql = `INSERT INTO Orders (table_number) VALUES (?)`;

    // db.run は、実行後に this.lastID で今挿入したIDを取得できる
    db.run(orderSql, [table_number], function (err) {
      if (err) {
        console.error("Ordersテーブルへの挿入エラー:", err.message);
        return res.status(500).json({ error: err.message });
      }

      // ★重要★ 今作成した伝票(Order)のIDを取得
      const orderId = this.lastID;
      console.log(`新しい注文を作成しました。OrderId: ${orderId}`);

      // 2. OrderDetailsテーブルに明細（子）を挿入
      const detailSql = `INSERT INTO OrderDetails (order_id, menu_id, quantity) VALUES (?, ?, ?)`;
      const stmt = db.prepare(detailSql);

      // items配列の [ { id: 1, quantity: 2 }, ... ] をループ処理
      for (const item of items) {
        stmt.run(orderId, item.id, item.quantity);
      }

      // 処理を確定
      stmt.finalize((err) => {
        if (err) {
          console.error("OrderDetailsへの挿入エラー:", err.message);
          return res.status(500).json({ error: err.message });
        }

        // フロントエンドに「成功したよ」と返す
        console.log(`注文詳細 (OrderId: ${orderId}) の登録が完了しました。`);
        res.status(201).json({ success: true, orderId: orderId });
      });
    });
  });
});

app.get("/api/kitchen/orders", (req, res) => {
  // OrdersとOrderDetailsをくっつけて(JOIN)、
  // メニュー名(Menus.name)もくっつける(JOIN)。
  // ただし、statusが「調理中」のものだけ。
  const sql = `
    SELECT 
      O.id as order_id, 
      O.table_number, 
      O.status, 
      O.created_at,
      M.name as menu_name,
      OD.quantity
    FROM Orders O
    JOIN OrderDetails OD ON O.id = OD.order_id
    JOIN Menus M ON OD.menu_id = M.id
    WHERE O.status = '調理中'
    ORDER BY O.created_at ASC;
  `;

  db.all(sql, [], (err, rows) => {
    if (err) {
      console.error("厨房の注文一覧取得エラー:", err.message);
      return res.status(500).json({ error: err.message });
    }

    // このままだとデータがバラバラなので、注文ID(order_id)ごとにまとめる
    // { 1: { table_number: 5, items: [...] }, 2: { ... } }
    const ordersFormatted = {};
    rows.forEach((row) => {
      if (!ordersFormatted[row.order_id]) {
        // この注文IDが初めて出てきたら、器を作る
        ordersFormatted[row.order_id] = {
          order_id: row.order_id,
          table_number: row.table_number,
          status: row.status,
          created_at: row.created_at,
          items: [], // 注文明細を入れる配列
        };
      }
      // 器に明細（メニュー名と数量）を追加
      ordersFormatted[row.order_id].items.push({
        menu_name: row.menu_name,
        quantity: row.quantity,
      });
    });

    // オブジェクトを配列に変換して [ {...}, {...} ] の形にして返す
    res.json(Object.values(ordersFormatted));
  });
});

// (PUT /api/orders/:id/status) 注文のステータスを更新するAPI
app.put("/api/orders/:id/status", (req, res) => {
  // URLから注文IDを取得 (例: /api/orders/1/status -> idは 1)
  const orderId = req.params.id;

  // フロントから送られてくる新しいステータス
  // { "status": "提供済み" }
  const { status } = req.body;

  if (!status) {
    return res
      .status(400)
      .json({ error: "新しいステータス（status）は必須です。" });
  }

  const sql = `UPDATE Orders SET status = ? WHERE id = ?`;

  db.run(sql, [status, orderId], function (err) {
    if (err) {
      console.error("注文ステータスの更新エラー:", err.message);
      return res.status(500).json({ error: err.message });
    }

    // this.changes で「何件の行が更新されたか」が分かる
    if (this.changes === 0) {
      // 該当する注文IDがなかった場合
      return res.status(404).json({ error: "該当する注文が見つかりません。" });
    }

    console.log(
      `OrderId: ${orderId} のステータスを「${status}」に更新しました。`
    );
    res.json({ success: true, message: "ステータスを更新しました。" });
  });
});

app.post("/api/admin/menu", (req, res) => {
  // フロントから { name: "ハイボール", price: 450, category: "ドリンク" } のようなデータが送られてくる
  const { name, price, category } = req.body;

  if (!name || !price) {
    return res
      .status(400)
      .json({ error: "商品名（name）と価格（price）は必須です。" });
  }

  const sql = `INSERT INTO Menus (name, price, category) VALUES (?, ?, ?)`;

  db.run(sql, [name, price, category || null], function (err) {
    if (err) {
      console.error("メニュー登録エラー:", err.message);
      return res.status(500).json({ error: err.message });
    }

    // 成功したら、今登録した商品のIDと情報を返す
    console.log(`新しいメニューを登録しました。MenuId: ${this.lastID}`);
    res.status(201).json({
      success: true,
      id: this.lastID,
      name,
      price,
      category,
    });
  });
});

// (PUT /api/admin/menu/:id) 既存のメニュー項目を更新する
app.put("/api/admin/menu/:id", (req, res) => {
  const menuId = req.params.id;

  // フロントから { name, price, category, is_sold_out } のうち、
  // 変更したい項目だけが送られてくる
  const { name, price, category, is_sold_out } = req.body;

  // どの項目を更新するかを動的に組み立てる
  const updates = [];
  const values = [];

  if (name !== undefined) {
    updates.push("name = ?");
    values.push(name);
  }
  if (price !== undefined) {
    updates.push("price = ?");
    values.push(price);
  }
  if (category !== undefined) {
    updates.push("category = ?");
    values.push(category);
  }
  if (is_sold_out !== undefined) {
    updates.push("is_sold_out = ?");
    values.push(is_sold_out); // true または false
  }

  if (updates.length === 0) {
    // 送られてきたデータが空だった場合
    return res.status(400).json({ error: "更新するデータがありません。" });
  }

  // values の最後に menuId を追加 (WHERE句のため)
  values.push(menuId);

  // "name = ?, price = ?" のような文字列を生成
  const sql = `UPDATE Menus SET ${updates.join(", ")} WHERE id = ?`;

  db.run(sql, values, function (err) {
    if (err) {
      console.error("メニュー更新エラー:", err.message);
      return res.status(500).json({ error: err.message });
    }
    if (this.changes === 0) {
      return res
        .status(404)
        .json({ error: "該当するメニューが見つかりません。" });
    }

    console.log(`MenuId: ${menuId} を更新しました。`);
    res.json({ success: true, message: "メニューを更新しました。" });
  });
});

// (DELETE /api/admin/menu/:id) 既存のメニュー項目を削除する
app.delete("/api/admin/menu/:id", (req, res) => {
  const menuId = req.params.id;

  const sql = `DELETE FROM Menus WHERE id = ?`;

  db.run(sql, [menuId], function (err) {
    if (err) {
      console.error("メニュー削除エラー:", err.message);
      return res.status(500).json({ error: err.message });
    }
    if (this.changes === 0) {
      return res
        .status(404)
        .json({ error: "該当するメニューが見つかりません。" });
    }

    console.log(`MenuId: ${menuId} を削除しました。`);
    res.json({ success: true, message: "メニューを削除しました。" });
  });
});

app.listen(port, () => {
  console.log(`サーバーが http://localhost:${port} で起動しました`);
});
