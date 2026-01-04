// backend_process_material.js
// Full backend for processing study materials: CORS, HS256 JWT verify (Supabase Legacy JWT Secret),
// CloudConvert compression, Dropbox upload with DB-stored accounts + refresh, wake endpoint.
// ENV variables required (add to your .env / Render secrets):
// SUPABASE_URL, SUPABASE_SERVICE_ROLE, SUPABASE_JWT_SECRET,
// CLOUDCONVERT_API_KEY,
// DROPBOX_CLIENT_ID (optional if per-account app_key present),
// DROPBOX_CLIENT_SECRET (optional if per-account app_secret present),
// USE_DB_TOKENS=true (if using dropbox_accounts table),
// MAX_DROPBOX_ACCOUNT_BYTES_MB (optional quota per account)

require('dotenv').config();
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');
const FormData = require('form-data');
const { Dropbox } = require('dropbox');
const { jwtVerify } = require('jose');
const cors = require('cors');

const app = express();
app.use(express.json({ limit: '50mb' }));

// CORS - allow your frontend origin(s)
app.use(
  cors({
    origin: process.env.CORS_ORIGIN || 'http://localhost:8080',
    methods: ['GET', 'POST', 'DELETE', 'PUT', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: false,
  })
);

// Supabase client using service role (server-side only)
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE);

