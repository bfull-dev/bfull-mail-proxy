// proxy-server/server.js
// 注文書メール送信プロキシAPI（Node.js + Express + blastengine HTTP APIリレー）
// 画像は Cloudflare R2 public bucket にアップロードし、公開URLをHTMLに埋め込む方式

const express = require('express');
const axios   = require('axios');
const crypto  = require('crypto');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { v4: uuidv4 } = require('uuid');
require('dotenv').config();

const app = express();
app.use(express.json({ limit: '20mb' }));

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Api-Key');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  next();
});

app.options('/api/send-mail', (req, res) => res.sendStatus(204));
app.options('/api/get-image', (req, res) => res.sendStatus(204));

// ============================================================
// Cloudflare R2 クライアント初期化
// ============================================================
const r2 = new S3Client({
  region:   'auto',
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId:     process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

// ============================================================
// R2 画像アップロード
// images: [{ filename, contentType, contentBase64 }, ...]
// 戻り値: 公開URL文字列の配列（images と同順）
//
// 将来の30日削除について:
//   アップロード時に Metadata['uploaded-at'] を付与しているため、
//   Cloudflare Workers Cron Trigger または外部cronから
//   ListObjectsV2 → (uploaded-at + 30日 < 現在) → DeleteObject
//   の処理を定期実行することで自動削除が可能。
// ============================================================
async function uploadImagesToR2(images) {
  const prefix  = process.env.R2_IMAGE_PREFIX || 'mail-images';
  const bucket  = process.env.R2_BUCKET_NAME;
  const baseUrl = process.env.R2_PUBLIC_BASE_URL;
  const now     = new Date();
  const yyyyMM  = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const urls    = [];

  if (!bucket)  throw new Error('R2_BUCKET_NAME が設定されていません');
  if (!baseUrl) throw new Error('R2_PUBLIC_BASE_URL が設定されていません');

  for (const image of images) {
    const uuid = uuidv4();
    const key  = `${prefix}/${yyyyMM}/${uuid}.jpg`;
    const buf  = Buffer.from(image.contentBase64, 'base64');

    try {
      await r2.send(new PutObjectCommand({
        Bucket:      bucket,
        Key:         key,
        Body:        buf,
        ContentType: image.contentType || 'image/jpeg',
        Metadata: {
          'uploaded-at':    now.toISOString(),
          'retention-days': String(process.env.IMAGE_RETENTION_DAYS || '30'),
        },
      }));

      const url = `${baseUrl}/${key}`;
      urls.push(url);
      console.log(`[${new Date().toISOString()}] R2 upload OK: key=${key} size=${buf.length}`);
    } catch (e) {
      console.error(`[${new Date().toISOString()}] R2 upload FAILED: key=${key}`, e.message);
      throw new Error(`R2アップロード失敗 (${image.filename || 'unknown'}): ${e.message}`);
    }
  }

  return urls;
}

// ============================================================
// blastengine Bearer トークン生成
// SHA256(userId + apiKey).toLowerCase() → Base64
// ============================================================
function buildBEToken() {
  const userId = process.env.BE_USER_ID || '';
  const apiKey = process.env.BE_API_KEY || '';
  const hash   = crypto.createHash('sha256').update(userId + apiKey).digest('hex').toLowerCase();
  return Buffer.from(hash).toString('base64');
}

const BE_API_BASE = 'https://app.engn.jp/api/v1';
const BCC_CHUNK   = 10; // BCCは1送信あたり最大10件

// ============================================================
// POST /api/send-mail
// リクエストボディ:
//   from, fromName, to, bcc, subject, text, html
//   images: [{ filename, contentType, contentBase64 }, ...]
// html 内の {{IMAGE_URL_1}}, {{IMAGE_URL_2}} ... を R2公開URLに置換して送信
// ============================================================
app.post('/api/send-mail', async (req, res) => {
  if (req.headers['x-api-key'] !== process.env.API_KEY) {
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }

  const { from, fromName, to, bcc, subject, text, html, images } = req.body;

  if (!from || !to || !subject || !text) {
    return res.status(400).json({
      success: false,
      error: 'Missing required fields: from, to, subject, text',
    });
  }

  const toList  = Array.isArray(to)  ? to  : [to];
  const bccList = Array.isArray(bcc) ? bcc : (bcc ? [bcc] : []);

  // ---- R2 画像アップロード & HTML placeholder 置換 ----
  let processedHtml = html || '';
  let imageUrls = [];

  if (Array.isArray(images) && images.length > 0) {
    console.log(`[${new Date().toISOString()}] R2 upload start: ${images.length}件`);
    try {
      imageUrls = await uploadImagesToR2(images);
      imageUrls.forEach((url, idx) => {
        processedHtml = processedHtml.replaceAll(`{{IMAGE_URL_${idx + 1}}}`, url);
      });
      console.log(`[${new Date().toISOString()}] R2 upload complete: ${imageUrls.length}件`);
    } catch (uploadErr) {
      console.error(`[${new Date().toISOString()}] R2 upload error:`, uploadErr.message);
      return res.status(500).json({ success: false, error: uploadErr.message });
    }
  }

  const token   = buildBEToken();
  const headers = {
    'Authorization': `Bearer ${token}`,
    'Content-Type':  'application/json',
  };

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

    const jobIds = [];

    for (const chunk of bccChunks) {
      const payload = {
        from: {
          email: from,
          name:  fromName || '',
        },
        to: toList.map(email => ({ email })),
        subject,
        text_part: text,
        html_part: processedHtml || undefined,
      };

      if (chunk.length > 0) {
        payload.bcc = chunk.map(email => ({ email }));
      }

      const response = await axios.post(
        `${BE_API_BASE}/deliveries/transaction`,
        payload,
        { headers, timeout: 30000 }
      );

      const jobId = response.data?.job_id ?? response.data?.delivery_id ?? JSON.stringify(response.data);
      jobIds.push(jobId);
      console.log(`[${new Date().toISOString()}] Mail sent: job_id=${jobId} bcc=${chunk.length}件 images=${imageUrls.length}件`);
    }

    res.json({ success: true, jobIds, imageUrls });

  } catch (err) {
    const detail = err.response
      ? `HTTP ${err.response.status}: ${JSON.stringify(err.response.data)}`
      : err.message;
    console.error(`[${new Date().toISOString()}] Mail send error:`, detail);
    res.status(500).json({ success: false, error: detail });
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
