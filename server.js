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

app.options('/api/send-mail', (req, res) => res.sendStatus(204));

// blastengine BearerToken生成
// 手順: SHA256(ログインID + APIキー) → 小文字化 → base64エンコード
function generateBearerToken() {
  const combined = process.env.BE_USER_ID + process.env.BE_API_KEY;
  const sha256   = crypto.createHash('sha256').update(combined).digest('hex').toLowerCase();
  return Buffer.from(sha256).toString('base64');
}

const BE_API_URL = 'https://app.engn.jp/api/v1/sendings/transactional';

// ============================================================
// POST /api/send-mail
// ============================================================
app.post('/api/send-mail', async (req, res) => {
  if (req.headers['x-api-key'] !== process.env.API_KEY) {
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }

  const { from, to, bcc, subject, text } = req.body;

  if (!from || !to || !subject || !text) {
    return res.status(400).json({
      success: false,
      error: 'Missing required fields: from, to, subject, text',
    });
  }

  const toList  = Array.isArray(to)  ? to  : [to];
  const bccList = Array.isArray(bcc) ? bcc : (bcc ? [bcc] : []);

  try {
    const payload = {
      from: { email: from },
      to:   toList[0],
      subject,
      text_part: text,
    };

    // BCC が存在する場合に追加
    if (bccList.length > 0) {
      payload.bcc = bccList.map(email => ({ email }));
    }

    const response = await axios.post(BE_API_URL, payload, {
      headers: {
        'Authorization': `Bearer ${generateBearerToken()}`,
        'Content-Type':  'application/json',
      },
      timeout: 8000,
    });

    console.log(`[${new Date().toISOString()}] Mail sent: job_id=${response.data.job_id}`);
    res.json({ success: true, jobId: response.data.job_id });

  } catch (err) {
    const detail = err.response?.data || err.message;
    console.error(`[${new Date().toISOString()}] Mail send error:`, detail);
    res.status(500).json({
      success: false,
      error: typeof detail === 'object' ? JSON.stringify(detail) : detail,
    });
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