// ------------------------- Auth middleware (HS256, Supabase legacy JWT secret) -------------------------
async function verifyAdmin(req, res, next) {
  try {
    console.log('AUTH HEADER:', req.headers.authorization);
    const header = req.headers.authorization;
    if (!header) return res.status(401).json({ error: 'Missing Authorization header' });

    const token = header.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Missing token' });

    // Verify HS256-signed JWT using legacy secret
    const secret = process.env.SUPABASE_JWT_SECRET;
    if (!secret) return res.status(500).json({ error: 'Server misconfiguration: missing SUPABASE_JWT_SECRET' });

    const { payload } = await jwtVerify(token, new TextEncoder().encode(secret), { algorithms: ['HS256'] });

    console.log('JWT PAYLOAD:', payload);

    if (!payload.user_metadata || payload.user_metadata.isAdmin !== true) {
      console.log('ADMIN CHECK FAILED', payload.user_metadata);
      return res.status(403).json({ error: 'Not an admin' });
    }

    req.user = payload; // attach token payload for later use
    next();
  } catch (err) {
    console.error('JWT VERIFY ERROR:', err?.message || err);
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// ------------------------- Dropbox account management helpers -------------------------
async function selectDropboxAccount() {
  const maxBytesMB = Number(process.env.MAX_DROPBOX_ACCOUNT_BYTES_MB || 0);
  let query = supabase.from('dropbox_accounts').select('*');
  if (maxBytesMB > 0) query = query.lt('bytes_used', maxBytesMB);
  const { data, error } = await query.order('last_used', { ascending: true }).limit(1);
  if (error) throw new Error('Failed to select dropbox account: ' + error.message);
  if (!data || data.length === 0) throw new Error('No suitable Dropbox account found');
  return data[0];
}

async function testDropboxToken(accessToken) {
  try {
    const dbx = new Dropbox({ accessToken });
    await dbx.usersGetCurrentAccount();
    return true;
  } catch (err) {
    console.warn('Dropbox token test failed:', err?.message || err);
    return false;
  }
}

async function refreshDropboxAccessToken(refreshToken, clientId, clientSecret) {
  try {
    const params = new URLSearchParams();
    params.append('grant_type', 'refresh_token');
    params.append('refresh_token', refreshToken);
    const authHeader = 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

    const res = await axios.post('https://api.dropbox.com/oauth2/token', params, {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: authHeader,
      },
    });

    return res.data.access_token;
  } catch (err) {
    throw new Error('Failed to refresh Dropbox token: ' + (err?.response?.data?.error_description || err?.message || err));
  }
}

async function ensureAccessToken(accountRow) {
  let accessToken = accountRow.access_token;
  const refreshToken = accountRow.refresh_token;
  const clientId = accountRow.app_key || process.env.DROPBOX_CLIENT_ID;
  const clientSecret = accountRow.app_secret || process.env.DROPBOX_CLIENT_SECRET;

  if (accessToken && (await testDropboxToken(accessToken))) {
    // update last_used
    await supabase.from('dropbox_accounts').update({ last_used: new Date() }).eq('id', accountRow.id);
    return { accountRow, accessToken };
  }

  // access token invalid/expired -> try refresh
  if (!refreshToken) throw new Error('Dropbox access token invalid and no refresh token for account id=' + accountRow.id);
  if (!clientId || !clientSecret) throw new Error('Missing Dropbox client credentials for token refresh');

  const newAccessToken = await refreshDropboxAccessToken(refreshToken, clientId, clientSecret);

  const { error } = await supabase
    .from('dropbox_accounts')
    .update({ access_token: newAccessToken, last_used: new Date() })
    .eq('id', accountRow.id);

  if (error) throw new Error('Failed to update refreshed access token in DB: ' + error.message);

  return { accountRow: { ...accountRow, access_token: newAccessToken }, accessToken: newAccessToken };
}

async function getDropboxTokenFromDB() {
  const account = await selectDropboxAccount();
  const res = await ensureAccessToken(account);
  return { accessToken: res.accessToken, accountId: account.id };
}

async function incrementDropboxBytesUsed(accountId, uploadBytes) {
  try {
    const mb = Number((uploadBytes / (1024 * 1024)).toFixed(4));
    // try RPC first (atomic)
    const { error } = await supabase.rpc('increment_dropbox_bytes_used', { acc_id: accountId, add_mb: mb });
    if (error) {
      // fallback read-modify-write
      const { data } = await supabase.from('dropbox_accounts').select('bytes_used').eq('id', accountId).single();
      const current = Number((data?.bytes_used || 0));
      const newVal = current + mb;
      await supabase.from('dropbox_accounts').update({ bytes_used: newVal }).eq('id', accountId);
    }
  } catch (err) {
    console.warn('Failed to increment bytes_used:', err?.message || err);
  }
}

// SQL to create RPC (optional, run once in Supabase SQL editor):
/*
create or replace function increment_dropbox_bytes_used(acc_id uuid, add_mb numeric)
returns void as $$
begin
  update dropbox_accounts set bytes_used = coalesce(bytes_used,0) + add_mb where id = acc_id;
end;
$$ language plpgsql;
*/

// ------------------------- Supabase storage helper -------------------------
async function downloadFromSupabase(path) {
  const { data, error } = await supabase.storage.from('study-materials').download(path);
  if (error) throw error;
  const arrayBuffer = await data.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

// ------------------------- Wake endpoint -------------------------
app.get('/wake', async (req, res) => {
  try {
    // minimal query to wake the process and DB connection
    await supabase.from('study_materials').select('id').limit(1);
  } catch (err) {
    // ignore
  }
  res.json({ ok: true, awakeAt: new Date().toISOString() });
});

// ------------------------- Processing endpoint -------------------------
app.post('/process-material/:id', verifyAdmin, async (req, res) => {
  const { id } = req.params;
  console.log('🚀 PROCESS MATERIAL ROUTE HIT:', id);

  try {
    console.log('📌 STEP 1: Fetching material from DB…');
    const { data: material, error } = await supabase.from('study_materials').select('*').eq('id', id).single();
    console.log('🔍 MATERIAL QUERY RESULT:', { material, error });

    if (error || !material) {
      console.log('❌ MATERIAL NOT FOUND');
      return res.status(404).json({ error: 'Material not found' });
    }


    if (material.attempts >= 3) {
      console.log('❌ MAX RETRIES REACHED:', material.attempts);
      await supabase.from('study_materials').update({ processing_status: 'failed', processing_error: 'Max retries reached' }).eq('id', id);
      return res.status(400).json({ error: 'Max retries reached' });
    }

    // 3️⃣ Increment attempts and mark processing
    await supabase.from('study_materials').update({ attempts: (material.attempts || 0) + 1, processing_status: 'processing', processing_error: null }).eq('id', id);

    // 4️⃣ Download file from Supabase storage
    const pdfBuffer = await downloadFromSupabase(material.storage_path);

    // 5️⃣ Compress/convert file
    const compressedPDF = pdfBuffer;

    // 6️⃣ Pick Dropbox account & ensure token
    let accountId = null;
    const { accessToken: dropboxToken, accountId: chosenAccountId } = await getDropboxTokenFromDB();
    accountId = chosenAccountId;
    const dbx = new Dropbox({ accessToken: dropboxToken });

    const dropboxPath = `/campus-files/${Date.now()}_${material.storage_path.split('/').pop()}`;

    // 7️⃣ Upload to Dropbox
    let uploadResult;
    try {
      uploadResult = await dbx.filesUpload({ path: dropboxPath, contents: compressedPDF });
    } catch (err) {
      console.error('DROPBOX UPLOAD ERROR:', err?.message || err);
      // try refresh and retry once if it failed due to auth
      const accountRow = await supabase.from('dropbox_accounts').select('*').eq('id', accountId).single();
      if (accountRow.error || !accountRow.data) throw err; // rethrow
      const refreshed = await ensureAccessToken(accountRow.data);
      const dbx2 = new Dropbox({ accessToken: refreshed.accessToken });
      uploadResult = await dbx2.filesUpload({ path: dropboxPath, contents: compressedPDF });
      // note: ensureAccessToken already updated DB last_used and access_token
    }

    const sharedLinkRes = await dbx.sharingCreateSharedLinkWithSettings({ path: uploadResult.result.path_lower });
    const dropboxUrl = sharedLinkRes.result.url.replace('?dl=0', '?dl=1');

    // 8️⃣ Insert into file_records
    await supabase.from('file_records').insert({ material_id: id, dropbox_path: dropboxPath, dropbox_url: dropboxUrl, uploaded_at: new Date() });

    // increment bytes used (compressedPDF length)
    await incrementDropboxBytesUsed(accountId, compressedPDF.length);

    // 9️⃣ Update study_materials & delete Supabase file
    await supabase.from('study_materials').update({ processed_url: dropboxUrl, file_url: dropboxUrl, processing_status: 'done', approval_status: 'approved' }).eq('id', id);
    await supabase.storage.from('study-materials').remove([material.storage_path]);

    res.json({ message: 'Processing complete', dropboxUrl });
  } catch (err) {
    console.error('PROCESS ERROR:', err?.message || err);
    // update attempts & error
    try {
      await supabase.from('study_materials').update({ processing_status: 'failed', processing_error: err.message }).eq('id', id);
    } catch (uErr) {
      console.warn('Failed to update material with error:', uErr?.message || uErr);
    }
    res.status(500).json({ error: 'Processing failed', details: err?.message || String(err) });
  }
});

// ------------------------- Reject route (delete row + storage) -------------------------
app.post('/reject-material/:id', verifyAdmin, async (req, res) => {
  const { id } = req.params;
  const { reason } = req.body;

  try {
    const { data: material, error } = await supabase.from('study_materials').select('*').eq('id', id).single();
    if (error || !material) return res.status(404).json({ error: 'Material not found' });

    if (material.storage_path) {
      await supabase.storage.from('study-materials').remove([material.storage_path]);
    }

    await supabase.from('study_materials').delete().eq('id', id);

    if (reason) {
      await supabase.from('rejection_logs').insert({ material_id: id, reason, rejected_by: req.user.sub, rejected_at: new Date() });
    }

    return res.json({ message: 'Material rejected and deleted successfully' });
  } catch (err) {
    console.error('Reject error:', err?.message || err);
    return res.status(500).json({ error: 'Failed to reject material', details: err?.message || String(err) });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
