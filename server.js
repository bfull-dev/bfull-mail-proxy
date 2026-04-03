// proxy-server/server.js
// 注文書メール送信プロキシAPI（Node.js + Express + nodemailer）

const express    = require('express');
const nodemailer = require('nodemailer');
require('dotenv').config();

const app = express();
app.use(express.json({ limit: '2mb' }));

// CORSヘッダー（kintone.proxy経由のため実際はkintoneサーバーから送信される）
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Api-Key');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  next();
});

app.options('/api/send-mail', (req, res) => res.sendStatus(204));

// SMTPトランスポーター初期化（コネクションプール + タイムアウト設定）
const transporter = nodemailer.createTransport({
  host:   process.env.SMTP_HOST,
  port:   parseInt(process.env.SMTP_PORT, 10),
  secure: process.env.SMTP_SECURE === 'true',
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
  pool:              true,   // コネクションを再利用してレイテンシ削減
  maxConnections:    3,
  connectionTimeout: 7000,   // 接続タイムアウト 7秒
  greetingTimeout:   7000,   // SMTPグリーティング待ち 7秒
  socketTimeout:     8000,   // ソケットタイムアウト 8秒
});

// サーバー起動時にSMTP接続を事前確立（コールドスタート対策）
transporter.verify((err) => {
  if (err) {
    console.error(`[${new Date().toISOString()}] SMTP verify error:`, err.message);
  } else {
    console.log(`[${new Date().toISOString()}] SMTP connection verified.`);
  }
});

// ============================================================
// POST /api/send-mail
// ============================================================
app.post('/api/send-mail', async (req, res) => {
  // APIキー認証
  if (req.headers['x-api-key'] !== process.env.API_KEY) {
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }

  const { from, to, bcc, subject, text } = req.body;

  // 必須パラメータチェック
  if (!from || !to || !subject || !text) {
    return res.status(400).json({
      success: false,
      error: 'Missing required fields: from, to, subject, text',
    });
  }

  // toが配列の場合はカンマ区切り文字列に変換
  const toField = Array.isArray(to) ? to.join(', ') : to;
  const bccField = Array.isArray(bcc) ? bcc.join(', ') : (bcc || '');

  try {
    const info = await transporter.sendMail({
      from,
      to:      toField,
      bcc:     bccField || undefined,
      subject,
      text,
    });

    console.log(`[${new Date().toISOString()}] Mail sent: ${info.messageId}`);
    res.json({ success: true, messageId: info.messageId });

  } catch (err) {
    console.error(`[${new Date().toISOString()}] Mail send error:`, err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ヘルスチェック
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

const PORT = parseInt(process.env.PORT || '3000', 10);
app.listen(PORT, () => {
  console.log(`[${new Date().toISOString()}] Mail proxy server listening on port ${PORT}`);
});
