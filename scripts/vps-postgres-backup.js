'use strict';

/**
 * PostgreSQL Automated Backup & Google Drive Cloud Sync
 * Backs up return-scan_youthnic (host PostgreSQL 16) + compresses with gzip.
 * Uploads chunk-by-chunk to Google Drive and alerts via WhatsApp.
 * Uses native Node 20 fetch and crypto with zero external npm dependencies.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const GDRIVE_FOLDER_ID = process.env.GDRIVE_FOLDER_ID || '1xLtHfQvW70rV7VWVjtZP6u2S9ZqEKF_v';
const LOCAL_BACKUP_DIR = process.env.LOCAL_BACKUP_DIR || '/opt/backups/postgres';
const RETENTION_COUNT = parseInt(process.env.BACKUP_RETENTION_COUNT || '1', 10);

// WhatsApp Alert Configuration
const WA_URL = process.env.WHATSAPP_API_URL || 'https://wa.youthnic.shop';
const WA_AUTH = process.env.WHATSAPP_BASIC_AUTH || 'returnorders@vbexports.co.in:Xchange4WA$';
const WA_GROUP = process.env.WHATSAPP_GROUP_JID || '919825149497-1631941133@g.us';
const WA_TAG_USER = process.env.WHATSAPP_TAG_USER_JID || '916306361624@s.whatsapp.net';

function log(msg, ...args) {
  const istDate = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
  console.log(`[${istDate} IST] ${msg}`, ...args);
}

function errorLog(msg, ...args) {
  const istDate = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
  console.error(`[${istDate} IST] [ERROR] ${msg}`, ...args);
}

async function sendWhatsAppAlert(message) {
  try {
    const authB64 = Buffer.from(WA_AUTH).toString('base64');
    await fetch(`${WA_URL}/send/message`, {
      method: 'POST',
      headers: {
        authorization: `Basic ${authB64}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        phone: WA_GROUP,
        message,
        mentions: [WA_TAG_USER],
      }),
    });
  } catch (err) {
    errorLog('Failed to dispatch WhatsApp alert:', err.message);
  }
}

function getServiceAccountCredentials() {
  const saFile = '/opt/postgres-backup/service_account.json';
  if (fs.existsSync(saFile)) {
    return JSON.parse(fs.readFileSync(saFile, 'utf8'));
  }
  let raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON || process.env.AJIO_GDRIVE_SA_JSON;
  if (!raw) {
    throw new Error('Service account file not found: ' + saFile);
  }
  if (typeof raw === 'object' && raw !== null) return raw;
  try {
    let s = String(raw).trim();
    if ((s.startsWith("'") && s.endsWith("'")) || (s.startsWith('"') && s.endsWith('"'))) {
      s = s.slice(1, -1).trim();
    }
    return JSON.parse(s);
  } catch (err) {
    throw new Error('Failed to parse GOOGLE_SERVICE_ACCOUNT_JSON: ' + err.message);
  }
}

async function getDriveAccessToken() {
  const creds = getServiceAccountCredentials();
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const claim = {
    iss: creds.client_email,
    scope: 'https://www.googleapis.com/auth/drive',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now,
  };
  const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const unsigned = `${b64(header)}.${b64(claim)}`;
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(unsigned);
  const signature = signer.sign(creds.private_key, 'base64url');
  const jwt = `${unsigned}.${signature}`;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }).toString(),
  });

  const json = await res.json();
  if (!json.access_token) {
    throw new Error(`OAuth token generation failed: ${JSON.stringify(json)}`);
  }
  return json.access_token;
}

async function checkFolderAccess(token, folderId) {
  const res = await fetch(`https://www.googleapis.com/drive/v3/files/${folderId}?supportsAllDrives=true&fields=id,name`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (res.status === 200) {
    return { ok: true, data: await res.json() };
  }
  return { ok: false, status: res.status, error: await res.text() };
}

async function uploadToDriveResumable(token, filePath, fileName, folderId) {
  const stat = fs.statSync(filePath);
  const fileSize = stat.size;
  const mimeType = 'application/gzip';

  log(`Initiating Google Drive resumable upload for ${fileName} (${(fileSize / (1024 * 1024)).toFixed(2)} MB)...`);

  const initRes = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json; charset=UTF-8',
      'x-upload-content-type': mimeType,
      'x-upload-content-length': String(fileSize),
    },
    body: JSON.stringify({
      name: fileName,
      parents: [folderId],
    }),
  });

  if (initRes.status !== 200) {
    throw new Error(`Failed to initiate resumable session (${initRes.status}): ${await initRes.text()}`);
  }

  const uploadUrl = initRes.headers.get('location');
  if (!uploadUrl) {
    throw new Error('Google Drive API did not return Location header');
  }

  const CHUNK_SIZE = 10 * 1024 * 1024; // 10 MB chunks
  const fd = fs.openSync(filePath, 'r');
  let offset = 0;
  let resultFile = null;

  while (offset < fileSize) {
    const chunkLength = Math.min(CHUNK_SIZE, fileSize - offset);
    const buffer = Buffer.alloc(chunkLength);
    fs.readSync(fd, buffer, 0, chunkLength, offset);
    const end = offset + chunkLength - 1;
    const pct = Math.round((offset / fileSize) * 100);

    log(`Uploading chunk: ${offset} - ${end} / ${fileSize} bytes (${pct}%)...`);

    let attempts = 0;
    let success = false;

    while (attempts < 3 && !success) {
      attempts++;
      try {
        const chunkRes = await fetch(uploadUrl, {
          method: 'PUT',
          headers: {
            'content-range': `bytes ${offset}-${end}/${fileSize}`,
            'content-length': String(chunkLength),
            'content-type': mimeType,
          },
          body: buffer,
        });

        if (chunkRes.status === 200 || chunkRes.status === 201) {
          resultFile = await chunkRes.json();
          success = true;
          break;
        } else if (chunkRes.status === 308) {
          success = true;
          offset += chunkLength;
          break;
        } else {
          errorLog(`Chunk upload status ${chunkRes.status}, attempt ${attempts}/3`);
          if (attempts < 3) await new Promise((r) => setTimeout(r, 2000 * attempts));
        }
      } catch (err) {
        errorLog(`Network error on chunk attempt ${attempts}/3: ${err.message}`);
        if (attempts < 3) await new Promise((r) => setTimeout(r, 2000 * attempts));
      }
    }

    if (!success) {
      fs.closeSync(fd);
      throw new Error(`Failed chunk upload at offset ${offset} after 3 attempts`);
    }

    if (resultFile) break;
  }

  fs.closeSync(fd);
  log(`Google Drive upload finished: File ID ${resultFile?.id}`);
  return resultFile;
}

async function cleanOldDriveBackups(token, folderId) {
  log(`Cleaning old backups in Google Drive (retaining newest ${RETENTION_COUNT})...`);
  try {
    const res = await fetch(
      `https://www.googleapis.com/drive/v3/files?q='${folderId}'+in+parents+and+trashed=false&supportsAllDrives=true&fields=files(id,name,createdTime)&orderBy=createdTime+desc&pageSize=100`,
      { headers: { authorization: `Bearer ${token}` } }
    );
    if (res.status === 200) {
      const { files = [] } = await res.json();
      log(`Total backup files found in folder: ${files.length}`);
      for (const f of files) {
        log(` - ${f.name} (ID: ${f.id}, created: ${f.createdTime})`);
      }
      if (files.length > RETENTION_COUNT) {
        const toDelete = files.slice(RETENTION_COUNT);
        for (const file of toDelete) {
          log(`Deleting expired backup from Google Drive: ${file.name} (ID: ${file.id})...`);
          const delRes = await fetch(`https://www.googleapis.com/drive/v3/files/${file.id}?supportsAllDrives=true`, {
            method: 'DELETE',
            headers: { authorization: `Bearer ${token}` },
          });
          log(`Deleted expired backup: ${file.name} (HTTP ${delRes.status})`);
        }
      } else {
        log(`No older backups need purging (${files.length} <= ${RETENTION_COUNT}).`);
      }
    }
  } catch (err) {
    errorLog('Error cleaning old drive backups:', err.message);
  }
}

function dumpDatabase(outputPath) {
  return new Promise((resolve, reject) => {
    log('Executing compressed database dump: pg_dump return-scan_youthnic | gzip...');
    const startTime = Date.now();
    const outStream = fs.createWriteStream(outputPath);

    const pgDump = spawn('sudo', ['-u', 'postgres', 'pg_dump', 'return-scan_youthnic']);
    const gzip = spawn('gzip');

    pgDump.stdout.pipe(gzip.stdin);
    gzip.stdout.pipe(outStream);

    let errData = '';
    pgDump.stderr.on('data', (d) => { errData += d.toString(); });
    gzip.stderr.on('data', (d) => { errData += d.toString(); });

    gzip.on('close', (code) => {
      outStream.close();
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      if (code === 0) {
        const stat = fs.statSync(outputPath);
        const mb = (stat.size / (1024 * 1024)).toFixed(2);
        log(`Dump and gzip completed in ${elapsed}s. Size: ${mb} MB (${stat.size} bytes).`);
        resolve({ path: outputPath, size: stat.size, mb, elapsed });
      } else {
        reject(new Error(`Dump/gzip failed with code ${code}: ${errData}`));
      }
    });

    pgDump.on('error', reject);
    gzip.on('error', reject);
  });
}

async function run() {
  log('================================================================');
  log('Starting PostgreSQL Automated Backup & Google Drive Sync Job');
  log(`Database: return-scan_youthnic (host PostgreSQL 16)`);
  log(`Drive Folder: ${GDRIVE_FOLDER_ID}`);
  log('================================================================');

  if (!fs.existsSync(LOCAL_BACKUP_DIR)) {
    fs.mkdirSync(LOCAL_BACKUP_DIR, { recursive: true });
  }

  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const dateStr = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const timeStr = `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  const fileName = `return_scan_youthnic_${dateStr}_${timeStr}.sql.gz`;
  const localFilePath = path.join(LOCAL_BACKUP_DIR, fileName);

  const token = await getDriveAccessToken();
  const folderCheck = await checkFolderAccess(token, GDRIVE_FOLDER_ID);
  if (!folderCheck.ok) {
    throw new Error(`Target Google Drive folder ${GDRIVE_FOLDER_ID} inaccessible: ${folderCheck.error}`);
  }
  log(`Target Google Drive folder verified: "${folderCheck.data?.name}"`);

  // 1. Dump & gzip
  const dumpRes = await dumpDatabase(localFilePath);

  // 2. Upload to Google Drive
  let uploadResult;
  try {
    uploadResult = await uploadToDriveResumable(token, localFilePath, fileName, GDRIVE_FOLDER_ID);
  } catch (err) {
    errorLog('Upload failed, preserving local backup:', localFilePath);
    await sendWhatsAppAlert(`🚨 *[DATABASE BACKUP FAILED]*\n\nDatabase: return-scan_youthnic\nError: ${err.message}\nLocal file kept: ${localFilePath}`);
    throw err;
  }

  // 3. Clean older backups in Drive
  await cleanOldDriveBackups(token, GDRIVE_FOLDER_ID);

  // 4. Remove local dump to preserve disk
  if (fs.existsSync(localFilePath)) {
    fs.unlinkSync(localFilePath);
    log('Local backup removed from VPS to preserve disk space.');
  }

  const folderName = folderCheck.data?.name || GDRIVE_FOLDER_ID;
  const successMsg = `✅ *[DATABASE BACKUP SUCCESS]*\n\n💾 *Database:* return-scan_youthnic\n📦 *Archive:* ${fileName} (${dumpRes.mb} MB gzipped)\n☁️ *Destination:* Google Drive ("${folderName}")\n🕒 *Timestamp:* ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST`;
  log(successMsg);
  await sendWhatsAppAlert(successMsg);

  log('================================================================');
  log('Backup & Google Drive Sync COMPLETED Successfully!');
  log('================================================================');
}

run().catch((err) => {
  errorLog('FATAL BACKUP FAILURE:', err.message);
  process.exit(1);
});
