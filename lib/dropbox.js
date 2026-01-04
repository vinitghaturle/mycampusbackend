const axios = require("axios");
const { supabaseAdmin } = require("./supabase");

async function pickDropboxToken() {
  if (process.env.USE_DB_TOKENS === "true") {
    const { data, error } = await supabaseAdmin
      .from("dropbox_accounts")
      .select("id, access_token")
      .eq("active", true)
      .order("usage_count", { ascending: true })
      .limit(1)
      .maybeSingle();

    if (error) throw error;
    if (!data) throw new Error("No Dropbox accounts found in DB");

    return { token: data.access_token, accountId: data.id };
  }

  const token = process.env.DROPBOX_ACCESS_TOKEN;
  if (!token) throw new Error("Missing DROPBOX_ACCESS_TOKEN in .env");

  return { token, accountId: null };
}

async function uploadBufferToDropbox(token, buffer, dropboxPath) {
  await axios.post(
    "https://content.dropboxapi.com/2/files/upload",
    buffer,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/octet-stream",
        "Dropbox-API-Arg": JSON.stringify({
          path: dropboxPath.startsWith("/") ? dropboxPath : `/${dropboxPath}`,
          mode: "add",
          autorename: true,
          mute: false
        })
      }
    }
  );
}

async function createSharedLinkDirect(token, dropboxPath) {
  try {
    const r = await axios.post(
      "https://api.dropboxapi.com/2/sharing/create_shared_link_with_settings",
      { path: dropboxPath },
      { headers: { Authorization: `Bearer ${token}` } }
    );

    let url = r.data.url;
    return url.replace("www.dropbox.com", "dl.dropboxusercontent.com").replace("?dl=0", "");
  } catch (e) {
    const r = await axios.post(
      "https://api.dropboxapi.com/2/sharing/list_shared_links",
      { path: dropboxPath },
      { headers: { Authorization: `Bearer ${token}` } }
    );

    let url = r.data.links[0].url;
    return url.replace("www.dropbox.com", "dl.dropboxusercontent.com").replace("?dl=0", "");
  }
}

module.exports = {
  pickDropboxToken,
  uploadBufferToDropbox,
  createSharedLinkDirect
};
