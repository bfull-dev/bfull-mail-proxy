// proxy-server/server.js
// 注文書メール送信プロキシAPI（Node.js + Express + Resend）

const express = require('express');
const { Resend } = require('resend');
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

const resend = new Resend(process.env.RESEND_API_KEY);

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
    const { data, error } = await resend.emails.send({
      from,
      to:      toList,
      bcc:     bccList.length > 0 ? bccList : undefined,
      subject,
      text,
    });

    if (error) {
      console.error(`[${new Date().toISOString()}] Resend error:`, error);
      return res.status(500).json({ success: false, error: error.message });
    }

    console.log(`[${new Date().toISOString()}] Mail sent: ${data.id}`);
    res.json({ success: true, messageId: data.id });

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
