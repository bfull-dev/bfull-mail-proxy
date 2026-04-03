// proxy-server/server.js
// 注文書メール送信プロキシAPI（Node.js + Express + Nodemailer + blastengine SMTPリレー）

const express    = require('express');
const axios      = require('axios');
const nodemailer = require('nodemailer');
require('dotenv').config();

const app = express();
app.use(express.json({ limit: '10mb' }));

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Api-Key');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  next();
});

app.options('/api/send-mail', (req, res) => res.sendStatus(204));
app.options('/api/get-image', (req, res) => res.sendStatus(204));

// Nodemailer SMTP transporter（blastengine SMTPリレー）
const transporter = nodemailer.createTransport({
  host:   process.env.SMTP_HOST,
  port:   parseInt(process.env.SMTP_PORT || '587', 10),
  secure: process.env.SMTP_SECURE === 'true', // ポート465の場合 true
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

const BCC_CHUNK = 10; // BCCは1送信あたり最大10件

// ============================================================
// POST /api/send-mail
// ============================================================
app.post('/api/send-mail', async (req, res) => {
  if (req.headers['x-api-key'] !== process.env.API_KEY) {
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }

  const { from, fromName, to, bcc, subject, text, html, attachments } = req.body;

  if (!from || !to || !subject || !text) {
    return res.status(400).json({
      success: false,
      error: 'Missing required fields: from, to, subject, text',
    });
  }

  const toList  = Array.isArray(to)  ? to  : [to];
  const bccList = Array.isArray(bcc) ? bcc : (bcc ? [bcc] : []);

  // attachments: [{ filename, contentType, contentBase64, cid }, ...]
  // Nodemailer 形式に変換
  const mailAttachments = Array.isArray(attachments)
    ? attachments.map(att => ({
        filename:    att.filename,
        content:     Buffer.from(att.contentBase64, 'base64'),
        contentType: att.contentType,
        cid:         att.cid,
      }))
    : [];

  try {
    // BCCを10件ずつ分割して送信
    const bccChunks = [];
    if (bccList.length > 0) {
      for (let i = 0; i < bccList.length; i += BCC_CHUNK) {
        bccChunks.push(bccList.slice(i, i + BCC_CHUNK));
      }
    } else {
      bccChunks.push([]); // BCCなしで1回送信
    }

    const messageIds = [];
    for (const chunk of bccChunks) {
      const mailOptions = {
        from:        fromName ? `"${fromName}" <${from}>` : from,
        to:          toList.join(', '),
        subject,
        text,
        html:        html || undefined,
        attachments: mailAttachments,
      };
      if (chunk.length > 0) {
        mailOptions.bcc = chunk.join(', ');
      }

      const info = await transporter.sendMail(mailOptions);
      messageIds.push(info.messageId);
      console.log(`[${new Date().toISOString()}] Mail sent: messageId=${info.messageId} bcc=${chunk.length}件`);
    }

    res.json({ success: true, messageIds });

  } catch (err) {
    console.error(`[${new Date().toISOString()}] Mail send error:`, err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================================
// POST /api/get-image  kintone添付ファイルをbase64で取得
// ============================================================
app.post('/api/get-image', async (req, res) => {
  if (req.headers['x-api-key'] !== process.env.API_KEY) {
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }

  const { fileKey } = req.body;
  if (!fileKey) {
    return res.status(400).json({ success: false, error: 'fileKey required' });
  }

  const kintoneUrl = `https://${process.env.KINTONE_DOMAIN}/k/v1/file?fileKey=${encodeURIComponent(fileKey)}`;

  try {
    const authHeaders = {};
    if (process.env.KINTONE_LOGIN_NAME && process.env.KINTONE_PASSWORD) {
      const cred = Buffer.from(`${process.env.KINTONE_LOGIN_NAME}:${process.env.KINTONE_PASSWORD}`).toString('base64');
      authHeaders['X-Cybozu-Authorization'] = cred;
    } else {
      authHeaders['X-Cybozu-API-Token'] = process.env.KINTONE_API_TOKEN;
    }

    const response = await axios.get(kintoneUrl, {
      headers: authHeaders,
      responseType: 'arraybuffer',
      timeout: 10000,
    });

    const contentType = response.headers['content-type'] || 'image/jpeg';
    const base64  = Buffer.from(response.data).toString('base64');
    const dataUrl = `data:${contentType};base64,${base64}`;

    console.log(`[${new Date().toISOString()}] Image fetched: fileKey=${fileKey.slice(0, 16)}... size=${response.data.byteLength}`);
    res.json({ success: true, dataUrl });

  } catch (err) {
    let detail = err.message;
    if (err.response) {
      const body = err.response.data
        ? Buffer.from(err.response.data).toString('utf-8')
        : '';
      detail = `HTTP ${err.response.status}: ${body}`;
    }
    console.error(`[${new Date().toISOString()}] Image fetch error (url=${kintoneUrl}):`, detail);
    res.status(500).json({ success: false, error: `HTTP ${err.response?.status || err.message}` });
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
