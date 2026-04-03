// proxy-server/server.js
// 注文書メール送信プロキシAPI（Node.js + Express + blastengine）

const express = require('express');
const axios   = require('axios');
const crypto  = require('crypto');
require('dotenv').config();

const app = express();
app.use(express.json({ limit: '2mb' }));

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Api-Key');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  next();
});

app.options('/api/send-mail',  (req, res) => res.sendStatus(204));
app.options('/api/get-image',  (req, res) => res.sendStatus(204));

// blastengine BearerToken生成
// 手順: SHA256(ログインID + APIキー) → 小文字化 → base64エンコード
function generateBearerToken() {
  const combined = process.env.BE_USER_ID + process.env.BE_API_KEY;
  const sha256   = crypto.createHash('sha256').update(combined).digest('hex').toLowerCase();
  return Buffer.from(sha256).toString('base64');
}

const BE_API_URL  = 'https://app.engn.jp/api/v1/deliveries/transaction';
const BCC_CHUNK   = 10; // blastengine BCCは1リクエスト最大10件

// ============================================================
// POST /api/send-mail
// ============================================================
app.post('/api/send-mail', async (req, res) => {
  if (req.headers['x-api-key'] !== process.env.API_KEY) {
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }

  const { from, fromName, to, bcc, subject, text, html } = req.body;

  if (!from || !to || !subject || !text) {
    return res.status(400).json({
      success: false,
      error: 'Missing required fields: from, to, subject, text',
    });
  }

  const toList  = Array.isArray(to)  ? to  : [to];
  const bccList = Array.isArray(bcc) ? bcc : (bcc ? [bcc] : []);

  const token   = generateBearerToken();
  const headers = { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' };

  try {
    // BCCを10件ずつに分割して送信
    const bccChunks = [];
    if (bccList.length > 0) {
      for (let i = 0; i < bccList.length; i += BCC_CHUNK) {
        bccChunks.push(bccList.slice(i, i + BCC_CHUNK));
      }
    } else {
      bccChunks.push([]); // BCCなしで1回送信
    }

    const jobIds = [];
    for (const chunk of bccChunks) {
      const payload = {
        from:      { email: from, name: fromName || '株式会社Bfull 新商品案内' },
        to:        toList[0],
        subject,
        text_part: text,
      };
      if (html) payload.html_part = html;
      if (chunk.length > 0) {
        payload.bcc = chunk;
      }

      const response = await axios.post(BE_API_URL, payload, { headers, timeout: 8000 });
      jobIds.push(response.data.job_id);
      console.log(`[${new Date().toISOString()}] Mail sent: job_id=${response.data.job_id}`);
    }

    res.json({ success: true, jobIds });

  } catch (err) {
    const detail = err.response?.data || err.message;
    console.error(`[${new Date().toISOString()}] Mail send error:`, detail);
    res.status(500).json({
      success: false,
      error: typeof detail === 'object' ? JSON.stringify(detail) : detail,
    });
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
    const response = await axios.get(kintoneUrl, {
      headers: { 'X-Cybozu-API-Token': process.env.KINTONE_API_TOKEN },
      responseType: 'arraybuffer',
      timeout: 10000,
    });

    const contentType = response.headers['content-type'] || 'image/jpeg';
    const base64  = Buffer.from(response.data).toString('base64');
    const dataUrl = `data:${contentType};base64,${base64}`;

    console.log(`[${new Date().toISOString()}] Image fetched: fileKey=${fileKey.slice(0, 16)}... size=${response.data.byteLength}`);
    res.json({ success: true, dataUrl });

  } catch (err) {
    const detail = err.response?.data ? `HTTP ${err.response.status}` : err.message;
    console.error(`[${new Date().toISOString()}] Image fetch error:`, detail);
    res.status(500).json({ success: false, error: detail });
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
